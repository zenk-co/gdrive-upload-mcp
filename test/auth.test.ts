import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { googleAuthHandler } from "../src/auth/google";
import { APPROVED_COOKIE, STATE_COOKIE } from "../src/auth/approval";
import { tokenKey, type Env } from "../src/env";
import { MemoryKV } from "./helpers/kv";

const ORIGIN = "https://mcp.example.test";
const CLIENT_REDIRECT = "https://client.example/cb";
const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

// The real provider in front of our handler, as in src/index.ts (minus the MCP agent).
const provider = new OAuthProvider({
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  apiRoute: "/mcp",
  apiHandler: { fetch: async () => new Response("api") } as never,
  defaultHandler: googleAuthHandler as never,
});

let oauthKv: MemoryKV;
let tokenKv: MemoryKV;
let env: Env;

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    MCP_OBJECT: {} as unknown as Env["MCP_OBJECT"],
    UPLOAD_SESSION: {} as unknown as Env["UPLOAD_SESSION"],
    UPLOAD_KV: new MemoryKV().asKV(),
    TOKEN_KV: tokenKv.asKV(),
    OAUTH_KV: oauthKv.asKV(),
    JWT_SIGNING_KEY: "secret",
    GOOGLE_CLIENT_ID: "google-client-id",
    GOOGLE_CLIENT_SECRET: "google-client-secret",
    COOKIE_SECRET: "cookie-secret-for-tests-0123456789abcdef",
    MAX_UPLOAD_BYTES: "1048576",
    GOOGLE_OAUTH_SCOPES: "openid email drive.file drive.readonly",
    TOKEN_TTL_SECONDS: "900",
    WORKER_BASE_URL: ORIGIN,
    ...overrides,
  };
}

function call(path: string, init?: RequestInit, e: Env = env): Promise<Response> {
  return provider.fetch(new Request(`${ORIGIN}${path}`, init) as never, e as never, ctx) as Promise<Response>;
}

async function registerClient(name: string, redirectUris = [CLIENT_REDIRECT]): Promise<string> {
  const res = await call("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

function authorizeQuery(clientId: string, overrides: Record<string, string | null> = {}): string {
  const params: Record<string, string | null> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLIENT_REDIRECT,
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: "S256",
    state: "client-state",
    ...overrides,
  };
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null) qs.set(k, v);
  return `/authorize?${qs.toString()}`;
}

/** Returns `name=value` pairs from Set-Cookie headers, keyed by cookie name. */
function setCookies(res: Response): Map<string, { value: string; raw: string }> {
  const out = new Map<string, { value: string; raw: string }>();
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const eq = pair!.indexOf("=");
    out.set(pair!.slice(0, eq), { value: pair!.slice(eq + 1), raw });
  }
  return out;
}

function hiddenState(html: string): string {
  const m = /name="state" value="([^"]+)"/.exec(html);
  if (!m) throw new Error("state field not found");
  return m[1]!;
}

async function approve(
  clientId: string,
  redirectUri = CLIENT_REDIRECT,
  cookies: string[] = []
): Promise<{ state: string; approvedCookie: string }> {
  const page = await call(authorizeQuery(clientId, { redirect_uri: redirectUri }), {
    headers: cookies.length ? { Cookie: cookies.join("; ") } : {},
  });
  expect(page.status).toBe(200);
  const state = hiddenState(await page.text());
  const res = await call("/authorize", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: [`${STATE_COOKIE}=${state}`, ...cookies].join("; "),
    },
    body: new URLSearchParams({ state }).toString(),
  });
  expect(res.status).toBe(302);
  const approved = setCookies(res).get(APPROVED_COOKIE);
  expect(approved).toBeDefined();
  return { state, approvedCookie: `${APPROVED_COOKIE}=${approved!.value}` };
}

beforeEach(() => {
  oauthKv = new MemoryKV();
  tokenKv = new MemoryKV();
  env = buildEnv();
});

describe("/authorize request validation", () => {
  test("rejects an unknown client_id", async () => {
    const res = await call(authorizeQuery("does-not-exist"));
    expect(res.status).toBe(400);
  });

  test("rejects a redirect_uri not registered for the client", async () => {
    const clientId = await registerClient("App");
    const res = await call(authorizeQuery(clientId, { redirect_uri: "https://attacker.example/cb" }));
    expect(res.status).toBe(400);
  });

  test("rejects a missing redirect_uri", async () => {
    const clientId = await registerClient("App");
    const res = await call(authorizeQuery(clientId, { redirect_uri: null }));
    expect(res.status).toBe(400);
  });

  test("rejects requests without PKCE", async () => {
    const clientId = await registerClient("App");
    const res = await call(
      authorizeQuery(clientId, { code_challenge: null, code_challenge_method: null })
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("S256");
  });

  test("rejects plain PKCE", async () => {
    const clientId = await registerClient("App");
    const res = await call(authorizeQuery(clientId, { code_challenge_method: "plain" }));
    expect(res.status).toBe(400);
  });

  test("fails closed when COOKIE_SECRET is not configured", async () => {
    const clientId = await registerClient("App");
    const res = await call(authorizeQuery(clientId), undefined, buildEnv({ COOKIE_SECRET: "" }));
    expect(res.status).toBe(500);
  });
});

describe("/authorize client approval", () => {
  test("first visit shows an approval page with the redirect host, HTML-escaped", async () => {
    const clientId = await registerClient('<script>alert("x")</script>');
    const res = await call(authorizeQuery(clientId));

    expect(res.status).toBe(200);
    expect(res.headers.get("Location")).toBeNull();
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");

    const html = await res.text();
    expect(html).toContain("client.example");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");

    const state = hiddenState(html);
    const cookie = setCookies(res).get(STATE_COOKIE);
    expect(cookie?.value).toBe(state);
    expect(cookie?.raw).toMatch(/HttpOnly/);
    expect(cookie?.raw).toMatch(/Secure/);
    expect(cookie?.raw).toMatch(/SameSite=Lax/);
  });

  test("approval POST without the matching state cookie is rejected (CSRF)", async () => {
    const clientId = await registerClient("App");
    const page = await call(authorizeQuery(clientId));
    const state = hiddenState(await page.text());

    const noCookie = await call("/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ state }).toString(),
    });
    expect(noCookie.status).toBe(403);

    const wrongCookie = await call("/authorize", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `${STATE_COOKIE}=something-else`,
      },
      body: new URLSearchParams({ state }).toString(),
    });
    expect(wrongCookie.status).toBe(403);
  });

  test("approval POST redirects to Google and remembers the client", async () => {
    const clientId = await registerClient("App");
    const page = await call(authorizeQuery(clientId));
    const state = hiddenState(await page.text());

    const res = await call("/authorize", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `${STATE_COOKIE}=${state}`,
      },
      body: new URLSearchParams({ state }).toString(),
    });

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location")!);
    expect(location.origin).toBe("https://accounts.google.com");
    expect(location.searchParams.get("state")).toBe(state);
    const cookies = setCookies(res);
    expect(cookies.get(STATE_COOKIE)?.value).toBe(state);
    expect(cookies.get(APPROVED_COOKIE)?.raw).toMatch(/HttpOnly; Secure; SameSite=Lax/);
  });

  test("an approved client goes straight to Google on later visits", async () => {
    const clientId = await registerClient("App");
    const { approvedCookie } = await approve(clientId);

    const res = await call(authorizeQuery(clientId), { headers: { Cookie: approvedCookie } });

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location")!);
    expect(location.origin).toBe("https://accounts.google.com");
    expect(setCookies(res).get(STATE_COOKIE)?.value).toBe(location.searchParams.get("state"));
  });

  test("approval of one client does not carry over to another client", async () => {
    const trusted = await registerClient("Trusted");
    const other = await registerClient("Other", ["https://attacker.example/cb"]);
    const { approvedCookie } = await approve(trusted);

    const res = await call(
      authorizeQuery(other, { redirect_uri: "https://attacker.example/cb" }),
      { headers: { Cookie: approvedCookie } }
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("attacker.example");
  });

  test("the approval page lists every redirect URI the client registered", async () => {
    const clientId = await registerClient("Multi", [CLIENT_REDIRECT, "https://evil.example/cb"]);
    const res = await call(authorizeQuery(clientId));
    const html = await res.text();
    expect(html).toContain(CLIENT_REDIRECT);
    expect(html).toContain("https://evil.example/cb");
  });

  test("approval is per redirect_uri: a second registered redirect_uri needs its own approval", async () => {
    const evil = "https://evil.example/cb";
    const clientId = await registerClient("Multi", [CLIENT_REDIRECT, evil]);
    const { approvedCookie } = await approve(clientId, CLIENT_REDIRECT);

    // Same client, other redirect_uri: must show the approval page, not redirect to Google.
    const other = await call(authorizeQuery(clientId, { redirect_uri: evil }), {
      headers: { Cookie: approvedCookie },
    });
    expect(other.status).toBe(200);
    expect(other.headers.get("Location")).toBeNull();
    expect(await other.text()).toContain("evil.example");

    // The approved pair still goes straight through.
    const same = await call(authorizeQuery(clientId), { headers: { Cookie: approvedCookie } });
    expect(same.status).toBe(302);
    expect(new URL(same.headers.get("Location")!).origin).toBe("https://accounts.google.com");
  });

  test("approving a second redirect_uri keeps the first approval", async () => {
    const second = "https://client.example/cb2";
    const clientId = await registerClient("Multi", [CLIENT_REDIRECT, second]);
    const first = await approve(clientId, CLIENT_REDIRECT);
    const both = await approve(clientId, second, [first.approvedCookie]);

    for (const redirectUri of [CLIENT_REDIRECT, second]) {
      const res = await call(authorizeQuery(clientId, { redirect_uri: redirectUri }), {
        headers: { Cookie: both.approvedCookie },
      });
      expect(res.status).toBe(302);
    }
  });

  test("an approval cookie in the old client_id-only format is not honoured", async () => {
    const clientId = await registerClient("App");
    // v1 payload: a bare JSON array of client_ids, correctly signed with COOKIE_SECRET.
    const payload = Buffer.from(JSON.stringify([clientId])).toString("base64url");
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.COOKIE_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = Buffer.from(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))
    ).toString("base64url");

    const res = await call(authorizeQuery(clientId), {
      headers: { Cookie: `${APPROVED_COOKIE}=${payload}.${sig}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Location")).toBeNull();
  });

  test("a tampered approval cookie is ignored", async () => {
    const victimClient = await registerClient("Victim");
    const attackerClient = await registerClient("Attacker");
    const { approvedCookie } = await approve(victimClient);

    // Swap the payload for the attacker's client_id but keep the old signature.
    const [, value] = approvedCookie.split("=", 2);
    const sig = value!.split(".")[1];
    const forgedPayload = Buffer.from(JSON.stringify([attackerClient])).toString("base64url");
    const forged = `${APPROVED_COOKIE}=${forgedPayload}.${sig}`;

    const res = await call(authorizeQuery(attackerClient), { headers: { Cookie: forged } });
    expect(res.status).toBe(200);
  });
});

describe("/callback", () => {
  let restoreFetch: () => void;
  const googleCalls: string[] = [];

  beforeEach(() => {
    googleCalls.length = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      googleCalls.push(url);
      if (url === "https://oauth2.googleapis.com/token") {
        return Response.json({
          access_token: "g-access",
          refresh_token: "g-refresh",
          expires_in: 3600,
          token_type: "Bearer",
        });
      }
      if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
        return Response.json({ sub: "google-sub-1", email: "victim@example.test" });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    restoreFetch = () => {
      globalThis.fetch = originalFetch;
    };
  });

  afterEach(() => restoreFetch());

  test("rejects a callback whose state is not bound to this browser", async () => {
    const clientId = await registerClient("App");
    const { state } = await approve(clientId);

    const res = await call(`/callback?code=google-code&state=${state}`);

    expect(res.status).toBe(400);
    expect(googleCalls).toEqual([]);
    // The pending authorization is not consumed by the rejected attempt.
    expect(await oauthKv.get(`oauthstate:${state}`)).not.toBeNull();
  });

  test("completes the authorization when the state cookie matches", async () => {
    const clientId = await registerClient("App");
    const { state } = await approve(clientId);

    const res = await call(`/callback?code=google-code&state=${state}`, {
      headers: { Cookie: `${STATE_COOKIE}=${state}` },
    });

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location")!);
    expect(`${location.origin}${location.pathname}`).toBe(CLIENT_REDIRECT);
    expect(location.searchParams.get("code")).toBeTruthy();
    expect(location.searchParams.get("state")).toBe("client-state");
    expect(setCookies(res).get(STATE_COOKIE)?.raw).toMatch(/Max-Age=0/);
    expect(await tokenKv.get(tokenKey("google-sub-1"))).not.toBeNull();
    expect(await oauthKv.get(`oauthstate:${state}`)).toBeNull();
  });
});
