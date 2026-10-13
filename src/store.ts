import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface PCloudCreds {
  access_token: string;
  hostname: string;
  uid?: number;
  email?: string;
}

// State lives in JSON files under DATA_DIR, or — when SUPABASE_URL and
// SUPABASE_KEY are set — in one Supabase table, so serverless instances
// (Vercel) share it and it survives cold starts. Each file maps to one row
// keyed by its basename. Create the table with the SQL in the README.
const SUPABASE_TABLE = "pcloud_mcp_state";

function supabase(): { url: string; key: string } | undefined {
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const key = process.env.SUPABASE_KEY;
  return url && key ? { url, key } : undefined;
}

export function usingSupabase(): boolean {
  return Boolean(supabase());
}

function stateKey(path: string): string {
  return basename(path).replace(/\.json$/, "");
}

// Values are encrypted with KV_SECRET (AES-256-GCM) when it is set.
function cipherKey(): Buffer | undefined {
  const secret = process.env.KV_SECRET;
  return secret ? createHash("sha256").update(secret).digest() : undefined;
}

function seal(plain: string): string {
  const key = cipherKey();
  if (!key) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64")}`;
}

function unseal(stored: string): string {
  if (!stored.startsWith("v1:")) return stored;
  const key = cipherKey();
  if (!key) throw new Error("Stored state is encrypted but KV_SECRET is not set.");
  const raw = Buffer.from(stored.slice(3), "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

async function supabaseRequest(path: string, init: RequestInit): Promise<Response> {
  const { url, key } = supabase()!;
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...init.headers
    }
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Supabase ${init.method ?? "GET"} ${SUPABASE_TABLE} failed (${res.status}): ${detail}. ` +
        "SUPABASE_KEY must be the secret (service role) key."
    );
  }
  return res;
}

function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

export async function loadJson<T>(path: string, fallback: T): Promise<T> {
  if (supabase()) {
    const key = encodeURIComponent(stateKey(path));
    const res = await supabaseRequest(`${SUPABASE_TABLE}?key=eq.${key}&select=value`, {
      method: "GET"
    });
    const rows = (await res.json()) as { value: string }[];
    if (!rows[0]) return fallback;
    try {
      return JSON.parse(unseal(rows[0].value)) as T;
    } catch {
      return fallback;
    }
  }
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export async function saveJson(path: string, value: unknown): Promise<void> {
  if (supabase()) {
    await supabaseRequest(`${SUPABASE_TABLE}?on_conflict=key`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        key: stateKey(path),
        value: seal(JSON.stringify(value)),
        updated_at: new Date().toISOString()
      })
    });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function pcloudCredsPath(dataDir: string): string {
  return join(dataDir, "pcloud.json");
}

export function oauthStorePath(dataDir: string): string {
  return join(dataDir, "oauth.json");
}
