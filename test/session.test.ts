import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { UploadSession } from "../src/upload/session";
import { uploadKey, type Env, type UploadRecord } from "../src/env";
import { MemoryKV } from "./helpers/kv";

const UPLOAD_ID = "44444444-4444-4444-4444-444444444444";
const SESSION_URI = "https://drive.session/xyz";
const TOTAL = 8;

function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function fakeState() {
  const data = new Map<string, unknown>();
  return {
    storage: {
      async get<T>(key: string): Promise<T | undefined> {
        return data.get(key) as T | undefined;
      },
      async put(key: string, value: unknown): Promise<void> {
        data.set(key, structuredClone(value));
      },
      async delete(key: string): Promise<boolean> {
        return data.delete(key);
      },
    },
  } as unknown as DurableObjectState;
}

describe("UploadSession sha256 verification", () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  let uploadKv: MemoryKV;
  let env: Env;
  let deletes: string[];
  let originalFetch: typeof fetch;

  beforeEach(() => {
    uploadKv = new MemoryKV();
    env = { UPLOAD_KV: uploadKv.asKV() } as unknown as Env;
    deletes = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files") && method === "POST") {
        return new Response(null, { status: 200, headers: { Location: SESSION_URI } });
      }
      if (url === SESSION_URI && method === "PUT") {
        const range = new Headers(init?.headers).get("Content-Range")!;
        if (range.startsWith(`bytes 0-3/`)) return new Response(null, { status: 308 });
        return Response.json({ id: "drive-file-1", name: "f.bin", mimeType: "application/octet-stream", size: String(TOTAL) });
      }
      if (url.startsWith("https://www.googleapis.com/drive/v3/files/") && method === "DELETE") {
        deletes.push(url);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function init(session: UploadSession) {
    await session.init({
      uploadId: UPLOAD_ID,
      userId: "u1",
      accessToken: "drive-access",
      filename: "f.bin",
      contentType: "application/octet-stream",
      totalSize: TOTAL,
      expectedSha256: toHex(sha256(bytes)),
    });
  }

  const chunk = (start: number, end: number) => ({
    start,
    end,
    total: TOTAL,
    accessToken: "drive-access",
    body: bytes.slice(start, end + 1),
  });

  test("completes with a verified sha256 when the hasher survives", async () => {
    const session = new UploadSession(fakeState(), env);
    await init(session);
    expect((await session.receiveChunk(chunk(0, 3))).status).toBe("incomplete");
    const result = await session.receiveChunk(chunk(4, 7));

    expect(result).toMatchObject({ status: "complete", actualSha256: toHex(sha256(bytes)) });
    expect(deletes).toEqual([]);
  });

  test("fails and deletes the Drive file when the hasher state was lost", async () => {
    const state = fakeState();
    const first = new UploadSession(state, env);
    await init(first);
    expect((await first.receiveChunk(chunk(0, 3))).status).toBe("incomplete");

    // Simulate DO eviction: same storage, fresh in-memory hasher.
    const restarted = new UploadSession(state, env);
    const result = await restarted.receiveChunk(chunk(4, 7));

    expect(result).toMatchObject({ status: "error", httpStatus: 409 });
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toContain("drive-file-1");
    const record = JSON.parse((await uploadKv.get(uploadKey(UPLOAD_ID))) as string) as UploadRecord;
    expect(record.status).toBe("failed");
    expect(record.driveFileId).toBeUndefined();
  });
});
