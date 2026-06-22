import { describe, test, expect, afterEach, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { registerDriveTools } from "../src/mcp/drive-tools";
import { DOWNLOAD_KV_PREFIX, tokenKey, type Env, type UserProps } from "../src/env";
import type { TransferDownloadRecord } from "mcp-upload-kit";
import { MemoryKV } from "./helpers/kv";

const USER_ID = "user-abc";

function buildEnv(uploadKv: MemoryKV, tokenKv: MemoryKV): Env {
  return {
    MCP_OBJECT: {} as unknown as Env["MCP_OBJECT"],
    UPLOAD_SESSION: {} as unknown as Env["UPLOAD_SESSION"],
    UPLOAD_KV: uploadKv.asKV(),
    TOKEN_KV: tokenKv.asKV(),
    OAUTH_KV: new MemoryKV().asKV(),
    JWT_SIGNING_KEY: "secret",
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
    COOKIE_SECRET: "cookie",
    MAX_UPLOAD_BYTES: "1048576",
    GOOGLE_OAUTH_SCOPES: "drive.file drive.readonly",
    TOKEN_TTL_SECONDS: "900",
    WORKER_BASE_URL: "http://localhost:8787",
  };
}

async function seedToken(kv: MemoryKV): Promise<void> {
  await kv.put(
    tokenKey(USER_ID),
    JSON.stringify({
      accessToken: "drive-access",
      refreshToken: "drive-refresh",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      scope: "drive.readonly",
    }),
  );
}

// Minimal MCP server stand-in: capture handlers and invoke them by name.
function fakeServer() {
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<CallToolResult>>();
  const server = {
    registerTool(name: string, _config: unknown, handler: (input: Record<string, unknown>) => Promise<CallToolResult>) {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  const call = (name: string, input: Record<string, unknown>) => {
    const h = handlers.get(name);
    if (!h) throw new Error(`tool not registered: ${name}`);
    return h(input);
  };
  return { server, call };
}

function register(uploadKv: MemoryKV, tokenKv: MemoryKV) {
  const { server, call } = fakeServer();
  const props: UserProps = { userId: USER_ID, email: "u@example.test" };
  registerDriveTools(server, buildEnv(uploadKv, tokenKv), () => props);
  return { call };
}

function mockDrive(handler: (url: string, method: string) => Response | null) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const res = handler(url, method);
    if (res) return res;
    return originalFetch(input as RequestInfo, init);
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

describe("registerDriveTools", () => {
  test("search_files returns matching files", async () => {
    const tokenKv = new MemoryKV();
    await seedToken(tokenKv);
    restore = mockDrive((url, method) => {
      if (url.startsWith("https://www.googleapis.com/drive/v3/files?") && method === "GET") {
        return jsonResponse({ files: [{ id: "f1", name: "a.pdf", mimeType: "application/pdf", size: "10" }] });
      }
      return null;
    });
    const { call } = register(new MemoryKV(), tokenKv);
    const res = await call("search_files", { query: "name contains 'a'" });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { files: unknown[] }).files).toHaveLength(1);
  });

  test("get_file_metadata returns metadata", async () => {
    const tokenKv = new MemoryKV();
    await seedToken(tokenKv);
    restore = mockDrive((url, method) => {
      if (url.startsWith("https://www.googleapis.com/drive/v3/files/f1?") && method === "GET") {
        return jsonResponse({ id: "f1", name: "a.pdf", mimeType: "application/pdf", size: "10" });
      }
      return null;
    });
    const { call } = register(new MemoryKV(), tokenKv);
    const res = await call("get_file_metadata", { fileId: "f1" });
    expect(res.structuredContent).toMatchObject({ id: "f1", name: "a.pdf" });
  });

  test("download_file issues a grant and stores a record without returning bytes", async () => {
    const uploadKv = new MemoryKV();
    const tokenKv = new MemoryKV();
    await seedToken(tokenKv);
    restore = mockDrive((url, method) => {
      if (url.startsWith("https://www.googleapis.com/drive/v3/files/f1?") && method === "GET") {
        return jsonResponse({ id: "f1", name: "a.pdf", mimeType: "application/pdf", size: "10" });
      }
      return null;
    });
    const { call } = register(uploadKv, tokenKv);
    const res = await call("download_file", { fileId: "f1" });
    const out = res.structuredContent as { downloadId: string; downloadUrl: string; downloadToken: string };

    expect(out.downloadUrl).toBe(`http://localhost:8787/download/${out.downloadId}`);
    expect(out.downloadToken).toBeTruthy();
    // No bytes in the tool result.
    expect(JSON.stringify(res)).not.toContain("application/pdf-bytes");

    const stored = JSON.parse(
      (await uploadKv.get(`${DOWNLOAD_KV_PREFIX}${out.downloadId}`))!,
    ) as TransferDownloadRecord<{ fileId: string }>;
    expect(stored).toMatchObject({ owner: USER_ID, token: out.downloadToken, metadata: { fileId: "f1" } });
  });

  test("download_file refuses Google-native files", async () => {
    const tokenKv = new MemoryKV();
    await seedToken(tokenKv);
    restore = mockDrive((url, method) => {
      if (url.startsWith("https://www.googleapis.com/drive/v3/files/doc1?") && method === "GET") {
        return jsonResponse({ id: "doc1", name: "Doc", mimeType: "application/vnd.google-apps.document" });
      }
      return null;
    });
    const { call } = register(new MemoryKV(), tokenKv);
    const res = await call("download_file", { fileId: "doc1" });
    expect(res.isError).toBe(true);
  });

  test("delete_file deletes and reports success", async () => {
    const tokenKv = new MemoryKV();
    await seedToken(tokenKv);
    let deleted = false;
    restore = mockDrive((url, method) => {
      if (url.startsWith("https://www.googleapis.com/drive/v3/files/f1") && method === "DELETE") {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      return null;
    });
    const { call } = register(new MemoryKV(), tokenKv);
    const res = await call("delete_file", { fileId: "f1" });
    expect(deleted).toBe(true);
    expect(res.structuredContent).toMatchObject({ deleted: true, fileId: "f1" });
  });

  test("tools surface an auth error when the user is not authenticated", async () => {
    const { server, call } = fakeServer();
    registerDriveTools(server, buildEnv(new MemoryKV(), new MemoryKV()), () => undefined);
    const res = await call("search_files", {});
    expect(res.isError).toBe(true);
  });
});
