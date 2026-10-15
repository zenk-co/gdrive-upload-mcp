import type { AuthRequest, ClientInfo, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env, UserProps } from "../env";
import { exchangeAuthCode, fetchGoogleUserInfo, putTokenRecord } from "./tokens";
import {
  STATE_COOKIE,
  approvedClientsCookie,
  clearStateCookie,
  getCookie,
  readApprovedClients,
  renderApprovalPage,
  stateCookie,
} from "./approval";

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

    if (url.pathname === "/authorize" && request.method === "POST") {
      return handleApproval(request, env);
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

function badRequest(message: string): Response {
  return new Response(message, {
    status: 400,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function misconfigured(): Response {
  return new Response("Server misconfigured: COOKIE_SECRET is not set", { status: 500 });
}

/** Rejects requests the provider library lets through: unknown clients, unregistered redirect URIs, missing/plain PKCE. */
function validateAuthRequest(oauthReq: AuthRequest, client: ClientInfo | null): string | null {
  if (!client) return "Unknown client_id";
  if (!oauthReq.redirectUri || !client.redirectUris.includes(oauthReq.redirectUri)) {
    return "redirect_uri is missing or not registered for this client";
  }
  if (oauthReq.responseType !== "code") return "response_type must be 'code'";
  if (!oauthReq.codeChallenge || oauthReq.codeChallengeMethod !== "S256") {
    return "PKCE with code_challenge_method=S256 is required";
  }
  return null;
}

async function startGoogleSignin(request: Request, env: AuthEnv): Promise<Response> {
  if (!env.COOKIE_SECRET) return misconfigured();

  let oauthReq: AuthRequest;
  try {
    oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (e) {
    return badRequest((e as Error).message);
  }
  const client = oauthReq.clientId ? await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId) : null;
  const invalid = validateAuthRequest(oauthReq, client);
  if (invalid) return badRequest(invalid);

  const state = crypto.randomUUID();
  await env.OAUTH_KV.put(stateKey(state), JSON.stringify(oauthReq), {
    expirationTtl: STATE_TTL_SECONDS,
  });

  // Clients registered via open DCR may belong to anyone, so the user must
  // confirm each client once per browser before we send them to Google.
  const approved = await readApprovedClients(request, env.COOKIE_SECRET);
  if (approved.includes(oauthReq.clientId)) {
    return redirectToGoogle(request, env, state, []);
  }
  return renderApprovalPage({ client: client!, redirectUri: oauthReq.redirectUri, state });
}

async function handleApproval(request: Request, env: AuthEnv): Promise<Response> {
  if (!env.COOKIE_SECRET) return misconfigured();

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return badRequest("Expected a form submission");
  }
  const state = form.get("state");
  // The state doubles as the CSRF token: it must match the cookie set on GET /authorize.
  if (typeof state !== "string" || !state || getCookie(request, STATE_COOKIE) !== state) {
    return new Response("Invalid or missing CSRF token", { status: 403 });
  }
  const stored = await env.OAUTH_KV.get(stateKey(state));
  if (!stored) return badRequest("Invalid or expired state");
  const oauthReq = JSON.parse(stored) as AuthRequest;

  const approved = await approvedClientsCookie(request, oauthReq.clientId, env.COOKIE_SECRET);
  return redirectToGoogle(request, env, state, [approved]);
}

function redirectToGoogle(
  request: Request,
  env: AuthEnv,
  state: string,
  extraCookies: string[]
): Response {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(request),
    response_type: "code",
    scope: env.GOOGLE_OAUTH_SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });

  const headers = new Headers({ Location: `${GOOGLE_AUTH_URL}?${params.toString()}` });
  headers.append("Set-Cookie", stateCookie(state));
  for (const c of extraCookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

async function handleGoogleCallback(request: Request, env: AuthEnv): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) return new Response(`Google OAuth error: ${error}`, { status: 400 });
  if (!state || !code) return new Response("Missing state or code", { status: 400 });
  // Bind the callback to the browser that started the flow (login CSRF).
  if (getCookie(request, STATE_COOKIE) !== state) {
    return new Response("State does not match this browser session", { status: 400 });
  }

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

  const headers = new Headers({ Location: redirectTo });
  headers.append("Set-Cookie", clearStateCookie());
  return new Response(null, { status: 302, headers });
}
