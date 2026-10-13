import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import type {
  OAuthRegisteredClientsStore
} from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  AuthorizationParams,
  OAuthServerProvider
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { consentPage } from "./pages.js";
import { exchangePCloudCode, hostnameFromLocation } from "./pcloud.js";
import { loadJson, oauthStorePath, saveJson, type PCloudCreds } from "./store.js";

const ACCESS_TTL_SEC = 7 * 24 * 60 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;

interface StoredCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  pcloud?: PCloudCreds;
  expiresAt: number;
}

interface StoredToken {
  clientId: string;
  scopes: string[];
  resource?: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  pcloud?: PCloudCreds;
}

// Per-user mode: each person signs in to their own pCloud account during the
// connector's OAuth flow, and their token is bound to the MCP tokens issued.
export interface PCloudLogin {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

interface PendingAuth {
  client: OAuthClientInformationFull;
  params: {
    state?: string;
    scopes?: string[];
    codeChallenge: string;
    redirectUri: string;
    resource?: string;
  };
  expiresAt: number;
}

interface OAuthDisk {
  clients: Record<string, OAuthClientInformationFull>;
  codes: Record<string, StoredCode>;
  tokens: Record<string, StoredToken>;
  pending: Record<string, PendingAuth>;
}

function now(): number {
  return Date.now();
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    if (left.length) timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

function prune(data: OAuthDisk): void {
  const t = now();
  for (const [id, code] of Object.entries(data.codes)) {
    if (code.expiresAt < t) delete data.codes[id];
  }
  for (const [id, pending] of Object.entries(data.pending)) {
    if (pending.expiresAt < t) delete data.pending[id];
  }
  for (const [id, token] of Object.entries(data.tokens)) {
    if (token.refreshExpiresAt < t) delete data.tokens[id];
  }
}

export class FileOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private data: OAuthDisk = { clients: {}, codes: {}, tokens: {}, pending: {} };
  private loaded = false;

  constructor(
    private readonly path: string,
    private readonly connectorPassword: string,
    private readonly pcloudLogin?: PCloudLogin
  ) {
    const self = this;
    this.clientsStore = {
      async getClient(clientId: string) {
        await self.ensureLoaded();
        return self.data.clients[clientId];
      },
      async registerClient(client) {
        await self.ensureLoaded();
        const incoming = client as OAuthClientInformationFull;
        const full: OAuthClientInformationFull = {
          ...incoming,
          client_id: incoming.client_id || randomUUID(),
          client_id_issued_at: incoming.client_id_issued_at ?? Math.floor(Date.now() / 1000)
        };
        self.data.clients[full.client_id] = full;
        await self.persist();
        return full;
      }
    };
  }

  private async ensureLoaded(): Promise<void> {
    // Always reload: on serverless, several instances may share one store.
    this.data = await loadJson<OAuthDisk>(this.path, {
      clients: {},
      codes: {},
      tokens: {},
      pending: {}
    });
    prune(this.data);
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    prune(this.data);
    await saveJson(this.path, this.data);
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    await this.ensureLoaded();
    const pendingId = randomUUID();
    this.data.pending[pendingId] = {
      client,
      params: {
        state: params.state,
        scopes: params.scopes,
        codeChallenge: params.codeChallenge,
        redirectUri: params.redirectUri,
        resource: params.resource?.toString()
      },
      expiresAt: now() + CODE_TTL_MS
    };
    await this.persist();
    if (this.pcloudLogin) {
      const url = new URL("https://my.pcloud.com/oauth2/authorize");
      url.searchParams.set("client_id", this.pcloudLogin.clientId);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("redirect_uri", this.pcloudLogin.redirectUri);
      url.searchParams.set("state", pendingId);
      res.redirect(303, url.toString());
      return;
    }
    res.redirect(303, `/oauth/consent?pending=${encodeURIComponent(pendingId)}`);
  }

  /** True when `state` from a pCloud redirect belongs to a pending connector sign-in. */
  async isPendingLogin(state: string): Promise<boolean> {
    if (!this.pcloudLogin || !state) return false;
    await this.ensureLoaded();
    return Boolean(this.data.pending[state]);
  }

  /** pCloud redirected back with a code: bind that account to a new MCP code. */
  async completePCloudLogin(req: Request, res: Response): Promise<void> {
    await this.ensureLoaded();
    const pendingId = String(req.query.state || "");
    const pending = this.data.pending[pendingId];
    const code = String(req.query.code || "");
    if (!this.pcloudLogin || !pending || pending.expiresAt < now() || !code) {
      res.status(400).send(
        consentPage({
          pendingId: "",
          clientName: "Unknown client",
          error: "This sign-in expired or pCloud did not return a code. Start connecting again."
        })
      );
      return;
    }
    let pcloud: PCloudCreds;
    try {
      pcloud = await exchangePCloudCode({
        clientId: this.pcloudLogin.clientId,
        clientSecret: this.pcloudLogin.clientSecret,
        code,
        hostname: hostnameFromLocation(
          String(req.query.locationid || ""),
          String(req.query.hostname || "")
        )
      });
    } catch (error) {
      res.status(400).send(
        consentPage({
          pendingId: "",
          clientName: pending.client.client_name || pending.client.client_id,
          error: `pCloud sign-in failed: ${error instanceof Error ? error.message : "unknown error"}`
        })
      );
      return;
    }
    const redirect = this.finishAuthorization(pendingId, pending, pcloud);
    await this.persist();
    res.redirect(303, redirect);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    await this.ensureLoaded();
    const code = this.data.codes[authorizationCode];
    if (!code || code.clientId !== client.client_id || code.expiresAt < now()) {
      throw new Error("Invalid authorization code");
    }
    return code.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string
  ): Promise<OAuthTokens> {
    await this.ensureLoaded();
    const code = this.data.codes[authorizationCode];
    if (!code || code.clientId !== client.client_id || code.expiresAt < now()) {
      throw new Error("Invalid authorization code");
    }
    if (redirectUri && redirectUri !== code.redirectUri) {
      throw new Error("redirect_uri mismatch");
    }
    delete this.data.codes[authorizationCode];
    return this.issueTokens(client.client_id, code.scopes, code.resource, code.pcloud);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[]
  ): Promise<OAuthTokens> {
    await this.ensureLoaded();
    const existing = Object.values(this.data.tokens).find(
      (token) => token.refreshToken === refreshToken && token.clientId === client.client_id
    );
    if (!existing || existing.refreshExpiresAt < now()) {
      throw new Error("Invalid refresh token");
    }
    for (const [id, token] of Object.entries(this.data.tokens)) {
      if (token.refreshToken === refreshToken) delete this.data.tokens[id];
    }
    const nextScopes = scopes?.length ? scopes : existing.scopes;
    return this.issueTokens(client.client_id, nextScopes, existing.resource, existing.pcloud);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    await this.ensureLoaded();
    const found = Object.values(this.data.tokens).find((row) => row.accessToken === token);
    if (!found || found.accessExpiresAt < now()) {
      throw new Error("Invalid or expired token");
    }
    // Tokens from the shared-password flow carry no pCloud account; in
    // per-user mode reject them so the client signs in again with pCloud.
    if (this.pcloudLogin && !found.pcloud) {
      throw new Error("Sign in with pCloud again");
    }
    return {
      token,
      clientId: found.clientId,
      scopes: found.scopes,
      expiresAt: Math.floor(found.accessExpiresAt / 1000),
      resource: found.resource ? new URL(found.resource) : undefined,
      extra: found.pcloud ? { pcloud: found.pcloud } : undefined
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    await this.ensureLoaded();
    for (const [id, token] of Object.entries(this.data.tokens)) {
      if (token.clientId !== client.client_id) continue;
      if (token.accessToken === request.token || token.refreshToken === request.token) {
        delete this.data.tokens[id];
      }
    }
    await this.persist();
  }

  async renderConsent(req: Request, res: Response): Promise<void> {
    await this.ensureLoaded();
    const pendingId = String(req.query.pending || "");
    const pending = this.data.pending[pendingId];
    if (!pending || pending.expiresAt < now()) {
      res.status(400).send(consentPage({
        pendingId: "",
        clientName: "Unknown client",
        error: "This authorization request expired. Start the connect flow again from Grok."
      }));
      return;
    }
    res.send(
      consentPage({
        pendingId,
        clientName: pending.client.client_name || pending.client.client_id
      })
    );
  }

  async handleConsent(req: Request, res: Response): Promise<void> {
    await this.ensureLoaded();
    const pendingId = String(req.body?.pending || "");
    const password = String(req.body?.password || "");
    const pending = this.data.pending[pendingId];
    if (!pending || pending.expiresAt < now()) {
      res.status(400).send(
        consentPage({
          pendingId,
          clientName: "Unknown client",
          error: "This authorization request expired. Start the connect flow again from Grok."
        })
      );
      return;
    }
    if (this.pcloudLogin || !safeEqual(password, this.connectorPassword)) {
      res.status(401).send(
        consentPage({
          pendingId,
          clientName: pending.client.client_name || pending.client.client_id,
          error: "Wrong connector password."
        })
      );
      return;
    }

    const redirect = this.finishAuthorization(pendingId, pending);
    await this.persist();
    // Explicit 303: Vercel's res.redirect defaults to 307, which makes the
    // browser re-POST this form to the client's callback (405 at Claude).
    res.redirect(303, redirect);
  }

  /** Issues the authorization code and returns the client's callback URL. */
  private finishAuthorization(
    pendingId: string,
    pending: PendingAuth,
    pcloud?: PCloudCreds
  ): string {
    const code = randomBytes(24).toString("base64url");
    this.data.codes[code] = {
      clientId: pending.client.client_id,
      redirectUri: pending.params.redirectUri,
      codeChallenge: pending.params.codeChallenge,
      scopes: pending.params.scopes?.length ? pending.params.scopes : ["mcp:tools"],
      resource: pending.params.resource,
      pcloud,
      expiresAt: now() + CODE_TTL_MS
    };
    delete this.data.pending[pendingId];
    const redirect = new URL(pending.params.redirectUri);
    redirect.searchParams.set("code", code);
    if (pending.params.state) redirect.searchParams.set("state", pending.params.state);
    return redirect.toString();
  }

  private async issueTokens(
    clientId: string,
    scopes: string[],
    resource?: string,
    pcloud?: PCloudCreds
  ): Promise<OAuthTokens> {
    const accessToken = randomBytes(32).toString("base64url");
    const refreshToken = randomBytes(32).toString("base64url");
    const id = randomUUID();
    this.data.tokens[id] = {
      clientId,
      scopes,
      resource,
      accessToken,
      refreshToken,
      accessExpiresAt: now() + ACCESS_TTL_SEC * 1000,
      refreshExpiresAt: now() + REFRESH_TTL_MS,
      pcloud
    };
    await this.persist();
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: ACCESS_TTL_SEC,
      refresh_token: refreshToken,
      scope: scopes.join(" ")
    };
  }
}

export function createOAuthProvider(
  dataDir: string,
  connectorPassword: string,
  pcloudLogin?: PCloudLogin
): FileOAuthProvider {
  return new FileOAuthProvider(oauthStorePath(dataDir), connectorPassword, pcloudLogin);
}
