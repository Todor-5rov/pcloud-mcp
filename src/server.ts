import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  PCloudClient,
  PCloudError,
  summarizeContents,
  summarizeMetadata,
  type JsonMap
} from "./pcloud.js";

const TEXT_LIKE = /^(text\/|application\/(json|xml|javascript|x-javascript|toml|yaml|x-yaml|csv)|image\/svg)/i;

function asText(data: unknown): string {
  return typeof data === "string" ? data : JSON.stringify(data, null, 2);
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: asText(data) }] };
}

function fail(error: unknown) {
  const message =
    error instanceof PCloudError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function num(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function fileOrPath(args: { fileid?: number; path?: string }) {
  if (args.fileid === undefined && !args.path) {
    throw new Error("Provide fileid or path");
  }
  return { fileid: args.fileid, path: args.path };
}

function folderOrPath(args: { folderid?: number; path?: string }) {
  if (args.folderid === undefined && !args.path) {
    return { folderid: 0 };
  }
  return { folderid: args.folderid, path: args.path };
}

function looksText(contentType: string | undefined, name: string): boolean {
  if (contentType && TEXT_LIKE.test(contentType)) return true;
  return /\.(txt|md|json|csv|xml|yml|yaml|toml|js|ts|tsx|jsx|css|html|svg|log|ini|env|py|rb|go|rs|java|c|h|cpp|sh)$/i.test(
    name
  );
}

function findInTree(node: JsonMap, fileid: number): JsonMap | undefined {
  for (const entry of (Array.isArray(node.contents) ? node.contents : []) as JsonMap[]) {
    if (!entry.isfolder && Number(entry.fileid) === fileid) return entry;
    if (entry.isfolder) {
      const hit = findInTree(entry, fileid);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** Accepts a link code, a ...?code=XYZ URL, or a short link that redirects to one. */
async function publinkCode(link: string): Promise<string> {
  const trimmed = link.trim();
  if (!/^https?:\/\//i.test(trimmed)) return trimmed;
  const direct = new URL(trimmed).searchParams.get("code");
  if (direct) return direct;
  const res = await fetch(trimmed, { redirect: "follow" });
  const code = new URL(res.url).searchParams.get("code");
  if (!code) throw new Error("Could not find a pCloud link code in that URL");
  return code;
}

export function createPCloudMcpServer(
  getClient: () => Promise<PCloudClient>,
  readFileMaxBytes: number
): McpServer {
  const server = new McpServer(
    {
      name: "pcloud-mcp",
      version: "1.0.0",
      websiteUrl: "https://github.com/rghrb/pcloud-mcp"
    },
    { capabilities: { logging: {} } }
  );

  const run = async (fn: (client: PCloudClient) => Promise<unknown>) => {
    try {
      const client = await getClient();
      return ok(await fn(client));
    } catch (error) {
      return fail(error);
    }
  };

  server.registerTool(
    "list_folder",
    {
      title: "List folder",
      description:
        "List files and folders in pCloud. Root is folderid 0 or path /. Defaults to the account root. Folders other people shared with you (and you accepted) appear here too, marked shared_with_me.",
      inputSchema: {
        path: z.string().optional().describe("Folder path, e.g. /Documents"),
        folderid: z.number().int().optional().describe("Folder id. 0 is root."),
        recursive: z.boolean().optional().describe("Include the full tree. Default false.")
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async (args) =>
      run(async (client) => {
        const json = await client.call("listfolder", {
          ...folderOrPath(args),
          recursive: args.recursive ? 1 : undefined
        });
        const meta = (json.metadata || {}) as JsonMap;
        const listed = summarizeContents(meta.contents);
        return {
          folder: summarizeMetadata(meta),
          ...listed
        };
      })
  );

  server.registerTool(
    "get_metadata",
    {
      title: "Get metadata",
      description: "Get metadata for a file or folder by id or path.",
      inputSchema: {
        path: z.string().optional(),
        fileid: z.number().int().optional(),
        folderid: z.number().int().optional()
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async (args) =>
      run(async (client) => {
        const json = await client.call("stat", {
          path: args.path,
          fileid: args.fileid,
          folderid: args.folderid
        });
        return summarizeMetadata((json.metadata || json) as JsonMap);
      })
  );

  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description:
        "Read a pCloud file. Text is returned inline. Binary files return a short-lived download URL instead of raw bytes.",
      inputSchema: {
        path: z.string().optional(),
        fileid: z.number().int().optional(),
        max_bytes: z.number().int().positive().optional()
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async (args) =>
      run(async (client) => {
        const id = fileOrPath(args);
        const stat = await client.call("stat", id);
        const meta = summarizeMetadata((stat.metadata || stat) as JsonMap);
        const maxBytes = Math.min(args.max_bytes || readFileMaxBytes, 5_000_000);
        const size = Number(meta.size || 0);
        const name = String(meta.name || "");
        const contentType = String(meta.contenttype || "");
        if (!looksText(contentType, name) || size > maxBytes) {
          const link = await client.downloadLink(id);
          return {
            ...meta,
            note:
              size > maxBytes
                ? `File is ${size} bytes, over the inline limit of ${maxBytes}. Use the download URL.`
                : "Binary file. Use the download URL.",
            download_url: link.url,
            expires: link.expires
          };
        }
        const downloaded = await client.readBytes(id, maxBytes);
        return {
          ...meta,
          truncated: downloaded.truncated,
          content: downloaded.bytes.toString("utf8")
        };
      })
  );

  server.registerTool(
    "write_file",
    {
      title: "Write file",
      description:
        "Create or overwrite a file in pCloud. Provide UTF-8 text or base64 bytes. Parent folder is folderid (default 0) or folder_path.",
      inputSchema: {
        filename: z.string().min(1),
        content: z.string().describe("File contents"),
        encoding: z.enum(["utf8", "base64"]).optional(),
        folderid: z.number().int().optional(),
        folder_path: z.string().optional(),
        rename_if_exists: z.boolean().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
    },
    async (args) =>
      run(async (client) => {
        const encoding = args.encoding || "utf8";
        const body =
          encoding === "base64"
            ? Buffer.from(args.content, "base64")
            : Buffer.from(args.content, "utf8");
        if (body.length > 10_000_000) {
          throw new Error("Uploads are limited to 10 MB through this connector");
        }
        const json = await client.upload({
          filename: args.filename,
          body,
          folderid: args.folderid,
          path: args.folder_path,
          renameifexists: args.rename_if_exists
        });
        const meta = Array.isArray(json.metadata) ? json.metadata[0] : json.metadata;
        return summarizeMetadata((meta || {}) as JsonMap);
      })
  );

  server.registerTool(
    "get_download_link",
    {
      title: "Get download link",
      description: "Create a temporary (non-public) download URL for a file.",
      inputSchema: {
        path: z.string().optional(),
        fileid: z.number().int().optional()
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async (args) =>
      run(async (client) => client.downloadLink(fileOrPath(args)))
  );

  server.registerTool(
    "create_folder",
    {
      title: "Create folder",
      description: "Create a folder. Pass parent folderid (0 for root) plus name, or a full path.",
      inputSchema: {
        name: z.string().optional(),
        folderid: z.number().int().optional().describe("Parent folder id"),
        path: z.string().optional()
      },
      annotations: { readOnlyHint: false, openWorldHint: true }
    },
    async (args) =>
      run(async (client) => {
        const json = await client.call("createfolderifnotexists", {
          name: args.name,
          folderid: args.folderid,
          path: args.path
        });
        return summarizeMetadata((json.metadata || json) as JsonMap);
      })
  );

  server.registerTool(
    "delete_file",
    {
      title: "Delete file",
      description: "Move a file to pCloud trash.",
      inputSchema: {
        path: z.string().optional(),
        fileid: z.number().int().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
    },
    async (args) =>
      run(async (client) => {
        const json = await client.call("deletefile", fileOrPath(args));
        return { deleted: true, metadata: summarizeMetadata((json.metadata || {}) as JsonMap) };
      })
  );

  server.registerTool(
    "delete_folder",
    {
      title: "Delete folder",
      description: "Delete a folder. Set recursive true to delete contents too.",
      inputSchema: {
        path: z.string().optional(),
        folderid: z.number().int().optional(),
        recursive: z.boolean().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
    },
    async (args) =>
      run(async (client) => {
        const method = args.recursive ? "deletefolderrecursive" : "deletefolder";
        const json = await client.call(method, folderOrPath(args));
        return { deleted: true, result: json };
      })
  );

  server.registerTool(
    "rename",
    {
      title: "Rename",
      description: "Rename a file or folder in place. Use move to change parent folders.",
      inputSchema: {
        type: z.enum(["file", "folder"]),
        fileid: z.number().int().optional(),
        folderid: z.number().int().optional(),
        path: z.string().optional(),
        new_name: z.string().min(1)
      },
      annotations: { readOnlyHint: false, openWorldHint: true }
    },
    async (args) =>
      run(async (client) => {
        const method = args.type === "folder" ? "renamefolder" : "renamefile";
        const json = await client.call(method, {
          fileid: args.fileid,
          folderid: args.folderid,
          path: args.path,
          toname: args.new_name
        });
        return summarizeMetadata((json.metadata || json) as JsonMap);
      })
  );

  server.registerTool(
    "move",
    {
      title: "Move",
      description: "Move a file or folder to a destination path, e.g. /Documents/notes.txt",
      inputSchema: {
        type: z.enum(["file", "folder"]),
        fileid: z.number().int().optional(),
        folderid: z.number().int().optional(),
        path: z.string().optional(),
        topath: z.string().min(1)
      },
      annotations: { readOnlyHint: false, openWorldHint: true }
    },
    async (args) =>
      run(async (client) => {
        const method = args.type === "folder" ? "renamefolder" : "renamefile";
        const json = await client.call(method, {
          fileid: args.fileid,
          folderid: args.folderid,
          path: args.path,
          topath: args.topath
        });
        return summarizeMetadata((json.metadata || json) as JsonMap);
      })
  );

  server.registerTool(
    "copy_file",
    {
      title: "Copy file",
      description: "Copy a file into a destination folder.",
      inputSchema: {
        fileid: z.number().int().optional(),
        path: z.string().optional(),
        tofolderid: z.number().int().optional(),
        topath: z.string().optional()
      },
      annotations: { readOnlyHint: false, openWorldHint: true }
    },
    async (args) =>
      run(async (client) => {
        const json = await client.call("copyfile", {
          ...fileOrPath(args),
          tofolderid: args.tofolderid,
          topath: args.topath
        });
        return summarizeMetadata((json.metadata || json) as JsonMap);
      })
  );

  server.registerTool(
    "copy_folder",
    {
      title: "Copy folder",
      description: "Copy a folder into a destination folder.",
      inputSchema: {
        folderid: z.number().int().optional(),
        path: z.string().optional(),
        tofolderid: z.number().int().optional(),
        topath: z.string().optional()
      },
      annotations: { readOnlyHint: false, openWorldHint: true }
    },
    async (args) =>
      run(async (client) => {
        const json = await client.call("copyfolder", {
          ...folderOrPath(args),
          tofolderid: args.tofolderid,
          topath: args.topath
        });
        return json;
      })
  );

  server.registerTool(
    "search",
    {
      title: "Search",
      description:
        "Search file and folder names under a starting folder (default root). pCloud has no full-text search API, so this matches names only.",
      inputSchema: {
        query: z.string().min(1),
        path: z.string().optional(),
        folderid: z.number().int().optional(),
        max_results: z.number().int().positive().optional()
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async (args) =>
      run(async (client) => {
        const json = await client.call("listfolder", {
          ...folderOrPath(args),
          recursive: 1
        });
        const needle = args.query.toLowerCase();
        const limit = Math.min(args.max_results || 50, 200);
        const hits: JsonMap[] = [];
        const walk = (node: JsonMap) => {
          const contents = Array.isArray(node.contents) ? (node.contents as JsonMap[]) : [];
          for (const entry of contents) {
            if (String(entry.name || "").toLowerCase().includes(needle)) {
              hits.push(summarizeMetadata(entry));
              if (hits.length >= limit) return;
            }
            if (entry.isfolder) walk(entry);
            if (hits.length >= limit) return;
          }
        };
        walk((json.metadata || {}) as JsonMap);
        return { query: args.query, count: hits.length, items: hits };
      })
  );

  server.registerTool(
    "create_public_link",
    {
      title: "Create public link",
      description: "Create a public share link for a file or folder.",
      inputSchema: {
        type: z.enum(["file", "folder"]),
        fileid: z.number().int().optional(),
        folderid: z.number().int().optional(),
        path: z.string().optional()
      },
      annotations: { readOnlyHint: false, openWorldHint: true }
    },
    async (args) =>
      run(async (client) => {
        const method = args.type === "folder" ? "getfolderpublink" : "getfilepublink";
        const json = await client.call(method, {
          fileid: args.fileid,
          folderid: args.folderid,
          path: args.path
        });
        return {
          link: json.link,
          code: json.code,
          expires: json.expires
        };
      })
  );

  server.registerTool(
    "list_public_links",
    {
      title: "List public links",
      description: "List public links on the account.",
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async () =>
      run(async (client) => {
        const json = await client.call("listpublinks");
        return json;
      })
  );

  server.registerTool(
    "delete_public_link",
    {
      title: "Delete public link",
      description: "Delete a public link by its code.",
      inputSchema: {
        code: z.string().min(1)
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
    },
    async (args) =>
      run(async (client) => client.call("deletepublink", { code: args.code }))
  );

  server.registerTool(
    "list_shares",
    {
      title: "List shares",
      description:
        "List folder shares: invitations you received (pending requests and accepted shares) and the ones you sent. Accepted incoming shares are readable with list_folder/read_file like your own folders.",
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async () =>
      run(async (client) => {
        const json = await client.call("listshares");
        return { shares: json.shares, requests: json.requests };
      })
  );

  server.registerTool(
    "accept_share",
    {
      title: "Accept share",
      description:
        "Accept a pending folder share invitation (sharerequestid from list_shares). The folder then appears in your pCloud, by default in the root.",
      inputSchema: {
        sharerequestid: z.number().int(),
        name: z.string().optional().describe("Name for the shared folder in your pCloud"),
        folderid: z.number().int().optional().describe("Where to place it. Default root (0).")
      },
      annotations: { readOnlyHint: false, openWorldHint: true }
    },
    async (args) =>
      run(async (client) => {
        await client.call("acceptshare", {
          sharerequestid: args.sharerequestid,
          name: args.name,
          folderid: args.folderid
        });
        return { accepted: true, sharerequestid: args.sharerequestid };
      })
  );

  server.registerTool(
    "read_public_link",
    {
      title: "Read public link",
      description:
        "Open a pCloud public link someone sent you (full URL or its code). A folder link lists its contents; pass fileid to read one file inside it. Text is returned inline, other files as a download URL.",
      inputSchema: {
        link: z.string().min(1).describe("Public link URL or code"),
        fileid: z.number().int().optional().describe("File inside a folder link"),
        max_bytes: z.number().int().positive().optional()
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async (args) =>
      run(async (client) => {
        const code = await publinkCode(args.link);
        const { json: shown } = await client.callPublink("showpublink", { code });
        const root = (shown.metadata || {}) as JsonMap;
        if (root.isfolder && args.fileid === undefined) {
          const flat: JsonMap[] = [];
          const walk = (node: JsonMap, prefix: string) => {
            for (const entry of (Array.isArray(node.contents) ? node.contents : []) as JsonMap[]) {
              flat.push(summarizeMetadata(entry, { path: `${prefix}/${entry.name}` }));
              if (entry.isfolder) walk(entry, `${prefix}/${entry.name}`);
            }
          };
          walk(root, "");
          return {
            folder: summarizeMetadata(root),
            note: "Pass a fileid from this list to read that file.",
            items: flat.slice(0, 400),
            truncated: flat.length > 400
          };
        }
        const { json: dl } = await client.callPublink("getpublinkdownload", {
          code,
          fileid: args.fileid
        });
        const hosts = dl.hosts as string[] | undefined;
        if (!hosts?.length || !dl.path) throw new Error("pCloud did not return a download link");
        const url = `https://${hosts[0]}${dl.path}`;
        const meta = root.isfolder
          ? findInTree(root, args.fileid!) ?? { fileid: args.fileid }
          : root;
        const summary = summarizeMetadata(meta);
        const maxBytes = Math.min(args.max_bytes || readFileMaxBytes, 5_000_000);
        const size = Number(summary.size || 0);
        if (!looksText(String(summary.contenttype || ""), String(summary.name || "")) || size > maxBytes) {
          return { ...summary, note: "Use the download URL.", download_url: url, expires: dl.expires };
        }
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Download failed with HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        return {
          ...summary,
          truncated: buf.length > maxBytes,
          content: buf.subarray(0, maxBytes).toString("utf8")
        };
      })
  );

  server.registerTool(
    "get_account",
    {
      title: "Account info",
      description: "Show pCloud account email, quota, and used space.",
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async () =>
      run(async (client) => {
        const json = await client.call("userinfo");
        const quota = num(json.quota) || 0;
        const used = num(json.usedquota) || 0;
        return {
          email: json.email,
          userid: json.userid,
          plan: json.plan,
          quota_bytes: quota,
          used_bytes: used,
          used_percent: quota ? Math.round((used / quota) * 1000) / 10 : undefined,
          hostname: client.hostname
        };
      })
  );

  server.registerTool(
    "list_trash",
    {
      title: "List trash",
      description: "List items in pCloud trash.",
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async () =>
      run(async (client) => {
        const json = await client.call("trash_list");
        return json;
      })
  );

  server.registerTool(
    "restore_trash",
    {
      title: "Restore from trash",
      description: "Restore a file or folder from trash by id.",
      inputSchema: {
        fileid: z.number().int().optional(),
        folderid: z.number().int().optional()
      },
      annotations: { readOnlyHint: false, openWorldHint: true }
    },
    async (args) =>
      run(async (client) => {
        if (args.fileid === undefined && args.folderid === undefined) {
          throw new Error("Provide fileid or folderid");
        }
        return client.call("trash_restore", {
          fileid: args.fileid,
          folderid: args.folderid
        });
      })
  );

  return server;
}
