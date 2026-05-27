import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { handleUpload } from "../src/upload/handler";
import { signUploadJwt } from "../src/jwt";
import { uploadKey, tokenKey, type Env, type UploadRecord } from "../src/env";
import { MemoryKV } from "./helpers/kv";

const SECRET = "test-jwt-secret-of-sufficient-length";
const USER_ID = "user-abc";
const UPLOAD_ID = "11111111-1111-1111-1111-111111111111";
const FILENAME = "hello.bin";
const CONTENT_TYPE = "application/octet-stream";

const encoder = new TextEncoder();

function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function buildEnv(opts: { uploadKv: MemoryKV; tokenKv: MemoryKV }): Env {
  return {
    MCP_OBJECT: {} as unknown as Env["MCP_OBJECT"],
    UPLOAD_SESSION: {} as unknown as Env["UPLOAD_SESSION"],
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
      maxSize: 1024,
      contentType: CONTENT_TYPE,
      iat: now,
      exp: now + 60,
      ...overrides,
    } as Parameters<typeof signUploadJwt>[0],
    SECRET
  );
}

async function seedPendingRecord(
  kv: MemoryKV,
  patch: Partial<UploadRecord> = {}
): Promise<void> {
  const record: UploadRecord = {
    status: "pending",
    userId: USER_ID,
    filename: FILENAME,
    size: 1024,
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

function buildPutRequest(body: Uint8Array, token: string, uploadId = UPLOAD_ID): Request {
  return new Request(`http://localhost:8787/upload/${uploadId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": CONTENT_TYPE,
      "Content-Length": String(body.byteLength),
    },
    body: body as unknown as BodyInit,
  });
}

function mockDriveFetch(
  driveResponse: { id: string; name: string; mimeType: string; size: string },
  opts: { initStatus?: number; putStatus?: number } = {}
): {
  driveCalls: { url: string; method: string; receivedBody?: Uint8Array }[];
  restore: () => void;
} {
  const driveCalls: { url: string; method: string; receivedBody?: Uint8Array }[] = [];
  const SESSION_URI = "https://upload.googleapis.com/session/abc";

  const originalFetch = globalThis.fetch;
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const call: { url: string; method: string; receivedBody?: Uint8Array } = { url, method };

    if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files") && method === "POST") {
      driveCalls.push(call);
      return new Response(null, {
        status: opts.initStatus ?? 200,
        headers: { Location: SESSION_URI },
      });
    }
    if (url === SESSION_URI && method === "PUT") {
      const body = init?.body;
      if (body && typeof (body as ReadableStream).getReader === "function") {
        const reader = (body as ReadableStream<Uint8Array>).getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value);
        }
        call.receivedBody = new Uint8Array(
          Buffer.concat(chunks.map((c) => Buffer.from(c)))
        );
      }
      driveCalls.push(call);
      const status = opts.putStatus ?? 200;
      if (status >= 400) return new Response("drive error", { status });
      return new Response(JSON.stringify(driveResponse), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === SESSION_URI && method === "DELETE") {
      driveCalls.push(call);
      return new Response(null, { status: 200 });
    }
    if (url.startsWith("https://www.googleapis.com/drive/v3/files/") && method === "DELETE") {
      driveCalls.push(call);
      return new Response(null, { status: 204 });
    }
    return originalFetch(input as RequestInfo, init);
  });
  globalThis.fetch = mock as unknown as typeof fetch;

  return {
    driveCalls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

describe("handleUpload", () => {
  let uploadKv: MemoryKV;
  let tokenKv: MemoryKV;
  let env: Env;
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    uploadKv = new MemoryKV();
    tokenKv = new MemoryKV();
    env = buildEnv({ uploadKv, tokenKv });
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
  });

  test("happy path: streams body to Drive and updates KV", async () => {
    const body = encoder.encode("hello world");
    const expectedSha = toHex(sha256(body));

    const mock = mockDriveFetch({
      id: "drive-file-1",
      name: FILENAME,
      mimeType: CONTENT_TYPE,
      size: String(body.byteLength),
    });
    restoreFetch = mock.restore;

    await seedPendingRecord(uploadKv, { size: body.byteLength });
    await seedToken(tokenKv);
    const token = await makeJwt({ maxSize: body.byteLength });
    const req = buildPutRequest(body, token);

    const res = await handleUpload(req, env, UPLOAD_ID);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { fileId: string; actualSha256: string; actualSize: number };
    expect(json.fileId).toBe("drive-file-1");
    expect(json.actualSha256).toBe(expectedSha);
    expect(json.actualSize).toBe(body.byteLength);

    const stored = JSON.parse((await uploadKv.get(uploadKey(UPLOAD_ID)))!) as UploadRecord;
    expect(stored.status).toBe("completed");
    expect(stored.driveFileId).toBe("drive-file-1");
    expect(stored.actualSha256).toBe(expectedSha);

    const putCall = mock.driveCalls.find((c) => c.method === "PUT");
    expect(putCall?.receivedBody).toBeDefined();
    expect(Buffer.from(putCall!.receivedBody!).equals(Buffer.from(body))).toBe(true);
  });

  test("rejects missing Authorization", async () => {
    await seedPendingRecord(uploadKv);
    const req = new Request(`http://localhost:8787/upload/${UPLOAD_ID}`, {
      method: "PUT",
      headers: { "Content-Length": "10", "Content-Type": CONTENT_TYPE },
      body: encoder.encode("hello-data"),
    });
    const res = await handleUpload(req, env, UPLOAD_ID);
    expect(res.status).toBe(401);
  });

  test("rejects mismatched uploadId path vs JWT", async () => {
    await seedPendingRecord(uploadKv);
    const token = await makeJwt();
    const otherId = "22222222-2222-2222-2222-222222222222";
    const req = buildPutRequest(encoder.encode("x"), token, otherId);
    const res = await handleUpload(req, env, otherId);
    expect(res.status).toBe(401);
  });

  test("rejects when KV record missing", async () => {
    const token = await makeJwt();
    const req = buildPutRequest(encoder.encode("x"), token);
    const res = await handleUpload(req, env, UPLOAD_ID);
    expect(res.status).toBe(404);
  });

  test("rejects when record is not pending", async () => {
    await seedPendingRecord(uploadKv, { status: "completed" });
    const token = await makeJwt();
    const req = buildPutRequest(encoder.encode("x"), token);
    const res = await handleUpload(req, env, UPLOAD_ID);
    expect(res.status).toBe(409);
  });

  test("rejects when JWT sub does not match record userId", async () => {
    await seedPendingRecord(uploadKv, { userId: "different-user" });
    const token = await makeJwt();
    const req = buildPutRequest(encoder.encode("x"), token);
    const res = await handleUpload(req, env, UPLOAD_ID);
    expect(res.status).toBe(403);
  });

  test("rejects body larger than declared maxSize via header", async () => {
    await seedPendingRecord(uploadKv);
    const body = encoder.encode("oversize-data-larger-than-maxsize");
    const token = await makeJwt({ maxSize: 5 });
    const req = buildPutRequest(body, token);
    const res = await handleUpload(req, env, UPLOAD_ID);
    expect(res.status).toBe(413);
  });

  test("rejects when computed sha256 disagrees with pre-bound sha256, and deletes drive file", async () => {
    const body = encoder.encode("real-content");
    const claimedSha = "f".repeat(64);

    const mock = mockDriveFetch({
      id: "drive-file-bad",
      name: FILENAME,
      mimeType: CONTENT_TYPE,
      size: String(body.byteLength),
    });
    restoreFetch = mock.restore;

    await seedPendingRecord(uploadKv, { size: body.byteLength, sha256: claimedSha });
    await seedToken(tokenKv);
    const token = await makeJwt({ maxSize: body.byteLength, sha256: claimedSha });
    const req = buildPutRequest(body, token);

    const res = await handleUpload(req, env, UPLOAD_ID);
    expect(res.status).toBe(409);

    const deleteCall = mock.driveCalls.find(
      (c) => c.method === "DELETE" && c.url.includes("/drive/v3/files/drive-file-bad")
    );
    expect(deleteCall).toBeDefined();

    const stored = JSON.parse((await uploadKv.get(uploadKey(UPLOAD_ID)))!) as UploadRecord;
    expect(stored.status).toBe("failed");
    expect(stored.failureReason).toMatch(/sha256/);
  });

  test("rejects expired JWT", async () => {
    await seedPendingRecord(uploadKv);
    const token = await makeJwt({ exp: Math.floor(Date.now() / 1000) - 1 });
    const req = buildPutRequest(encoder.encode("x"), token);
    const res = await handleUpload(req, env, UPLOAD_ID);
    expect(res.status).toBe(401);
  });
});
