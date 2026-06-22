import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createUploadId, createUploadToken } from "mcp-upload-kit";
import type { Env, UserProps, DownloadRecord } from "../env";
import { downloadKey } from "../env";
import { getFreshAccessToken } from "../auth/tokens";
import {
  driveSearch,
  driveGetMetadata,
  deleteDriveFileChecked,
} from "../drive";

const DOWNLOAD_TTL_DEFAULT = 900;

export type GetUserProps = () => UserProps | undefined;

function userIdFromProps(getProps: GetUserProps): string {
  const props = getProps();
  if (!props?.userId) throw new Error("not authenticated");
  return props.userId;
}

function ok(result: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Registers Google Drive read / management tools alongside the upload tools.
 * Search, metadata and download require the `drive.readonly` scope; delete
 * targets files this app created (`drive.file`).
 */
export function registerDriveTools(server: McpServer, env: Env, getProps: GetUserProps): void {
  const origin = env.WORKER_BASE_URL.replace(/\/$/, "");
  const downloadTtl = Number(env.DOWNLOAD_TTL_SECONDS) || Number(env.TOKEN_TTL_SECONDS) || DOWNLOAD_TTL_DEFAULT;

  server.registerTool(
    "search_files",
    {
      title: "Search Drive files",
      description: [
        "Search the user's Google Drive and return matching files (id, name, mimeType, size, modifiedTime).",
        "`query` uses Google Drive query syntax, e.g. \"name contains 'report'\" or \"mimeType='application/pdf'\".",
        "Omit `query` to list recent files. Use `pageToken` from a previous result to page through more.",
      ].join("\n"),
      inputSchema: {
        query: z.string().optional().describe("Google Drive search query. Omit to list recent files."),
        pageSize: z.number().int().min(1).max(100).optional().describe("Max results (1-100, default 25)."),
        pageToken: z.string().optional().describe("Page token from a previous search to fetch the next page."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input): Promise<CallToolResult> => {
      try {
        const userId = userIdFromProps(getProps);
        const accessToken = await getFreshAccessToken(env, userId);
        const { files, nextPageToken } = await driveSearch({
          accessToken,
          ...(input.query ? { query: input.query } : {}),
          ...(input.pageSize ? { pageSize: input.pageSize } : {}),
          ...(input.pageToken ? { pageToken: input.pageToken } : {}),
        });
        return ok({ files, ...(nextPageToken ? { nextPageToken } : {}) });
      } catch (e) {
        return errorResult(`search failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "get_file_metadata",
    {
      title: "Get Drive file metadata",
      description: "Return metadata (id, name, mimeType, size, modifiedTime) for a Google Drive file by id.",
      inputSchema: {
        fileId: z.string().min(1).describe("Google Drive file id."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ fileId }): Promise<CallToolResult> => {
      try {
        const userId = userIdFromProps(getProps);
        const accessToken = await getFreshAccessToken(env, userId);
        const meta = await driveGetMetadata({ accessToken, fileId });
        return ok({ ...meta });
      } catch (e) {
        return errorResult(`metadata failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "download_file",
    {
      title: "Get a download link for a Drive file",
      description: [
        "Issue a short-lived HTTPS download URL for a Google Drive file. This does NOT return the bytes:",
        "the file is fetched out-of-band so large files never pass through this tool's response.",
        "",
        "Returns: { downloadId, downloadUrl, downloadToken, expiresAt, name, mimeType, size }.",
        "Fetch the file with: GET <downloadUrl> with header 'Authorization: Bearer <downloadToken>'.",
        "The link expires (default 15 minutes). Google-native files (Docs/Sheets/Slides) cannot be",
        "downloaded directly and return an error here.",
      ].join("\n"),
      inputSchema: {
        fileId: z.string().min(1).describe("Google Drive file id to download."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ fileId }): Promise<CallToolResult> => {
      try {
        const userId = userIdFromProps(getProps);
        const accessToken = await getFreshAccessToken(env, userId);
        const meta = await driveGetMetadata({ accessToken, fileId });

        if (meta.mimeType.startsWith("application/vnd.google-apps")) {
          return errorResult(
            `'${meta.name}' is a Google-native file (${meta.mimeType}) and cannot be downloaded directly.`,
          );
        }

        const downloadId = createUploadId();
        const token = createUploadToken();
        const exp = Math.floor(Date.now() / 1000) + downloadTtl;
        const expiresAt = new Date(exp * 1000).toISOString();

        const record: DownloadRecord = {
          userId,
          fileId,
          name: meta.name,
          mimeType: meta.mimeType,
          size: meta.size ?? "",
          token,
          expiresAt,
        };
        await env.UPLOAD_KV.put(downloadKey(downloadId), JSON.stringify(record), {
          expirationTtl: downloadTtl + 60,
        });

        return ok({
          downloadId,
          downloadUrl: `${origin}/download/${downloadId}`,
          downloadToken: token,
          expiresAt,
          name: meta.name,
          mimeType: meta.mimeType,
          ...(meta.size ? { size: Number(meta.size) } : {}),
        });
      } catch (e) {
        return errorResult(`download link failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "delete_file",
    {
      title: "Delete a Drive file",
      description: [
        "Permanently delete a Google Drive file this app has access to (files created via this server).",
        "Returns { deleted: true, fileId } on success.",
      ].join("\n"),
      inputSchema: {
        fileId: z.string().min(1).describe("Google Drive file id to delete."),
      },
      annotations: { idempotentHint: true, destructiveHint: true, openWorldHint: true },
    },
    async ({ fileId }): Promise<CallToolResult> => {
      try {
        const userId = userIdFromProps(getProps);
        const accessToken = await getFreshAccessToken(env, userId);
        await deleteDriveFileChecked(accessToken, fileId);
        return ok({ deleted: true, fileId });
      } catch (e) {
        return errorResult(`delete failed: ${(e as Error).message}`);
      }
    },
  );
}
