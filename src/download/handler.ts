import type { Env, DownloadRecord } from "../env";
import { downloadKey } from "../env";
import { extractBearerToken, jsonResponse as json, safeEqual } from "mcp-upload-kit";
import { getFreshAccessToken } from "../auth/tokens";
import { driveDownloadResponse } from "../drive";

/**
 * Data plane for downloads. The `download_file` MCP tool issues a short-lived
 * grant; the client redeems it here with `GET /download/:downloadId` plus the
 * bearer download token. The Drive bytes stream straight to the client, so they
 * never travel through the MCP JSON-RPC channel or the model's context.
 */
export async function handleDownload(
  request: Request,
  env: Env,
  downloadId: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return json({ error: "method not allowed" }, 405, { Allow: "GET" });
  }

  const token = extractBearerToken(request);
  if (!token) return json({ error: "missing Authorization: Bearer" }, 401);

  const raw = await env.UPLOAD_KV.get(downloadKey(downloadId));
  if (!raw) return json({ error: "download not found" }, 404);
  const record = JSON.parse(raw) as DownloadRecord;

  if (!safeEqual(token, record.token)) {
    return json({ error: "invalid download token" }, 401);
  }
  if (Date.parse(record.expiresAt) < Date.now()) {
    return json({ error: "download link expired" }, 410);
  }

  let accessToken: string;
  try {
    accessToken = await getFreshAccessToken(env, record.userId);
  } catch (e) {
    return json({ error: `google auth: ${(e as Error).message}` }, 500);
  }

  const driveRes = await driveDownloadResponse({ accessToken, fileId: record.fileId });
  if (!driveRes.ok || !driveRes.body) {
    return json({ error: `drive download failed: ${driveRes.status}` }, 502);
  }

  const headers = new Headers({
    "Content-Type": record.mimeType || "application/octet-stream",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(record.name)}`,
  });
  if (record.size) headers.set("Content-Length", record.size);

  return new Response(driveRes.body, { status: 200, headers });
}
