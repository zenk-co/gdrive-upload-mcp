import type { ClientInfo } from "@cloudflare/workers-oauth-provider";

/**
 * Browser-bound OAuth state. Set on /authorize, checked on the approval POST
 * (double-submit CSRF token) and on /callback (login CSRF).
 */
export const STATE_COOKIE = "__Host-gdmcp_state";
/** HMAC-signed list of (client_id, redirect_uri) pairs this browser has approved. */
export const APPROVED_COOKIE = "__Host-gdmcp_approved";

const STATE_COOKIE_MAX_AGE = 600;
const APPROVED_COOKIE_MAX_AGE = 365 * 24 * 3600;
const MAX_APPROVALS = 30;
/** Payload format version. v1 (a bare array of client_ids) is no longer honoured. */
const APPROVAL_FORMAT = 2;

export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function stateCookie(state: string): string {
  return `${STATE_COOKIE}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${STATE_COOKIE_MAX_AGE}`;
}

export function clearStateCookie(): string {
  return `${STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/**
 * Approval is per (client_id, redirect_uri): a DCR client may register several
 * redirect URIs, and approving one must not authorize sending codes to another.
 */
async function approvalKey(clientId: string, redirectUri: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([clientId, redirectUri]))
  );
  return base64UrlEncode(new Uint8Array(digest));
}

/** Returns the verified approval keys, or [] if the cookie is absent, tampered or in an old format. */
async function readApprovalKeys(request: Request, secret: string): Promise<string[]> {
  const raw = getCookie(request, APPROVED_COOKIE);
  if (!raw) return [];
  const dot = raw.indexOf(".");
  if (dot === -1) return [];
  const payload = raw.slice(0, dot);
  try {
    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      base64UrlDecode(raw.slice(dot + 1)),
      new TextEncoder().encode(payload)
    );
    if (!ok) return [];
    const data = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
    if (data?.v !== APPROVAL_FORMAT || !Array.isArray(data.k)) return [];
    return data.k.filter((x: unknown): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

export async function isApproved(
  request: Request,
  clientId: string,
  redirectUri: string,
  secret: string
): Promise<boolean> {
  const keys = await readApprovalKeys(request, secret);
  return keys.includes(await approvalKey(clientId, redirectUri));
}

/** Builds a Set-Cookie value that adds (`clientId`, `redirectUri`) to the approved list. */
export async function approvalCookie(
  request: Request,
  clientId: string,
  redirectUri: string,
  secret: string
): Promise<string> {
  const key = await approvalKey(clientId, redirectUri);
  const existing = (await readApprovalKeys(request, secret)).filter((k) => k !== key);
  const keys = [...existing, key].slice(-MAX_APPROVALS);
  const payload = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify({ v: APPROVAL_FORMAT, k: keys }))
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(payload))
  );
  return `${APPROVED_COOKIE}=${payload}.${base64UrlEncode(sig)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${APPROVED_COOKIE_MAX_AGE}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function redirectHost(redirectUri: string): string {
  try {
    const u = new URL(redirectUri);
    return u.host || u.protocol;
  } catch {
    return redirectUri;
  }
}

/**
 * Consent page shown the first time a browser authorizes a given client and
 * redirect URI. The client name is self-declared at registration, so the
 * redirect host is shown prominently (that is where the authorization code
 * will be sent), along with every redirect URI the client registered.
 */
export function renderApprovalPage(args: {
  client: ClientInfo;
  redirectUri: string;
  state: string;
}): Response {
  const name = escapeHtml(args.client.clientName || "(名前未設定 / unnamed client)");
  const host = escapeHtml(redirectHost(args.redirectUri));
  const uri = escapeHtml(args.redirectUri);
  const state = escapeHtml(args.state);
  const registered = args.client.redirectUris
    .map((u) => `<li${u === args.redirectUri ? ' class="current"' : ""}>${escapeHtml(u)}</li>`)
    .join("\n");
  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>アクセスの承認 / Authorize access</title>
<style>
body{font-family:system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;line-height:1.6;color:#222}
.box{border:1px solid #ccc;border-radius:8px;padding:1rem 1.25rem}
.host{font-size:1.25rem;font-weight:bold;word-break:break-all}
.uri{color:#666;font-size:.85rem;word-break:break-all}
.warn{background:#fff4e5;border-left:4px solid #f0a020;padding:.5rem .75rem}
.registered{font-size:.85rem;word-break:break-all}
.registered .current{font-weight:bold}
button{font-size:1rem;padding:.5rem 1.5rem;margin-top:1rem}
</style>
</head>
<body>
<h1>Google Drive へのアクセスを承認しますか?</h1>
<div class="box">
<p>クライアント名 / Client: <strong>${name}</strong></p>
<p>認可後の送信先 / Redirects to:<br><span class="host">${host}</span><br><span class="uri">${uri}</span></p>
<p>このクライアントに登録されている送信先 / All registered redirect URIs:</p>
<ul class="registered">
${registered}
</ul>
</div>
<p>承認すると、このクライアントはあなたの Google Drive 全体のファイルを検索・ダウンロードでき、ファイルのアップロードと (このサーバーで作成したファイルの) 削除もできるようになります。</p>
<p class="warn">クライアント名は登録者の自己申告です。送信先が普段使っている MCP クライアント (例: Claude) のものか確認してください。登録済みの送信先に見覚えのないものが含まれる場合や、心当たりがない場合はこのページを閉じてください。承認はこの送信先に対してのみ記憶され、別の送信先では再度確認されます。<br>
The client name is self-declared. Only approve if the destination above belongs to the MCP client you are connecting, and be wary if the client registered unfamiliar destinations. Approval is remembered for this destination only. Otherwise, close this page.</p>
<form method="post" action="/authorize">
<input type="hidden" name="state" value="${state}">
<button type="submit">承認して Google にログイン / Approve</button>
</form>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'",
      "X-Frame-Options": "DENY",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Set-Cookie": stateCookie(args.state),
    },
  });
}
