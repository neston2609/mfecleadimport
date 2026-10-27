import crypto from "node:crypto";

const algorithm = "aes-256-gcm";

function getKey(): Buffer {
  const seed = process.env.APP_SECRET || "local-development-secret-change-me";
  return crypto.createHash("sha256").update(seed).digest();
}

export function encryptSecret(secret: string): string {
  if (!secret) {
    return "";
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(algorithm, getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decryptSecret(payload: string): string {
  if (!payload) {
    return "";
  }
  const buffer = Buffer.from(payload, "base64");
  const iv = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const encrypted = buffer.subarray(28);
  const decipher = crypto.createDecipheriv(algorithm, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    "utf8",
  );
}
