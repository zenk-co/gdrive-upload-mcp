const encoder = new TextEncoder();

export interface UploadJwtClaims {
  iss: "upload-mcp";
  aud: "upload-app";
  sub: string;
  uploadId: string;
  filename: string;
  maxSize: number;
  contentType: string;
  sha256?: string;
  iat: number;
  exp: number;
}

function b64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlDecode(input: string): Uint8Array {
  const pad = input.length % 4 === 2 ? "==" : input.length % 4 === 3 ? "=" : "";
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function signUploadJwt(claims: UploadJwtClaims, secret: string): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const headerPart = b64urlEncode(encoder.encode(JSON.stringify(header)));
  const payloadPart = b64urlEncode(encoder.encode(JSON.stringify(claims)));
  const data = `${headerPart}.${payloadPart}`;
  const key = await importHmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
  return `${data}.${b64urlEncode(sig)}`;
}

export async function verifyUploadJwt(
  token: string,
  secret: string
): Promise<UploadJwtClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed JWT");
  const [headerPart, payloadPart, sigPart] = parts as [string, string, string];
  const key = await importHmacKey(secret);
  const sig = b64urlDecode(sigPart);
  const data = encoder.encode(`${headerPart}.${payloadPart}`);
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    sig.buffer.slice(sig.byteOffset, sig.byteOffset + sig.byteLength) as ArrayBuffer,
    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  );
  if (!ok) throw new Error("invalid signature");

  const headerJson = JSON.parse(new TextDecoder().decode(b64urlDecode(headerPart)));
  if (headerJson.alg !== "HS256") throw new Error("unsupported alg");

  const claims = JSON.parse(
    new TextDecoder().decode(b64urlDecode(payloadPart))
  ) as UploadJwtClaims;

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= now) throw new Error("token expired");
  if (claims.iss !== "upload-mcp" || claims.aud !== "upload-app") {
    throw new Error("invalid iss/aud");
  }
  return claims;
}
