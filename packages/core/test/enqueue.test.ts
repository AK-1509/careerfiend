import { describe, expect, it } from "vitest";
import { createLogger, loadConfig } from "@careerfiend/shared";
import { NullProvider } from "@careerfiend/ai";
import { createAppContext, describeEnqueue, enqueueUrls, failedIngest, fail, lease } from "../src/index";
import { tempDir, testDb } from "../../../tests/helpers";

function ctx() {
  const config = loadConfig({ root: tempDir("cf-enq-"), env: { APP_ENCRYPTION_KEY_SOURCE: "env:CF_TEST_KEY", AI_PROVIDER: "none" } });
  return createAppContext({ db: testDb().db, config, ai: new NullProvider(), logger: createLogger({ level: "error" }) });
}

describe("pasting job links", () => {
  it("queues new links, reports duplicates, and refuses boards that forbid automated reading", async () => {
    const c = ctx();
    const first = await enqueueUrls(c, "https://boards.greenhouse.io/acme/jobs/1\nhttps://jobs.lever.co/acme/2, not-a-url");
    expect(first).toMatchObject({ queued: 2, alreadyQueued: [], blocked: [], invalid: ["not-a-url"] });

    const second = await enqueueUrls(
      c,
      [
        "https://boards.greenhouse.io/acme/jobs/1",
        "https://www.linkedin.com/jobs/view/4123456789/",
        "https://app.joinhandshake.com/jobs/11417460",
        "https://www.indeed.com/viewjob?jk=abc",
      ].join("\n"),
    );
    expect(second.queued).toBe(0);
    expect(second.alreadyQueued).toEqual(["https://boards.greenhouse.io/acme/jobs/1"]);
    expect(second.blocked.map((b) => b.board)).toEqual(["LinkedIn", "Handshake", "Indeed"]);
    const msg = describeEnqueue(second);
    expect(msg).toMatch(/^0 links queued\. 1 already waiting in the queue/);
    expect(msg).toMatch(
      /3 not queued \(LinkedIn, Handshake, Indeed\)\. LinkedIn and Indeed links don't work\..*follow it to the employer's application page.*send that link instead/,
    );
    expect(await c.db.workItem.count({ where: { kind: "INGEST_URL" } })).toBe(2);
  });

  it("lists links the worker could not read, with a plain reason for robots.txt refusals", async () => {
    const c = ctx();
    await enqueueUrls(c, "https://careers.example.com/job/9");
    const item = (await lease(c.db, "w", ["INGEST_URL"], new Date()))!;
    await fail(c.db, item.id, "robots.txt at careers.example.com disallows /job/9.", false, new Date());
    const rows = await failedIngest(c);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.url).toBe("https://careers.example.com/job/9");
    expect(rows[0]!.reason).toMatch(/forbids automated reading.*employer's own Apply link/);
  });
});
