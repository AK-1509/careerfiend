import { describe, expect, it } from "vitest";
import {
  ALLOWED_CALLS,
  applicationLabel,
  classifyDeterministic,
  GmailProvider,
  matchEmail,
  searchQuery,
  type EmailMeta,
  type TrackedApplication,
} from "../src/index";

const app = (over: Partial<TrackedApplication> = {}): TrackedApplication => ({
  id: "app_a1b2c3d4",
  company: "Beacon Biologics",
  role: "Senior Quality Associate",
  domains: ["beaconbio.com"],
  atsHosts: ["boards.greenhouse.io"],
  atsIdentifiers: {},
  recipient: "me@example.com",
  submittedAt: new Date("2026-09-20T10:00:00Z"),
  threadIds: [],
  ...over,
});
const msg = (over: Partial<EmailMeta> = {}): EmailMeta => ({
  id: "m1",
  threadId: "t1",
  from: "Recruiting <jobs@beaconbio.com>",
  to: "me@example.com",
  subject: "Your application to Beacon Biologics",
  date: new Date("2026-09-21T10:00:00Z"),
  snippet: "Thank you for applying to the Senior Quality Associate role.",
  ...over,
});

describe("email matching", () => {
  it("matches on multiple independent signals", () => {
    const d = matchEmail(msg(), [app()]);
    expect(d.status).toBe("MATCHED");
    expect(d.best!.signals.length).toBeGreaterThanOrEqual(2);
  });
  it("never matches on one keyword alone", () => {
    const d = matchEmail(msg({ from: "news@othersite.com", subject: "Beacon Biologics in the news", snippet: "" }), [app()]);
    expect(d.status).not.toBe("MATCHED");
  });
  it("leaves ambiguous mail between two applications unmatched", () => {
    const d = matchEmail(msg({ snippet: "Thank you for applying.", subject: "Your application to Beacon Biologics" }), [
      app(),
      app({ id: "app_zzz999", role: "QC Analyst" }),
    ]);
    expect(d.status).toBe("UNMATCHED");
  });
  it("ignores mail from before the submission", () => {
    expect(matchEmail(msg({ date: new Date("2026-09-01T00:00:00Z") }), [app()]).status).toBe("IGNORED");
  });
  it("builds a bounded first-sync query", () => {
    const q = searchQuery([app()]);
    expect(q).toMatch(/^after:2026\/9\/19 /);
    expect(q).toContain("beaconbio.com");
  });
});

describe("classification", () => {
  it("classifies the common outcomes", () => {
    expect(
      classifyDeterministic({
        subject: "Update on your application",
        snippet: "Unfortunately, we have decided to move forward with other candidates.",
        from: "x@y.com",
      }).classification,
    ).toBe("rejection");
    expect(classifyDeterministic({ subject: "Interview request", snippet: "Please share your availability.", from: "x@y.com" }).classification).toBe(
      "interview",
    );
    expect(classifyDeterministic({ subject: "Offer", snippet: "We are pleased to extend an offer.", from: "x@y.com" }).classification).toBe("offer");
    expect(classifyDeterministic({ subject: "Thanks", snippet: "We received your application.", from: "x@y.com" }).classification).toBe("confirmation");
    expect(classifyDeterministic({ subject: "Hello", snippet: "Newsletter", from: "x@y.com" }).classification).toBe("other");
  });
});

describe("labels", () => {
  it("uses a stable, sanitized per-application label", () => {
    expect(applicationLabel("Acme / Co", "Product Manager", "app_a1b2c3d4")).toBe("Job Applications/Apps/Acme - Co - Product Manager - A1B2C3");
  });
});

describe("Gmail scope guard", () => {
  const client = { clientId: "id", clientSecret: "secret" };
  const store = {
    load: async () => ({ access_token: "a", refresh_token: "r", expires_at: Date.now() + 1e6, scope: "" }),
    save: async () => undefined,
    clear: async () => undefined,
  };
  const calls: string[] = [];
  const http = async (url: string, init?: { method?: string; body?: string }) => {
    calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    return {
      ok: true,
      status: 200,
      json: async () => ({ labels: [], id: "L1", emailAddress: "me@example.com", historyId: "1", messages: [] }),
      text: async () => "",
    };
  };
  it("only permits read and add-label calls", async () => {
    const g = new GmailProvider(client, store, "label", http);
    for (const bad of [
      ["POST", "/messages/send"],
      ["POST", "/messages/abc/trash"],
      ["POST", "/drafts"],
      ["POST", "/threads/abc/modify"],
      ["GET", "/settings/filters"],
    ] as const) {
      await expect(g.call(bad[0] as "POST", bad[1])).rejects.toThrow(/not permitted/);
    }
    await expect(g.call("POST", "/messages/abc/modify", {}, { removeLabelIds: ["INBOX"] })).rejects.toThrow(/Only addLabelIds/);
    await g.addLabels("abc", ["L1"]);
    expect(calls.at(-1)).toBe("POST /gmail/v1/users/me/messages/abc/modify");
    expect(ALLOWED_CALLS.every((c) => c.method === "GET" || /labels|modify/.test(c.path.source))).toBe(true);
    const provider = GmailProvider.prototype as unknown as Record<string, unknown>;
    for (const m of ["send", "reply", "forward", "delete", "trash", "archive", "markRead"]) expect(provider[m]).toBeUndefined();
  });
  it("read-only mode never writes", async () => {
    const g = new GmailProvider(client, store, "readonly", http);
    const before = calls.length;
    await g.addLabels("abc", ["L1"]);
    expect(calls.length).toBe(before);
    await expect(g.call("POST", "/labels", {}, { name: "x" })).rejects.toThrow(/read-only/);
  });
});
