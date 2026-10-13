import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  APPLICATION_STATES,
  TRANSITIONS,
  assertTransition,
  canTransition,
  canonicalJson,
  createLogger,
  decrypt,
  encrypt,
  hashObject,
  normalizeLabel,
  parseEnvFile,
  containsTerm,
  slugify,
  hashPasscode,
  verifyPasscode,
  signSession,
  readSession,
  sessionMatchesPassword,
  assertPublicUrl,
  isPrivateAddress,
  safeNextPath,
  loadConfig,
} from "../src/index";

describe("state machine", () => {
  it("allows the documented happy path", () => {
    const path = [
      "QUEUED",
      "READING_JOB",
      "GENERATING_DOCUMENTS",
      "FILLING",
      "READY_FOR_REVIEW",
      "APPROVED",
      "SUBMITTING",
      "SUBMITTED",
      "CONFIRMATION_RECEIVED",
      "RESPONDED",
      "INTERVIEW",
      "OFFER",
      "CLOSED",
    ] as const;
    for (let i = 1; i < path.length; i++) expect(() => assertTransition(path[i - 1]!, path[i]!)).not.toThrow();
  });

  it("rejects impossible transitions", () => {
    expect(canTransition("QUEUED", "SUBMITTING")).toBe(false);
    expect(canTransition("READY_FOR_REVIEW", "SUBMITTING")).toBe(false);
    expect(canTransition("NEEDS_INPUT", "APPROVED")).toBe(false);
    expect(canTransition("SUBMISSION_UNCERTAIN", "SUBMITTING")).toBe(false);
    expect(canTransition("SUBMITTED", "SUBMITTING")).toBe(false);
    expect(canTransition("REJECTED", "QUEUED")).toBe(false);
    expect(() => assertTransition("FILLING", "SUBMITTED")).toThrow(/Invalid application transition/);
  });

  it("only APPROVED can reach SUBMITTING", () => {
    for (const s of APPLICATION_STATES) {
      if (TRANSITIONS[s].includes("SUBMITTING")) expect(s).toBe("APPROVED");
    }
  });
});

describe("hashing", () => {
  it("canonical JSON ignores key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    expect(hashObject({ x: [1, 2] })).not.toBe(hashObject({ x: [2, 1] }));
  });
});

describe("text", () => {
  it("normalizes labels for de-duplication", () => {
    expect(normalizeLabel("Node.js")).toBe(normalizeLabel("node js"));
    expect(normalizeLabel("C++")).not.toBe(normalizeLabel("C"));
    expect(slugify("Northwind Traders / Corporate Training")).toBe("northwind-traders-corporate-training");
  });
  it("matches whole terms only", () => {
    expect(containsTerm("Experience with R and Python", "R")).toBe(true);
    expect(containsTerm("Strong reporting", "R")).toBe(false);
    expect(containsTerm("C++ required", "C++")).toBe(true);
  });
  it("parses env files", () => {
    expect(parseEnvFile('# c\nA=1\nB="two"\n\nC=')).toEqual({ A: "1", B: "two", C: "" });
  });
});

// Fake credentials are assembled at runtime so the pre-commit secret scan stays strict.
const FAKE_GOOGLE = ["ya29", "a0AfH6SMBxyz"].join(".");

describe("logger redaction", () => {
  it("redacts personal data and credentials", () => {
    const lines: string[] = [];
    const log = createLogger({ sink: (l) => lines.push(l), level: "debug" });
    log.info("test.event", {
      applicationId: "app_1",
      email: "someone@example.com",
      note: "call me at (213) 555-0100 or mail someone@example.com",
      headers: { authorization: "Bearer abc.def", cookie: "sid=123" },
      accessToken: "ya29.secret",
      answers: { salary: "100000" },
      coverLetter: "Dear hiring manager ...",
      message: `token ${FAKE_GOOGLE} and sk-ant-abc123`,
    });
    const out = lines.join("\n");
    expect(out).toContain("app_1");
    for (const secret of ["someone@example.com", "555-0100", "abc.def", "sid=123", "ya29.secret", "100000", "Dear hiring", FAKE_GOOGLE, "sk-ant-abc123"]) {
      expect(out).not.toContain(secret);
    }
  });
});

describe("encryption", () => {
  it("round-trips and detects tampering", () => {
    const key = randomBytes(32);
    const c = encrypt("refresh-token-value", key);
    expect(c).not.toContain("refresh-token-value");
    expect(decrypt(c, key)).toBe("refresh-token-value");
    const tampered = c.slice(0, -4) + (c.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(() => decrypt(tampered, key)).toThrow();
  });
});

describe("dashboard login", () => {
  it("hashes passcodes with scrypt and verifies only the right one", () => {
    const h = hashPasscode("correct horse battery");
    expect(h).toMatch(/^scrypt:32768:8:1:/);
    expect(h).not.toContain("$");
    expect(verifyPasscode("correct horse battery", h)).toBe(true);
    expect(verifyPasscode("correct horse batterY", h)).toBe(false);
    expect(verifyPasscode("x", "garbage")).toBe(false);
    expect(() => hashPasscode("short")).toThrow(/at least 10/);
  });

  it("session cookies name the account, are signed, expire, and die when the password changes", () => {
    const secret = randomBytes(32).toString("base64");
    const h = hashPasscode("correct horse battery");
    const now = Date.now();
    const tok = signSession(secret, "a_0123abcd", h, now);
    const s = readSession(tok, secret, now);
    expect(s?.accountId).toBe("a_0123abcd");
    expect(sessionMatchesPassword(s!.fingerprint, h)).toBe(true);
    expect(sessionMatchesPassword(s!.fingerprint, hashPasscode("another password"))).toBe(false);
    expect(readSession(tok, secret, now + 15 * 86_400_000)).toBeNull();
    expect(
      readSession(
        tok.replace(/.$/, (c) => (c === "A" ? "B" : "A")),
        secret,
        now,
      ),
    ).toBeNull();
    expect(readSession(tok.replace("a_0123abcd", "a_9999abcd"), secret, now)).toBeNull();
    expect(readSession(tok, randomBytes(32).toString("base64"), now)).toBeNull();
    expect(readSession(undefined, secret, now)).toBeNull();
  });

  it("outbound requests only go to public addresses", async () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "::ffff:10.0.0.1"])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
    const resolve = async (h: string) => (h === "internal.example.com" ? ["10.0.0.5"] : ["93.184.215.14"]);
    await expect(assertPublicUrl("http://169.254.169.254/latest/meta-data", { resolve })).rejects.toThrow(/not a public address/);
    await expect(assertPublicUrl("https://internal.example.com/x", { resolve })).rejects.toThrow(/not a public address/);
    await expect(assertPublicUrl("http://localhost:3000/", { resolve })).rejects.toThrow(/not a public address/);
    await expect(assertPublicUrl("file:///etc/passwd", { resolve })).rejects.toThrow(/http and https/);
    await expect(assertPublicUrl("https://user:pw@example.com/", { resolve })).rejects.toThrow(/user name/);
    expect((await assertPublicUrl("https://boards.example.com/jobs/1", { resolve })).hostname).toBe("boards.example.com");
    expect((await assertPublicUrl("http://localhost:11434/v1", { resolve, allowLocalhost: true })).port).toBe("11434");
  });

  it("only returns to same-site paths after login", () => {
    expect(safeNextPath("/applications/app_1?x=1")).toBe("/applications/app_1?x=1");
    for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "", null]) expect(safeNextPath(bad)).toBe("/");
  });

  it("hosted mode requires a Postgres URL and keeps files off the repo; public defaults are safe", () => {
    expect(() => loadConfig({ root: "/nonexistent", env: { CAREERFIEND_MODE: "hosted" } })).toThrow(/DATABASE_URL/);
    const c = loadConfig({ root: "/nonexistent", env: { CAREERFIEND_MODE: "hosted", DATABASE_URL: "postgresql://u@db.example/x" } });
    expect(c.FORM_FILLING).toBe("off");
    expect(c.SIGNUPS_OPEN).toBe("true");
    expect(c.MAX_UPLOAD_MB).toBeLessThanOrEqual(4.5);
    expect(c.paths.privateDir).not.toContain("/nonexistent");
    const v = loadConfig({
      root: "/nonexistent",
      env: { CAREERFIEND_MODE: "hosted", DATABASE_URL: "postgres://x/y", VERCEL_PROJECT_PRODUCTION_URL: "careerfiend.vercel.app" },
    });
    expect(v.PUBLIC_URL).toBe("https://careerfiend.vercel.app");
  });
});
