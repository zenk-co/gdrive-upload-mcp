import type { ClientInfo } from "@cloudflare/workers-oauth-provider";

/**
 * Browser-bound OAuth state. Set on /authorize, checked on the approval POST
 * (double-submit CSRF token) and on /callback (login CSRF).
 */
export const STATE_COOKIE = "__Host-gdmcp_state";
/** HMAC-signed list of client_ids this browser has approved. */
export const APPROVED_COOKIE = "__Host-gdmcp_approved";

const STATE_COOKIE_MAX_AGE = 600;
const APPROVED_COOKIE_MAX_AGE = 365 * 24 * 3600;
const MAX_APPROVED_CLIENTS = 30;

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

/** Returns the verified approved client_ids, or [] if the cookie is absent or tampered. */
export async function readApprovedClients(request: Request, secret: string): Promise<string[]> {
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
    const ids = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Builds a Set-Cookie value that adds `clientId` to the approved list. */
export async function approvedClientsCookie(
  request: Request,
  clientId: string,
  secret: string
): Promise<string> {
  const existing = (await readApprovedClients(request, secret)).filter((id) => id !== clientId);
  const ids = [...existing, clientId].slice(-MAX_APPROVED_CLIENTS);
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(ids)));
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
 * Consent page shown the first time a browser authorizes a given client.
 * The client name is self-declared at registration, so the redirect host is
 * shown prominently: that is where the authorization code will be sent.
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
button{font-size:1rem;padding:.5rem 1.5rem;margin-top:1rem}
</style>
</head>
<body>
<h1>Google Drive へのアクセスを承認しますか?</h1>
<div class="box">
<p>クライアント名 / Client: <strong>${name}</strong></p>
<p>認可後の送信先 / Redirects to:<br><span class="host">${host}</span><br><span class="uri">${uri}</span></p>
</div>
<p>承認すると、このクライアントはあなたの Google Drive 全体のファイルを検索・ダウンロードでき、ファイルのアップロードと (このサーバーで作成したファイルの) 削除もできるようになります。</p>
<p class="warn">クライアント名は登録者の自己申告です。送信先が普段使っている MCP クライアント (例: Claude) のものか確認してください。心当たりがなければこのページを閉じてください。<br>
The client name is self-declared. Only approve if the destination above belongs to the MCP client you are connecting. Otherwise, close this page.</p>
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
