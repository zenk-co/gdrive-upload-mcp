import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Env, UploadRecord, UserProps } from "../env";
import { uploadKey } from "../env";
import { signUploadJwt } from "../jwt";

const PREPARE_TOKEN_TTL_DEFAULT = 900;
const FILENAME_RE = /^[^/\x00]{1,255}$/;
const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/;
const SHA_RE = /^[a-f0-9]{64}$/;

export type GetUserProps = () => UserProps | undefined;

function userIdFromProps(getProps: GetUserProps): string {
  const props = getProps();
  if (!props?.userId) throw new Error("not authenticated");
  return props.userId;
}

export function registerUploadTools(
  server: McpServer,
  env: Env,
  getProps: GetUserProps
): void {
  const maxBytes = Number(env.MAX_UPLOAD_BYTES);
  const tokenTtl = Number(env.TOKEN_TTL_SECONDS) || PREPARE_TOKEN_TTL_DEFAULT;
  const origin = env.WORKER_BASE_URL.replace(/\/$/, "");

  server.registerTool(
    "prepare_upload",
    {
      title: "Prepare an upload (step 1 of 3)",
      description: [
        "Start a Google Drive upload by issuing a short-lived HTTPS PUT URL and bearer token.",
        "",
        "Follow these three steps in order. The PUT in step 2 is NOT a tool call — it is a regular HTTPS request you must make.",
        "",
        "  1. Call this tool with the file metadata. Optionally pre-compute the file's SHA-256 hex digest and pass it as `sha256` so the server can fail fast on byte corruption.",
        "  2. PUT the raw file bytes to the returned `uploadUrl`. Required headers:",
        "       Authorization: Bearer <uploadToken>",
        "       Content-Type: <the same contentType you passed here>",
        "       Content-Length: <the same size you passed here>",
        "     Do NOT base64-encode the body. The PUT must complete within 15 minutes (token expiry).",
        "  3. After the PUT responds 200, call `complete_upload` with the `uploadId` returned here and the file's SHA-256 hex digest.",
        "",
        "Returns: { uploadId, uploadUrl, uploadToken, expiresAt }. Keep `uploadId` for step 3.",
        "",
        `Size limit: up to ${maxBytes} bytes. Larger files would be rejected here.`,
      ].join("\n"),
      inputSchema: {
        filename: z
          .string()
          .regex(FILENAME_RE)
          .describe(
            "File name as it should appear in Google Drive. Must not contain '/' or null bytes. 1-255 characters."
          ),
        size: z
          .number()
          .int()
          .min(1)
          .max(maxBytes)
          .describe(
            `Total file size in bytes. Required so the server can preallocate the Drive resumable session and reject oversize PUTs. Max ${maxBytes}.`
          ),
        contentType: z
          .string()
          .regex(MIME_RE)
          .describe(
            "MIME type like 'text/plain', 'application/pdf', or 'image/png'. The PUT request MUST use the same Content-Type."
          ),
        sha256: z
          .string()
          .regex(SHA_RE)
          .optional()
          .describe(
            "Optional SHA-256 digest of the full file as 64 lowercase hex characters. If provided, the upload endpoint will compare the received bytes against this and reject mismatches (the Drive file is deleted on mismatch). Omit for very large files where pre-computation is expensive — the hash will still be verified in `complete_upload`."
          ),
        parentFolderId: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Optional Google Drive folder ID where the file should be created. Default is the authenticated user's My Drive root."
          ),
      },
      annotations: {
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input): Promise<CallToolResult> => {
      const userId = userIdFromProps(getProps);
      const uploadId = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      const exp = now + tokenTtl;

      const token = await signUploadJwt(
        {
          iss: "upload-mcp",
          aud: "upload-app",
          sub: userId,
          uploadId,
          filename: input.filename,
          maxSize: input.size,
          contentType: input.contentType,
          ...(input.sha256 ? { sha256: input.sha256 } : {}),
          iat: now,
          exp,
        },
        env.JWT_SIGNING_KEY
      );

      const expiresAt = new Date(exp * 1000).toISOString();
      const record: UploadRecord = {
        status: "pending",
        userId,
        filename: input.filename,
        size: input.size,
        contentType: input.contentType,
        ...(input.sha256 ? { sha256: input.sha256 } : {}),
        ...(input.parentFolderId ? { parentFolderId: input.parentFolderId } : {}),
        expiresAt,
      };
      await env.UPLOAD_KV.put(uploadKey(uploadId), JSON.stringify(record), {
        expirationTtl: tokenTtl + 3600,
      });
      const ns = env.UPLOAD_SESSION as unknown as {
        idFromName(name: string): unknown;
        get(id: unknown): { setRecord(r: UploadRecord): Promise<void> };
      };
      await ns.get(ns.idFromName(uploadId)).setRecord(record);

      const uploadUrl = `${origin}/upload/${uploadId}`;
      const result = { uploadId, uploadUrl, uploadToken: token, expiresAt };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    }
  );

  server.registerTool(
    "complete_upload",
    {
      title: "Complete an upload (step 3 of 3)",
      description: [
        "Finish a Google Drive upload that was started with `prepare_upload`. Call this AFTER the PUT in step 2 has returned 200.",
        "",
        "The server verifies that the SHA-256 you supply matches what it actually received during the PUT (independent verification against tampering or corruption). On match it returns the Drive file reference; on mismatch it returns an isError result.",
        "",
        "Returns: { fileId, resourceUri, name, mimeType, size, sha256 }. `resourceUri` is in the form `gdrive://files/<fileId>` and is also delivered as a `resource_link` content block so the file can be referenced as an MCP resource by downstream tools.",
        "",
        "Idempotent: calling again with the same `uploadId` and matching `sha256` returns the same result (within ~24h, until the record expires).",
        "",
        "Common errors (isError=true):",
        "  - 'upload not completed (status=pending)': the PUT step has not yet succeeded; wait a moment and retry, or check the PUT response.",
        "  - 'sha256 mismatch': the bytes you sent differ from what you declared (or got corrupted in transit). The Drive file is removed.",
        "  - 'uploadId not found': the upload session expired or never existed.",
        "  - 'uploadId belongs to a different user': do not reuse another user's uploadId.",
      ].join("\n"),
      inputSchema: {
        uploadId: z
          .string()
          .uuid()
          .describe(
            "The uploadId returned by `prepare_upload` at step 1. UUID v4 format."
          ),
        sha256: z
          .string()
          .regex(SHA_RE)
          .describe(
            "SHA-256 digest of the full file as 64 lowercase hex characters. Required so the server can verify byte integrity end-to-end."
          ),
      },
      annotations: {
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ uploadId, sha256 }): Promise<CallToolResult> => {
      const userId = userIdFromProps(getProps);
      const record = await readUploadRecord(env, uploadId);
      if (!record) return errorResult(`uploadId not found: ${uploadId}`);

      if (record.userId !== userId) return errorResult("uploadId belongs to a different user");
      if (record.status !== "completed") {
        return errorResult(`upload not completed (status=${record.status})`);
      }
      if (!record.actualSha256 || record.actualSha256.toLowerCase() !== sha256.toLowerCase()) {
        return errorResult(
          `sha256 mismatch: client=${sha256} server=${record.actualSha256 ?? "(none)"}`
        );
      }
      if (!record.driveFileId) return errorResult("missing driveFileId in record");

      const result = {
        fileId: record.driveFileId,
        resourceUri: `gdrive://files/${record.driveFileId}`,
        name: record.driveName ?? record.filename,
        mimeType: record.driveMime ?? record.contentType,
        size: record.actualSize ?? record.size,
        sha256: record.actualSha256,
      };
      return {
        content: [
          { type: "text", text: JSON.stringify(result) },
          {
            type: "resource_link",
            uri: result.resourceUri,
            name: result.name,
            mimeType: result.mimeType,
          },
        ],
        structuredContent: result,
      };
    }
  );
}

async function readUploadRecord(env: Env, uploadId: string): Promise<UploadRecord | null> {
  const ns = env.UPLOAD_SESSION as unknown as {
    idFromName(name: string): unknown;
    get(id: unknown): { getRecord(): Promise<UploadRecord | null> };
  };
  try {
    const fromDo = await ns.get(ns.idFromName(uploadId)).getRecord();
    if (fromDo) return fromDo;
  } catch {
    // fall through to KV
  }
  const raw = await env.UPLOAD_KV.get(uploadKey(uploadId));
  if (!raw) return null;
  return JSON.parse(raw) as UploadRecord;
}

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
