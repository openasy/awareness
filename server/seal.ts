// Seals a secret with the install's secrets key (ADR 0021), so the SMTP relay password and the Identity viewer token
// can be used again without lying in the database in clear. Without a key, a secret is kept as it is, and main.ts
// warns. The same scheme as every other product's seal (alerts/server/seal.ts).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "v1:";

export function sealer(key: Buffer | undefined) {
  return {
    seal(text: string): string {
      if (!key) return text;
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
    },
    open(sealed: string): string {
      if (!sealed.startsWith(PREFIX)) return sealed;
      if (!key) throw new Error("The secret was sealed with a secrets key, and none is mounted.");
      const raw = Buffer.from(sealed.slice(PREFIX.length), "base64");
      const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    },
    /** Whether a key is mounted, so callers can warn before sealing nothing. */
    get sealing() {
      return key !== undefined;
    },
  };
}

export type Sealer = ReturnType<typeof sealer>;
