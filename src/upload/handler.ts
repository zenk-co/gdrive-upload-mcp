import type { DurableObjectStub } from "@cloudflare/workers-types";
import type { Env, UploadRecord } from "../env";
import { uploadKey } from "../env";
import { verifyUploadJwt, type UploadJwtClaims } from "../jwt";
import { createShaCountingStream } from "../sha256";
import { getFreshAccessToken } from "../auth/tokens";
import {
  cancelDriveSession,
  deleteDriveFile,
  initResumableUpload,
  streamToDriveSession,
} from "../drive";
import type { UploadSession, ChunkResult } from "./session";

interface ContentRange {
  start: number;
  end: number;
  total: number;
}

export async function handleUpload(
  request: Request,
  env: Env,
  uploadId: string
): Promise<Response> {
  if (request.method !== "PUT") {
    return json({ error: "method not allowed" }, 405, { Allow: "PUT" });
  }
  if (!request.body) return json({ error: "missing body" }, 400);

  const auth = request.headers.get("Authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(auth);
  if (!match) return json({ error: "missing Authorization: Bearer" }, 401);

  let claims: UploadJwtClaims;
  try {
    claims = await verifyUploadJwt(match[1]!, env.JWT_SIGNING_KEY);
  } catch (e) {
    return json({ error: `invalid token: ${(e as Error).message}` }, 401);
  }
  if (claims.uploadId !== uploadId) return json({ error: "uploadId mismatch" }, 401);

  const raw = await env.UPLOAD_KV.get(uploadKey(uploadId));
  if (!raw) return json({ error: "upload session not found" }, 404);
  const record = JSON.parse(raw) as UploadRecord;
  if (record.status !== "pending") {
    return json({ error: `upload not pending (status=${record.status})` }, 409);
  }
  if (record.userId !== claims.sub) return json({ error: "user mismatch" }, 403);

  const declaredLen = Number(
    request.headers.get("Content-Length") ?? request.headers.get("X-Upload-Content-Length") ?? ""
  );
  if (!declaredLen || !Number.isFinite(declaredLen)) {
    return json({ error: "Content-Length required" }, 411);
  }

  const rangeHeader = request.headers.get("Content-Range");
  if (rangeHeader) {
    const range = parseContentRange(rangeHeader);
    if (!range) return json({ error: `invalid Content-Range: ${rangeHeader}` }, 400);
    if (range.total !== claims.maxSize) {
      return json(
        { error: `Content-Range total ${range.total} != maxSize ${claims.maxSize}` },
        400
      );
    }
    if (range.end - range.start + 1 !== declaredLen) {
      return json({ error: "Content-Range size != Content-Length" }, 400);
    }
    if (range.start === 0 && range.end === range.total - 1) {
      return singleShotUpload(request, env, claims, record, uploadId, declaredLen);
    }
    return chunkedUpload(request, env, claims, record, uploadId, range);
  }

  if (declaredLen > claims.maxSize) {
    return json({ error: `body exceeds maxSize ${claims.maxSize}` }, 413);
  }
  return singleShotUpload(request, env, claims, record, uploadId, declaredLen);
}

async function singleShotUpload(
  request: Request,
  env: Env,
  claims: UploadJwtClaims,
  record: UploadRecord,
  uploadId: string,
  declaredLen: number
): Promise<Response> {
  if (declaredLen > claims.maxSize) {
    return json({ error: `body exceeds maxSize ${claims.maxSize}` }, 413);
  }

  let accessToken: string;
  try {
    accessToken = await getFreshAccessToken(env, record.userId);
  } catch (e) {
    return json({ error: `google auth: ${(e as Error).message}` }, 500);
  }

  let sessionUri: string;
  try {
    sessionUri = await initResumableUpload({
      accessToken,
      filename: record.filename,
      contentType: record.contentType,
      contentLength: declaredLen,
      ...(record.parentFolderId ? { parents: [record.parentFolderId] } : {}),
    });
  } catch (e) {
    return json({ error: `drive init: ${(e as Error).message}` }, 502);
  }

  const counter = createShaCountingStream(claims.maxSize);
  const piped = request.body!.pipeThrough(counter.stream);

  let drive;
  try {
    drive = await streamToDriveSession(sessionUri, piped, record.contentType, declaredLen);
  } catch (e) {
    await cancelDriveSession(sessionUri);
    await markFailed(env, uploadId, record, `drive upload: ${(e as Error).message}`);
    return json({ error: `drive upload: ${(e as Error).message}` }, 502);
  }

  const { sha256: actualSha256, size: actualSize } = counter.finalize();

  if (claims.sha256 && claims.sha256.toLowerCase() !== actualSha256.toLowerCase()) {
    await deleteDriveFile(accessToken, drive.id);
    await markFailed(env, uploadId, record, "sha256 mismatch");
    return json(
      { error: "sha256 mismatch", expected: claims.sha256, actual: actualSha256 },
      409
    );
  }

  const completed: UploadRecord = {
    ...record,
    status: "completed",
    actualSize,
    actualSha256,
    driveFileId: drive.id,
    driveName: drive.name,
    driveMime: drive.mimeType,
  };
  await env.UPLOAD_KV.put(uploadKey(uploadId), JSON.stringify(completed), {
    expirationTtl: 24 * 3600,
  });
  try {
    await sessionStub(env, uploadId).markCompletedSingle({
      driveFileId: drive.id,
      driveName: drive.name,
      driveMime: drive.mimeType,
      actualSize,
      actualSha256,
    });
  } catch {
    // DO write best-effort; KV is the fallback source
  }

  return json({ accepted: true, actualSize, actualSha256, fileId: drive.id });
}

async function chunkedUpload(
  request: Request,
  env: Env,
  claims: UploadJwtClaims,
  record: UploadRecord,
  uploadId: string,
  range: ContentRange
): Promise<Response> {
  let accessToken: string;
  try {
    accessToken = await getFreshAccessToken(env, record.userId);
  } catch (e) {
    return json({ error: `google auth: ${(e as Error).message}` }, 500);
  }

  const stub = sessionStub(env, uploadId);
  const body = new Uint8Array(await request.arrayBuffer());

  if (range.start === 0) {
    try {
      await stub.init({
        uploadId,
        userId: record.userId,
        accessToken,
        filename: record.filename,
        contentType: record.contentType,
        totalSize: claims.maxSize,
        ...(claims.sha256 ? { expectedSha256: claims.sha256 } : {}),
        ...(record.parentFolderId ? { parents: [record.parentFolderId] } : {}),
      });
    } catch (e) {
      await markFailed(env, uploadId, record, `drive init: ${(e as Error).message}`);
      return json({ error: `drive init: ${(e as Error).message}` }, 502);
    }
  }

  const result: ChunkResult = await stub.receiveChunk({
    start: range.start,
    end: range.end,
    total: range.total,
    accessToken,
    body,
  });

  if (result.status === "incomplete") {
    return new Response(
      JSON.stringify({ status: "incomplete", nextOffset: result.nextOffset }),
      {
        status: 308,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Range: `bytes=0-${result.nextOffset - 1}`,
        },
      }
    );
  }
  if (result.status === "complete") {
    return json({
      accepted: true,
      actualSize: Number(result.file.size),
      actualSha256: result.actualSha256,
      fileId: result.file.id,
    });
  }
  return json({ error: result.message }, result.httpStatus);
}

function sessionStub(env: Env, uploadId: string): UploadSessionStub {
  const ns = env.UPLOAD_SESSION as unknown as {
    idFromName(name: string): unknown;
    get(id: unknown): UploadSessionStub;
  };
  return ns.get(ns.idFromName(uploadId));
}

type UploadSessionStub = Pick<UploadSession, "init" | "receiveChunk" | "markCompletedSingle"> &
  DurableObjectStub<UploadSession>;

function parseContentRange(value: string): ContentRange | null {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+)$/.exec(value.trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  const total = Number(m[3]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(total)) return null;
  if (start < 0 || end < start || end >= total) return null;
  return { start, end, total };
}

async function markFailed(
  env: Env,
  uploadId: string,
  record: UploadRecord,
  reason: string
): Promise<void> {
  const failed: UploadRecord = { ...record, status: "failed", failureReason: reason };
  await env.UPLOAD_KV.put(uploadKey(uploadId), JSON.stringify(failed), {
    expirationTtl: 3600,
  });
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}
