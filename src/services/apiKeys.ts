import { createHash, randomBytes } from "node:crypto";

export function generateApiKey(): string {
  return "mk_" + randomBytes(24).toString("hex");
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
