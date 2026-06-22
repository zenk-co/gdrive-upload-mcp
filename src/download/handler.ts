import type { Env } from "../env";
import { downloads, driveSource } from "./controller";

/**
 * Data plane for downloads. The `download_file` MCP tool issues a short-lived
 * grant; the client redeems it here with `GET /download/:downloadId` plus the
 * bearer download token. The kit verifies the grant and streams the Drive bytes
 * straight to the client, so they never travel through the MCP channel or the
 * model's context.
 */
export function handleDownload(request: Request, env: Env, downloadId: string): Promise<Response> {
  return downloads(env).serve({ downloadId, request, source: driveSource(env) });
}
