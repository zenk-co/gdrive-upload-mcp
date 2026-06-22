import { createDownloads, kvTransferStore, type DownloadSource } from "mcp-upload-kit";
import type { Env } from "../env";
import { DOWNLOAD_KV_PREFIX } from "../env";
import { getFreshAccessToken } from "../auth/tokens";
import { driveDownloadResponse } from "../drive";

const DOWNLOAD_TTL_DEFAULT = 900;

/** Metadata stored on each download grant. */
export type DownloadMeta = { fileId: string };

/** The kit-backed download controller (prepare / serve), keyed in UPLOAD_KV. */
export function downloads(env: Env) {
  const ttl = Number(env.DOWNLOAD_TTL_SECONDS) || Number(env.TOKEN_TTL_SECONDS) || DOWNLOAD_TTL_DEFAULT;
  return createDownloads<DownloadMeta>({
    store: kvTransferStore(env.UPLOAD_KV, DOWNLOAD_KV_PREFIX),
    baseUrl: env.WORKER_BASE_URL,
    ttlSeconds: ttl,
  });
}

/** Fetches the file bytes from Google Drive for a verified grant. */
export function driveSource(env: Env): DownloadSource<DownloadMeta> {
  return {
    async fetch({ record }) {
      const accessToken = await getFreshAccessToken(env, record.owner);
      return driveDownloadResponse({ accessToken, fileId: record.metadata!.fileId });
    },
  };
}
