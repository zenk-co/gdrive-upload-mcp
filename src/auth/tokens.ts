import type { Env } from "../env";
import { tokenKey } from "../env";

export interface GoogleTokenRecord {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
}

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const REFRESH_SKEW_SECONDS = 60;

export async function putTokenRecord(
  env: Env,
  userId: string,
  record: GoogleTokenRecord
): Promise<void> {
  await env.TOKEN_KV.put(tokenKey(userId), JSON.stringify(record));
}

export async function getTokenRecord(
  env: Env,
  userId: string
): Promise<GoogleTokenRecord | null> {
  const raw = await env.TOKEN_KV.get(tokenKey(userId));
  if (!raw) return null;
  return JSON.parse(raw) as GoogleTokenRecord;
}

export async function getFreshAccessToken(env: Env, userId: string): Promise<string> {
  const record = await getTokenRecord(env, userId);
  if (!record) throw new Error("no Google credentials for user");

  const now = Math.floor(Date.now() / 1000);
  if (record.expiresAt - REFRESH_SKEW_SECONDS > now) return record.accessToken;

  const refreshed = await refreshGoogleToken(env, record.refreshToken);
  const next: GoogleTokenRecord = {
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token ?? record.refreshToken,
    expiresAt: now + refreshed.expires_in,
    scope: refreshed.scope ?? record.scope,
  };
  await putTokenRecord(env, userId, next);
  return next.accessToken;
}

interface RefreshResponse {
  access_token: string;
  expires_in: number;
  scope?: string;
  refresh_token?: string;
  token_type: string;
}

async function refreshGoogleToken(env: Env, refreshToken: string): Promise<RefreshResponse> {
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`google token refresh failed: ${res.status} ${text}`);
  }
  return (await res.json()) as RefreshResponse;
}

export async function exchangeAuthCode(
  env: Env,
  code: string,
  redirectUri: string
): Promise<RefreshResponse> {
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`google code exchange failed: ${res.status} ${text}`);
  }
  return (await res.json()) as RefreshResponse;
}

export interface GoogleUserInfo {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

export async function fetchGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`google userinfo failed: ${res.status} ${text}`);
  }
  return (await res.json()) as GoogleUserInfo;
}
