import { describe, test, expect, afterEach, vi } from "vitest";
import { handleDownload } from "../src/download/handler";
import { downloads } from "../src/download/controller";
import { tokenKey, type Env } from "../src/env";
import { MemoryKV } from "./helpers/kv";

const USER_ID = "user-abc";
const FILE_ID = "drive-file-1";
const FILE_BYTES = new TextEncoder().encode("hello drive");

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

async function issueGrant(env: Env) {
  return downloads(env).prepare({
    owner: USER_ID,
    name: "hello.txt",
    contentType: "text/plain",
    size: FILE_BYTES.byteLength,
    metadata: { fileId: FILE_ID },
  });
}

function getRequest(token: string | null, method = "GET"): Request {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request("http://localhost:8787/download/x", { method, headers });
}

function mockDriveDownload(status = 200) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/drive/v3/files/") && url.includes("alt=media")) {
      if (status >= 400) return new Response("drive error", { status });
      return new Response(FILE_BYTES, { status });
    }
    return originalFetch(input as RequestInfo);
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

describe("handleDownload", () => {
  test("streams the file bytes for a valid grant", async () => {
    const tokenKv = new MemoryKV();
    await seedToken(tokenKv);
    const env = buildEnv(new MemoryKV(), tokenKv);
    const grant = await issueGrant(env);
    restore = mockDriveDownload();

    const res = await handleDownload(getRequest(grant.downloadToken), env, grant.downloadId);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain");
    expect(res.headers.get("Content-Disposition")).toContain("hello.txt");
    expect(new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()))).toBe("hello drive");
  });

  test("rejects an invalid token", async () => {
    const env = buildEnv(new MemoryKV(), new MemoryKV());
    const grant = await issueGrant(env);
    const res = await handleDownload(getRequest("wrong"), env, grant.downloadId);
    expect(res.status).toBe(401);
  });

  test("rejects a missing bearer token", async () => {
    const env = buildEnv(new MemoryKV(), new MemoryKV());
    const grant = await issueGrant(env);
    const res = await handleDownload(getRequest(null), env, grant.downloadId);
    expect(res.status).toBe(401);
  });

  test("returns 404 for an unknown download id", async () => {
    const env = buildEnv(new MemoryKV(), new MemoryKV());
    const res = await handleDownload(getRequest("any"), env, "00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  test("rejects non-GET methods", async () => {
    const env = buildEnv(new MemoryKV(), new MemoryKV());
    const grant = await issueGrant(env);
    const res = await handleDownload(getRequest(grant.downloadToken, "POST"), env, grant.downloadId);
    expect(res.status).toBe(405);
  });

  test("returns 502 when Drive download fails", async () => {
    const tokenKv = new MemoryKV();
    await seedToken(tokenKv);
    const env = buildEnv(new MemoryKV(), tokenKv);
    const grant = await issueGrant(env);
    restore = mockDriveDownload(403);
    const res = await handleDownload(getRequest(grant.downloadToken), env, grant.downloadId);
    expect(res.status).toBe(502);
  });
});
