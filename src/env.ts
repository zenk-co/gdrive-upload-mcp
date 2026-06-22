import type { DurableObjectNamespace, KVNamespace } from "@cloudflare/workers-types";
import { uploadKey as kitUploadKey } from "mcp-upload-kit";

export interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  UPLOAD_SESSION: DurableObjectNamespace;
  UPLOAD_KV: KVNamespace;
  TOKEN_KV: KVNamespace;
  OAUTH_KV: KVNamespace;

  JWT_SIGNING_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  COOKIE_SECRET: string;

  MAX_UPLOAD_BYTES: string;
  GOOGLE_OAUTH_SCOPES: string;
  TOKEN_TTL_SECONDS: string;
  DOWNLOAD_TTL_SECONDS?: string;
  WORKER_BASE_URL: string;
}

export interface UserProps extends Record<string, unknown> {
  userId: string;
  email: string;
}

export interface UploadRecord {
  status: "pending" | "completed" | "failed";
  userId: string;
  filename: string;
  size: number;
  contentType: string;
  sha256?: string;
  parentFolderId?: string;
  expiresAt: string;
  actualSize?: number;
  actualSha256?: string;
  driveFileId?: string;
  driveName?: string;
  driveMime?: string;
  failureReason?: string;
}

/**
 * A short-lived download grant. Issued by the `download_file` MCP tool and
 * redeemed by `GET /download/:downloadId`, so the file bytes stream directly
 * from Drive to the client instead of travelling through the MCP channel.
 */
export interface DownloadRecord {
  userId: string;
  fileId: string;
  name: string;
  mimeType: string;
  size: string;
  token: string;
  expiresAt: string;
}

export const UPLOAD_KV_PREFIX = "upload:";
export const DOWNLOAD_KV_PREFIX = "download:";
export const TOKEN_KV_PREFIX = "gtoken:";

export function uploadKey(uploadId: string): string {
  return kitUploadKey(uploadId, UPLOAD_KV_PREFIX);
}

export function downloadKey(downloadId: string): string {
  return kitUploadKey(downloadId, DOWNLOAD_KV_PREFIX);
}

export function tokenKey(userId: string): string {
  return TOKEN_KV_PREFIX + userId;
}
