import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { UploadMcpAgent } from "./mcp/agent";
import { UploadSession } from "./upload/session";
import { googleAuthHandler } from "./auth/google";
import { handleUpload } from "./upload/handler";
import { handleDownload } from "./download/handler";
import type { Env } from "./env";

export { UploadMcpAgent, UploadSession };

interface ProviderEnv extends Env {
  OAUTH_PROVIDER: OAuthHelpers;
}

const UPLOAD_PATH_RE = /^\/upload\/([0-9a-fA-F-]{36})$/;
const DOWNLOAD_PATH_RE = /^\/download\/([0-9a-fA-F-]{36})$/;

const mcpServe = UploadMcpAgent.serve("/mcp");

const defaultHandler: ExportedHandler<ProviderEnv> = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const uploadMatch = UPLOAD_PATH_RE.exec(url.pathname);
    if (uploadMatch) {
      return handleUpload(request as unknown as Request, env, uploadMatch[1]!);
    }

    const downloadMatch = DOWNLOAD_PATH_RE.exec(url.pathname);
    if (downloadMatch) {
      return handleDownload(request as unknown as Request, env, downloadMatch[1]!);
    }

    return googleAuthHandler.fetch(request as unknown as Request, env, ctx);
  },
};

const apiHandler: ExportedHandler<ProviderEnv> = {
  async fetch(request, env, ctx) {
    return mcpServe.fetch(request as unknown as Request, env, ctx);
  },
};

export default new OAuthProvider({
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  apiRoute: "/mcp",
  apiHandler: apiHandler as never,
  defaultHandler: defaultHandler as never,
});
