import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { CareerFiendError } from "./errors";

/**
 * At-rest encryption for OAuth tokens and sensitive local fields.
 * AES-256-GCM. The key never lives in the database:
 *   - "keychain": macOS Keychain (`security`) or Linux Secret Service (`secret-tool`);
 *   - an absolute file path outside the repo (created with 0600 if missing);
 *   - "env:NAME": a base64 key in an environment variable (tests/CI only).
 */

const SERVICE = "CareerFiend";
const ACCOUNT = "app-encryption-key";

let cachedKey: { source: string; key: Buffer } | undefined;

function newKey(): Buffer {
  return randomBytes(32);
}

function fromKeychain(): Buffer {
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      try {
        const out = execFileSync("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"], {
          stdio: ["ignore", "pipe", "ignore"],
        })
          .toString()
          .trim();
        if (out) return Buffer.from(out, "base64");
      } catch {
        /* not found: create */
      }
      const key = newKey();
      execFileSync("security", ["add-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w", key.toString("base64"), "-U"], {
        stdio: "ignore",
      });
      return key;
    }
    if (platform === "linux") {
      try {
        const out = execFileSync("secret-tool", ["lookup", "service", SERVICE, "account", ACCOUNT], {
          stdio: ["ignore", "pipe", "ignore"],
        })
          .toString()
          .trim();
        if (out) return Buffer.from(out, "base64");
      } catch {
        /* not found: create */
      }
      const key = newKey();
      execFileSync("secret-tool", ["store", "--label", "CareerFiend app key", "service", SERVICE, "account", ACCOUNT], {
        input: key.toString("base64"),
        stdio: ["pipe", "ignore", "ignore"],
      });
      return key;
    }
  } catch (err) {
    throw new CareerFiendError(
      "FATAL_CONFIGURATION",
      "Could not read or create the encryption key in the OS keychain. Set APP_ENCRYPTION_KEY_SOURCE to an absolute file path outside the repo.",
      { cause: err },
    );
  }
  throw new CareerFiendError(
    "FATAL_CONFIGURATION",
    `APP_ENCRYPTION_KEY_SOURCE=keychain is not supported on ${platform}. Use an absolute file path outside the repo.`,
  );
}

function fromFile(file: string, repoRoot?: string): Buffer {
  if (!path.isAbsolute(file)) {
    throw new CareerFiendError("FATAL_CONFIGURATION", "APP_ENCRYPTION_KEY_SOURCE file path must be absolute.");
  }
  if (repoRoot && path.resolve(file).startsWith(path.resolve(repoRoot) + path.sep)) {
    throw new CareerFiendError("FATAL_CONFIGURATION", "The encryption key file must live outside the repository.");
  }
  if (existsSync(file)) return Buffer.from(readFileSync(file, "utf8").trim(), "base64");
  mkdirSync(path.dirname(file), { recursive: true });
  const key = newKey();
  writeFileSync(file, key.toString("base64"), { mode: 0o600 });
  chmodSync(file, 0o600);
  return key;
}

export function resolveKey(source: string, repoRoot?: string, env: Record<string, string | undefined> = process.env): Buffer {
  if (cachedKey && cachedKey.source === source) return cachedKey.key;
  let key: Buffer;
  if (source === "keychain") key = fromKeychain();
  else if (source.startsWith("env:")) {
    const v = env[source.slice(4)];
    if (!v) throw new CareerFiendError("FATAL_CONFIGURATION", `Environment variable ${source.slice(4)} is not set.`);
    key = Buffer.from(v, "base64");
  } else key = fromFile(source, repoRoot);
  if (key.length !== 32) throw new CareerFiendError("FATAL_CONFIGURATION", "Encryption key must be 32 bytes (base64).");
  cachedKey = { source, key };
  return key;
}

const PREFIX = "enc:v1:";

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, body]).toString("base64");
}

export function decrypt(ciphertext: string, key: Buffer): string {
  if (!ciphertext.startsWith(PREFIX)) throw new Error("Not an encrypted value");
  const raw = Buffer.from(ciphertext.slice(PREFIX.length), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const body = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

export function isEncrypted(value: string | null | undefined): boolean {
  return !!value && value.startsWith(PREFIX);
}
