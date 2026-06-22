import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env, UserProps } from "../env";
import { exchangeAuthCode, fetchGoogleUserInfo, putTokenRecord } from "./tokens";

interface AuthEnv extends Env {
  OAUTH_PROVIDER: OAuthHelpers;
}

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const STATE_TTL_SECONDS = 600;

function stateKey(state: string): string {
  return `oauthstate:${state}`;
}

function redirectUri(request: Request): string {
  const url = new URL(request.url);
  return `${url.origin}/callback`;
}

export const googleAuthHandler = {
  async fetch(request: Request, env: AuthEnv, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/authorize" && request.method === "GET") {
      return startGoogleSignin(request, env);
    }

    if (url.pathname === "/callback" && request.method === "GET") {
      return handleGoogleCallback(request, env);
    }

    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return Response.json(
        {
          resource: `${url.origin}/mcp`,
          authorization_servers: [url.origin],
          bearer_methods_supported: ["header"],
          scopes_supported: ["drive.file", "drive.readonly"],
        },
        { headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }

    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return Response.json(
        {
          resource: `${url.origin}/mcp`,
          authorization_servers: [url.origin],
          bearer_methods_supported: ["header"],
          scopes_supported: ["drive.file", "drive.readonly"],
        },
        { headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }

    if (url.pathname === "/") {
      return new Response(
        "Google Drive Upload MCP Server. Connect via /mcp with an MCP client.",
        { headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }

    return new Response("Not Found", { status: 404 });
  },
};

async function startGoogleSignin(request: Request, env: AuthEnv): Promise<Response> {
  const oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);

  const state = crypto.randomUUID();
  await env.OAUTH_KV.put(stateKey(state), JSON.stringify(oauthReq), {
    expirationTtl: STATE_TTL_SECONDS,
  });

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(request),
    response_type: "code",
    scope: env.GOOGLE_OAUTH_SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });

  return Response.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`, 302);
}

async function handleGoogleCallback(request: Request, env: AuthEnv): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) return new Response(`Google OAuth error: ${error}`, { status: 400 });
  if (!state || !code) return new Response("Missing state or code", { status: 400 });

  const stored = await env.OAUTH_KV.get(stateKey(state));
  if (!stored) return new Response("Invalid or expired state", { status: 400 });
  await env.OAUTH_KV.delete(stateKey(state));

  const oauthReq = JSON.parse(stored);

  const tokens = await exchangeAuthCode(env, code, redirectUri(request));
  if (!tokens.refresh_token) {
    return new Response(
      "Google did not return a refresh_token. Revoke prior consent and retry.",
      { status: 400 }
    );
  }
  const userInfo = await fetchGoogleUserInfo(tokens.access_token);

  const now = Math.floor(Date.now() / 1000);
  await putTokenRecord(env, userInfo.sub, {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: now + tokens.expires_in,
    scope: tokens.scope ?? env.GOOGLE_OAUTH_SCOPES,
  });

  const props: UserProps = {
    userId: userInfo.sub,
    email: userInfo.email,
  };

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReq,
    userId: userInfo.sub,
    scope: ["drive.file", "drive.readonly"],
    metadata: { email: userInfo.email },
    props,
  });

  return Response.redirect(redirectTo, 302);
}
