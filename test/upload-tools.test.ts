import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { registerUploadTools } from "../src/mcp/tools";
import { tokenKey, uploadKey, type Env, type UploadRecord, type UserProps } from "../src/env";
import { MemoryKV } from "./helpers/kv";

const USER_ID = "user-abc";
const FOLDER_ID = "folder-123";

function buildEnv(uploadKv: MemoryKV, tokenKv: MemoryKV, records: UploadRecord[]): Env {
  const stub = {
    async setRecord(r: UploadRecord) {
      records.push(r);
    },
  };
  return {
    MCP_OBJECT: {} as unknown as Env["MCP_OBJECT"],
    UPLOAD_SESSION: {
      idFromName: (name: string) => name,
      get: () => stub,
    } as unknown as Env["UPLOAD_SESSION"],
    UPLOAD_KV: uploadKv.asKV(),
    TOKEN_KV: tokenKv.asKV(),
    OAUTH_KV: new MemoryKV().asKV(),
    JWT_SIGNING_KEY: "test-jwt-secret-of-sufficient-length",
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
    COOKIE_SECRET: "cookie",
    MAX_UPLOAD_BYTES: "1048576",
    GOOGLE_OAUTH_SCOPES: "drive.file drive.readonly",
    TOKEN_TTL_SECONDS: "900",
    WORKER_BASE_URL: "http://localhost:8787",
  };
}

function fakeServer() {
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<CallToolResult>>();
  const server = {
    registerTool(name: string, _config: unknown, handler: (input: Record<string, unknown>) => Promise<CallToolResult>) {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  const call = (name: string, input: Record<string, unknown>) => handlers.get(name)!(input);
  return { server, call };
}

const baseInput = { filename: "a.txt", size: 10, contentType: "text/plain" };

describe("prepare_upload parentFolderId validation", () => {
  let uploadKv: MemoryKV;
  let records: UploadRecord[];
  let call: (name: string, input: Record<string, unknown>) => Promise<CallToolResult>;
  let driveCalls: string[];
  let folderResponse: () => Response;
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    uploadKv = new MemoryKV();
    const tokenKv = new MemoryKV();
    await tokenKv.put(
      tokenKey(USER_ID),
      JSON.stringify({
        accessToken: "drive-access",
        refreshToken: "drive-refresh",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        scope: "drive.file",
      }),
    );
    records = [];
    const fake = fakeServer();
    const props: UserProps = { userId: USER_ID, email: "u@example.test" };
    registerUploadTools(fake.server, buildEnv(uploadKv, tokenKv, records), () => props);
    call = fake.call;

    driveCalls = [];
    folderResponse = () =>
      Response.json({ mimeType: "application/vnd.google-apps.folder", capabilities: { canAddChildren: true } });
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      driveCalls.push(url);
      if (url.startsWith(`https://www.googleapis.com/drive/v3/files/${FOLDER_ID}?`)) return folderResponse();
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("without parentFolderId no Drive lookup happens", async () => {
    const res = await call("prepare_upload", baseInput);
    expect(res.isError).toBeFalsy();
    expect(driveCalls).toEqual([]);
  });

  test("accepts a folder the user can add files to", async () => {
    const res = await call("prepare_upload", { ...baseInput, parentFolderId: FOLDER_ID });
    expect(res.isError).toBeFalsy();
    expect(driveCalls).toHaveLength(1);
    expect(driveCalls[0]).toContain("capabilities%2FcanAddChildren");
    const { uploadId } = res.structuredContent as { uploadId: string };
    const stored = JSON.parse((await uploadKv.get(uploadKey(uploadId))) as string) as UploadRecord;
    expect(stored.parentFolderId).toBe(FOLDER_ID);
  });

  test("rejects an id that is not a folder", async () => {
    folderResponse = () => Response.json({ mimeType: "text/plain", capabilities: { canAddChildren: false } });
    const res = await call("prepare_upload", { ...baseInput, parentFolderId: FOLDER_ID });
    expect(res.isError).toBe(true);
    expect(uploadKv.list()).toEqual([]);
    expect(records).toEqual([]);
  });

  test("rejects a folder the user cannot add files to", async () => {
    folderResponse = () =>
      Response.json({ mimeType: "application/vnd.google-apps.folder", capabilities: { canAddChildren: false } });
    const res = await call("prepare_upload", { ...baseInput, parentFolderId: FOLDER_ID });
    expect(res.isError).toBe(true);
    expect(uploadKv.list()).toEqual([]);
  });

  test("rejects a folder that is not visible", async () => {
    folderResponse = () => new Response("not found", { status: 404 });
    const res = await call("prepare_upload", { ...baseInput, parentFolderId: FOLDER_ID });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain("not found");
  });
});
