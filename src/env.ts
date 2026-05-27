import type { DurableObjectNamespace, KVNamespace } from "@cloudflare/workers-types";

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

export const UPLOAD_KV_PREFIX = "upload:";
export const TOKEN_KV_PREFIX = "gtoken:";

export function uploadKey(uploadId: string): string {
  return UPLOAD_KV_PREFIX + uploadId;
}

export function tokenKey(userId: string): string {
  return TOKEN_KV_PREFIX + userId;
}
