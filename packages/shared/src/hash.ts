import { createHash, randomBytes } from "node:crypto";

export function sha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Deterministic JSON: object keys sorted recursively, `undefined` dropped.
 * Used for every hash that must be reproducible (revision hash, fact ids).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortDeep(v);
    }
    return out;
  }
  if (value instanceof Date) return value.toISOString();
  return value;
}

export function hashObject(value: unknown): string {
  return sha256(canonicalJson(value));
}

/** Short, stable id derived from content. */
export function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${sha256(parts.join("\u0000")).slice(0, 16)}`;
}

export function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}
