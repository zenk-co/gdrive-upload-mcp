import { describe, test, expect } from "vitest";
import { signUploadJwt, verifyUploadJwt, type UploadJwtClaims } from "../src/jwt";

const SECRET = "test-secret-key-of-sufficient-length-for-hmac";

function baseClaims(overrides: Partial<UploadJwtClaims> = {}): UploadJwtClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "upload-mcp",
    aud: "upload-app",
    sub: "user-123",
    uploadId: "11111111-1111-1111-1111-111111111111",
    filename: "file.bin",
    maxSize: 1024,
    contentType: "application/octet-stream",
    iat: now,
    exp: now + 60,
    ...overrides,
  };
}

describe("jwt sign/verify", () => {
  test("roundtrip preserves claims", async () => {
    const claims = baseClaims({ sha256: "a".repeat(64) });
    const token = await signUploadJwt(claims, SECRET);
    const verified = await verifyUploadJwt(token, SECRET);
    expect(verified).toMatchObject(claims);
  });

  test("rejects expired token", async () => {
    const claims = baseClaims({ exp: Math.floor(Date.now() / 1000) - 1 });
    const token = await signUploadJwt(claims, SECRET);
    await expect(verifyUploadJwt(token, SECRET)).rejects.toThrow(/expired/);
  });

  test("rejects wrong signing secret", async () => {
    const token = await signUploadJwt(baseClaims(), SECRET);
    await expect(verifyUploadJwt(token, "different-secret")).rejects.toThrow(/signature/);
  });

  test("rejects tampered payload", async () => {
    const token = await signUploadJwt(baseClaims(), SECRET);
    const [h, _p, s] = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...baseClaims(), sub: "attacker" })
    ).toString("base64url");
    const tampered = `${h}.${tamperedPayload}.${s}`;
    await expect(verifyUploadJwt(tampered, SECRET)).rejects.toThrow(/signature/);
  });

  test("rejects wrong iss", async () => {
    const token = await signUploadJwt(
      baseClaims({ iss: "evil" as unknown as "upload-mcp" }),
      SECRET
    );
    await expect(verifyUploadJwt(token, SECRET)).rejects.toThrow(/iss\/aud/);
  });

  test("rejects wrong aud", async () => {
    const token = await signUploadJwt(
      baseClaims({ aud: "other" as unknown as "upload-app" }),
      SECRET
    );
    await expect(verifyUploadJwt(token, SECRET)).rejects.toThrow(/iss\/aud/);
  });

  test("rejects alg=none header", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify(baseClaims())).toString("base64url");
    const noneToken = `${header}.${payload}.`;
    await expect(verifyUploadJwt(noneToken, SECRET)).rejects.toThrow();
  });

  test("rejects malformed token", async () => {
    await expect(verifyUploadJwt("not-a-jwt", SECRET)).rejects.toThrow(/malformed/);
    await expect(verifyUploadJwt("a.b", SECRET)).rejects.toThrow(/malformed/);
  });
});
