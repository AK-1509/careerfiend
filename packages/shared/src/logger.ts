/**
 * Structured JSON logger with redaction on by default.
 *
 * Rules (BUILD-GUIDE "Observability and privacy"):
 * - keys that name personal or credential data are replaced with "[REDACTED]";
 * - free-text values are scanned for emails, phone numbers, bearer tokens and
 *   cookie headers, which are masked;
 * - long strings (document text) are truncated to their length only.
 */

const SENSITIVE_KEY =
  /(pass(word)?|secret|token|cookie|authorization|auth|api[-_]?key|credential|session|name|email|phone|address|answer|value|resume|coverletter|cover_letter|body|text|content|snippet|demographic|gender|race|ethnicity|veteran|disability|salary|compensation|ssn|dob|birth)/i;

/** Keys that look sensitive by the pattern above but are safe identifiers. */
const SAFE_KEYS = new Set([
  "event",
  "applicationId",
  "jobId",
  "revisionId",
  "revisionHash",
  "workItemId",
  "kind",
  "state",
  "from",
  "to",
  "category",
  "errorCategory",
  "durationMs",
  "step",
  "semanticType",
  "fieldKey",
  "count",
  "status",
  "level",
  "ts",
  "attempt",
  "labelName",
  "classification",
  "confidence",
  "url",
  "host",
  "stateName",
]);

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const TOKENISH_RE = /\b(ya29\.[A-Za-z0-9._-]+|sk-ant-[A-Za-z0-9_-]+|1\/\/[A-Za-z0-9_-]{20,})/g;
const COOKIE_RE = /\b(cookie|set-cookie)\s*[:=]\s*[^;\n]+/gi;
const MAX_STRING = 300;

export function redactString(input: string): string {
  let out = input
    .replace(BEARER_RE, "$1 [REDACTED]")
    .replace(TOKENISH_RE, "[REDACTED_TOKEN]")
    .replace(COOKIE_RE, "$1: [REDACTED]")
    .replace(EMAIL_RE, "[EMAIL]")
    .replace(PHONE_RE, "[PHONE]");
  if (out.length > MAX_STRING) out = `[TEXT ${out.length} chars]`;
  return out;
}

export function redact(value: unknown, key?: string, depth = 0): unknown {
  if (depth > 6) return "[DEPTH]";
  if (key && !SAFE_KEYS.has(key) && SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, undefined, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, k, depth + 1);
    return out;
  }
  return value;
}

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export type LogSink = (line: string) => void;

export function createLogger(opts: { level?: LogLevel; sink?: LogSink; base?: Record<string, unknown>; redaction?: boolean } = {}): Logger {
  const level = opts.level ?? ((process.env.LOG_LEVEL as LogLevel | undefined) || "info");
  const sink: LogSink = opts.sink ?? ((line) => process.stderr.write(line + "\n"));
  const base = opts.base ?? {};
  const redaction = opts.redaction ?? process.env.LOG_REDACTION !== "off";
  const emit = (lvl: LogLevel, event: string, fields: Record<string, unknown> = {}) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const record = { ts: new Date().toISOString(), level: lvl, event, ...base, ...fields };
    sink(JSON.stringify(redaction ? redact(record) : record));
  };
  return {
    debug: (e, f) => emit("debug", e, f),
    info: (e, f) => emit("info", e, f),
    warn: (e, f) => emit("warn", e, f),
    error: (e, f) => emit("error", e, f),
    child: (fields) => createLogger({ level, sink, base: { ...base, ...fields }, redaction }),
  };
}

export const logger = createLogger();
