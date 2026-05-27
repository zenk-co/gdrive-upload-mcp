import { describe, test, expect, beforeEach, vi } from "vitest";
import { handleUpload } from "../src/upload/handler";
import { signUploadJwt } from "../src/jwt";
import { uploadKey, tokenKey, type Env, type UploadRecord } from "../src/env";
import type { ChunkResult, InitArgs, ChunkArgs } from "../src/upload/session";
import { MemoryKV } from "./helpers/kv";

const SECRET = "test-jwt-secret";
const USER_ID = "user-chunked";
const UPLOAD_ID = "33333333-3333-3333-3333-333333333333";
const FILENAME = "big.bin";
const CONTENT_TYPE = "application/octet-stream";
const TOTAL = 1024;

interface StubCalls {
  init: InitArgs[];
  chunks: Omit<ChunkArgs, "body">[];
  chunkBodies: Uint8Array[];
}

function buildSessionNamespace(
  scriptedChunk: (call: { start: number; end: number; total: number }) => ChunkResult
): { ns: Env["UPLOAD_SESSION"]; calls: StubCalls } {
  const calls: StubCalls = { init: [], chunks: [], chunkBodies: [] };
  const stub = {
    async init(args: InitArgs) {
      calls.init.push(args);
      return { sessionUri: "https://drive.session/abc", currentOffset: 0 };
    },
    async receiveChunk(args: ChunkArgs): Promise<ChunkResult> {
      calls.chunks.push({
        start: args.start,
        end: args.end,
        total: args.total,
        accessToken: args.accessToken,
      });
      calls.chunkBodies.push(args.body);
      return scriptedChunk({ start: args.start, end: args.end, total: args.total });
    },
  };
  const ns = {
    idFromName: (_name: string) => ({ __id: _name }) as unknown,
    get: (_id: unknown) => stub,
  };
  return { ns: ns as unknown as Env["UPLOAD_SESSION"], calls };
}

function buildEnv(opts: {
  uploadKv: MemoryKV;
  tokenKv: MemoryKV;
  uploadSession: Env["UPLOAD_SESSION"];
}): Env {
  return {
    MCP_OBJECT: {} as unknown as Env["MCP_OBJECT"],
    UPLOAD_SESSION: opts.uploadSession,
    UPLOAD_KV: opts.uploadKv.asKV(),
    TOKEN_KV: opts.tokenKv.asKV(),
    OAUTH_KV: new MemoryKV().asKV(),
    JWT_SIGNING_KEY: SECRET,
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
    COOKIE_SECRET: "cookie",
    MAX_UPLOAD_BYTES: "1048576",
    GOOGLE_OAUTH_SCOPES: "drive.file",
    TOKEN_TTL_SECONDS: "900",
    WORKER_BASE_URL: "http://localhost:8787",
  };
}

async function makeJwt(overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signUploadJwt(
    {
      iss: "upload-mcp",
      aud: "upload-app",
      sub: USER_ID,
      uploadId: UPLOAD_ID,
      filename: FILENAME,
      maxSize: TOTAL,
      contentType: CONTENT_TYPE,
      iat: now,
      exp: now + 60,
      ...overrides,
    } as Parameters<typeof signUploadJwt>[0],
    SECRET
  );
}

async function seedPending(kv: MemoryKV, patch: Partial<UploadRecord> = {}): Promise<void> {
  const record: UploadRecord = {
    status: "pending",
    userId: USER_ID,
    filename: FILENAME,
    size: TOTAL,
    contentType: CONTENT_TYPE,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...patch,
  };
  await kv.put(uploadKey(UPLOAD_ID), JSON.stringify(record));
}

async function seedToken(kv: MemoryKV): Promise<void> {
  await kv.put(
    tokenKey(USER_ID),
    JSON.stringify({
      accessToken: "drive-token",
      refreshToken: "drive-refresh",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      scope: "drive.file",
    })
  );
}

function chunkRequest(
  body: Uint8Array,
  token: string,
  contentRange: string
): Request {
  return new Request(`http://localhost:8787/upload/${UPLOAD_ID}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": CONTENT_TYPE,
      "Content-Length": String(body.byteLength),
      "Content-Range": contentRange,
    },
    body: body as unknown as BodyInit,
  });
}

describe("chunked upload via Content-Range", () => {
  let uploadKv: MemoryKV;
  let tokenKv: MemoryKV;

  beforeEach(() => {
    uploadKv = new MemoryKV();
    tokenKv = new MemoryKV();
  });

  test("first chunk (start=0, partial) triggers init + receiveChunk and returns 308", async () => {
    const session = buildSessionNamespace(({ end }) => ({
      status: "incomplete",
      nextOffset: end + 1,
    }));
    const env = buildEnv({ uploadKv, tokenKv, uploadSession: session.ns });
    await seedPending(uploadKv);
    await seedToken(tokenKv);
    const token = await makeJwt();

    const body = new Uint8Array(512).fill(0xab);
    const req = chunkRequest(body, token, `bytes 0-511/${TOTAL}`);
    const res = await handleUpload(req, env, UPLOAD_ID);

    expect(res.status).toBe(308);
    expect(res.headers.get("Range")).toBe("bytes=0-511");
    expect(session.calls.init).toHaveLength(1);
    expect(session.calls.init[0]?.totalSize).toBe(TOTAL);
    expect(session.calls.chunks).toHaveLength(1);
    expect(session.calls.chunks[0]).toMatchObject({ start: 0, end: 511, total: TOTAL });
    expect(session.calls.chunkBodies[0]?.byteLength).toBe(512);
  });

  test("mid chunk (start > 0) skips init", async () => {
    const session = buildSessionNamespace(({ end }) => ({
      status: "incomplete",
      nextOffset: end + 1,
    }));
    const env = buildEnv({ uploadKv, tokenKv, uploadSession: session.ns });
    await seedPending(uploadKv);
    await seedToken(tokenKv);
    const token = await makeJwt();

    const body = new Uint8Array(256);
    const req = chunkRequest(body, token, `bytes 512-767/${TOTAL}`);
    const res = await handleUpload(req, env, UPLOAD_ID);

    expect(res.status).toBe(308);
    expect(session.calls.init).toHaveLength(0);
    expect(session.calls.chunks).toHaveLength(1);
    expect(session.calls.chunks[0]).toMatchObject({ start: 512, end: 767 });
  });

  test("final chunk returns 200 with file id", async () => {
    const session = buildSessionNamespace(() => ({
      status: "complete",
      file: {
        id: "drive-chunked-1",
        name: FILENAME,
        mimeType: CONTENT_TYPE,
        size: String(TOTAL),
      },
      actualSha256: "f".repeat(64),
    }));
    const env = buildEnv({ uploadKv, tokenKv, uploadSession: session.ns });
    await seedPending(uploadKv);
    await seedToken(tokenKv);
    const token = await makeJwt();

    const body = new Uint8Array(256);
    const req = chunkRequest(body, token, `bytes 768-1023/${TOTAL}`);
    const res = await handleUpload(req, env, UPLOAD_ID);

    expect(res.status).toBe(200);
    const json = (await res.json()) as { fileId: string; actualSize: number };
    expect(json.fileId).toBe("drive-chunked-1");
    expect(json.actualSize).toBe(TOTAL);
  });

  test("Content-Range total mismatch with JWT maxSize is rejected", async () => {
    const session = buildSessionNamespace(() => ({ status: "incomplete", nextOffset: 0 }));
    const env = buildEnv({ uploadKv, tokenKv, uploadSession: session.ns });
    await seedPending(uploadKv);
    await seedToken(tokenKv);
    const token = await makeJwt();

    const body = new Uint8Array(256);
    const req = chunkRequest(body, token, `bytes 0-255/9999`);
    const res = await handleUpload(req, env, UPLOAD_ID);
    expect(res.status).toBe(400);
    expect(session.calls.init).toHaveLength(0);
    expect(session.calls.chunks).toHaveLength(0);
  });

  test("Content-Range size != Content-Length is rejected", async () => {
    const session = buildSessionNamespace(() => ({ status: "incomplete", nextOffset: 0 }));
    const env = buildEnv({ uploadKv, tokenKv, uploadSession: session.ns });
    await seedPending(uploadKv);
    await seedToken(tokenKv);
    const token = await makeJwt();

    const body = new Uint8Array(100);
    const req = chunkRequest(body, token, `bytes 0-199/${TOTAL}`);
    const res = await handleUpload(req, env, UPLOAD_ID);
    expect(res.status).toBe(400);
  });

  test("full-range Content-Range falls back to single-shot (skips DO)", async () => {
    const session = buildSessionNamespace(() => ({ status: "incomplete", nextOffset: 0 }));
    const env = buildEnv({ uploadKv, tokenKv, uploadSession: session.ns });
    await seedPending(uploadKv);
    await seedToken(tokenKv);
    const token = await makeJwt();

    // single-shot calls real fetch (which would fail) — we expect the chunked DO path NOT to be taken
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    try {
      const body = new Uint8Array(TOTAL);
      const req = chunkRequest(body, token, `bytes 0-${TOTAL - 1}/${TOTAL}`);
      await handleUpload(req, env, UPLOAD_ID);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(session.calls.init).toHaveLength(0);
    expect(session.calls.chunks).toHaveLength(0);
  });

  test("offset mismatch error from DO propagates with status", async () => {
    const session = buildSessionNamespace(() => ({
      status: "error",
      httpStatus: 409,
      message: "offset mismatch",
    }));
    const env = buildEnv({ uploadKv, tokenKv, uploadSession: session.ns });
    await seedPending(uploadKv);
    await seedToken(tokenKv);
    const token = await makeJwt();

    const body = new Uint8Array(256);
    const req = chunkRequest(body, token, `bytes 512-767/${TOTAL}`);
    const res = await handleUpload(req, env, UPLOAD_ID);
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/offset/);
  });
});
