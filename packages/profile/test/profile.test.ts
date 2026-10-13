import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkEvidence,
  decideSkill,
  extractFacts,
  getUsableProfileValue,
  importAnswers,
  importChecklist,
  importInventory,
  ingestResume,
  loadInventoryFile,
  parseAnswers,
  parseChecklist,
  renderChecklist,
  listSkills,
  unsureSkillIds,
} from "../src/index";
import {
  ANSWERS_TEMPLATE,
  KIT_CHECKLIST,
  KIT_INVENTORY,
  commitResume,
  dumpDatabase,
  makeResumeRepo,
  readResumeSource,
  testDb,
  testKey,
} from "../../../tests/helpers";

describe("resume source (D1)", () => {
  it("pins a résumé version and records version + sha256", () => {
    const repo = makeResumeRepo();
    const src = readResumeSource(repo.dir);
    expect(src.commit).toBe("v1");
    expect(src.checksum).toBe(`v1:${src.fileSha256}`);
    expect(src.workingTreeDiffers).toBe(false);
    expect(commitResume(repo.dir, src.rawText.replace("Quality Intern", "Quality Lead"))).toBe("v2");
    expect(readResumeSource(repo.dir).resume.experiences.some((e) => e.title === "Quality Lead")).toBe(true);
  });

  it("parsing the same commit twice produces identical fact ids", async () => {
    const repo = makeResumeRepo();
    const a = extractFacts(readResumeSource(repo.dir).resume, readResumeSource(repo.dir).checksum);
    const b = extractFacts(readResumeSource(repo.dir).resume, readResumeSource(repo.dir).checksum);
    expect(a.map((f) => f.id)).toEqual(b.map((f) => f.id));
    const { db } = testDb();
    const r1 = await ingestResume(db, readResumeSource(repo.dir));
    const ids1 = (await db.experienceFact.findMany({ orderBy: { ordinal: "asc" } })).map((f) => f.id);
    const r2 = await ingestResume(db, readResumeSource(repo.dir));
    const ids2 = (await db.experienceFact.findMany({ orderBy: { ordinal: "asc" } })).map((f) => f.id);
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(false);
    expect(r2.version).toBe(1);
    expect(ids2).toEqual(ids1);
  });

  it("uses the D1 provenance key format", () => {
    const repo = makeResumeRepo();
    const facts = extractFacts(readResumeSource(repo.dir).resume, "x");
    const keys = facts.map((f) => f.key);
    expect(keys).toContain("experiences[acme-bio-quality-intern].responsibilities[0]");
    expect(keys).toContain("experiences[acme-bio-quality-intern].summary");
    expect(keys).toContain("profile.headline");
    expect(keys).toContain("languages");
    expect(facts.find((f) => f.key === "experiences[acme-bio-quality-intern].responsibilities[1]")?.text).toBe(
      "Prepared and reviewed batch-manufacturing records.",
    );
  });

  it("re-ingests a changed HEAD as a new version", async () => {
    const repo = makeResumeRepo();
    const { db } = testDb();
    await ingestResume(db, readResumeSource(repo.dir));
    const raw = readResumeSource(repo.dir).rawText;
    commitResume(repo.dir, raw.replace("12 batches", "14 batches"));
    const r = await ingestResume(db, readResumeSource(repo.dir));
    expect(r.version).toBe(2);
    const docs = await db.sourceDocument.findMany({ orderBy: { version: "asc" } });
    expect(docs.map((d) => d.isCurrent)).toEqual([false, true]);
  });
});

describe("nothing leaks between imports", () => {
  it("only résumé facts, inventory and answers are stored; every evidence key of the kit resolves in the fixture", async () => {
    const repo = makeResumeRepo();
    const src = readResumeSource(repo.dir);
    const { db } = testDb();
    await ingestResume(db, src);
    await importInventory(db, loadInventoryFile(KIT_INVENTORY));
    await importAnswers(db, "- Phone: 555\n", testKey());
    const dump = await dumpDatabase(db);
    expect(dump).toContain("Acme Bio");
    expect(checkEvidence(loadInventoryFile(KIT_INVENTORY), src.resume)).toEqual([]);
  });
});

describe("skills inventory (D4)", () => {
  it("imports the kit inventory: 63 verified, 54 unverified", async () => {
    const { db } = testDb();
    const r = await importInventory(db, loadInventoryFile(KIT_INVENTORY));
    expect(r.inserted).toBe(117);
    const skills = await listSkills(db);
    expect(skills.filter((s) => s.status === "VERIFIED_FROM_SOURCE")).toHaveLength(63);
    expect(skills.filter((s) => s.status === "UNVERIFIED")).toHaveLength(54);
  });

  it("never promotes an UNVERIFIED skill without a user action", async () => {
    const { db } = testDb();
    const inv = loadInventoryFile(KIT_INVENTORY);
    await importInventory(db, inv);
    // Re-importing the same file changes nothing.
    await importInventory(db, inv);
    expect((await db.skill.findUnique({ where: { id: "microsoft-excel" } }))?.status).toBe("UNVERIFIED");
    // A file that claims a user decision is not applied; it is reported as pending.
    const tampered = structuredClone(inv);
    tampered.skills.find((s) => s.id === "microsoft-excel")!.status = "CONFIRMED_BY_USER";
    expect((await importInventory(db, tampered)).pendingUserDecisions).toEqual(["microsoft-excel"]);
    expect((await db.skill.findUnique({ where: { id: "microsoft-excel" } }))?.status).toBe("UNVERIFIED");
    // A non-user actor cannot decide.
    await expect(decideSkill(db, "microsoft-excel", "CONFIRMED_BY_USER", "system:x" as `user:${string}`, "")).rejects.toThrow();
    // Verified skills cannot be changed at all.
    await expect(decideSkill(db, "python", "REJECTED_BY_USER", "user:dashboard", "")).rejects.toThrow(/verified/);
    // A user action does promote, with an audit event.
    await decideSkill(db, "microsoft-excel", "CONFIRMED_BY_USER", "user:dashboard", "clicked confirm");
    expect((await db.skill.findUnique({ where: { id: "microsoft-excel" } }))?.status).toBe("CONFIRMED_BY_USER");
    const events = await db.skillStatusEvent.findMany({ where: { skillId: "microsoft-excel" } });
    expect(events.some((e) => e.actor === "user:dashboard" && e.to === "CONFIRMED_BY_USER")).toBe(true);
    // Re-importing the file does not undo the user decision.
    await importInventory(db, inv);
    expect((await db.skill.findUnique({ where: { id: "microsoft-excel" } }))?.status).toBe("CONFIRMED_BY_USER");
  });

  it("imports checklist ticks: [x] confirms, ? stays unverified, blank rejects", async () => {
    const { db } = testDb();
    await importInventory(db, loadInventoryFile(KIT_INVENTORY));
    const md = readFileSync(KIT_CHECKLIST, "utf8");
    expect(parseChecklist(md)).toHaveLength(54);
    await expect(importChecklist(db, md)).rejects.toThrow(/looks unreviewed/);
    const edited = md
      .replace("- [ ] Microsoft Word <!-- microsoft-word -->", "- [x] Microsoft Word <!-- microsoft-word -->")
      .replace(/(- \[ \] Microsoft Excel <!-- microsoft-excel -->.*)$/m, "$1 ?");
    const r = await importChecklist(db, edited);
    expect(r.confirmed).toEqual(["microsoft-word"]);
    expect(r.unsure).toEqual(["microsoft-excel"]);
    expect(r.rejected).toHaveLength(52);
    expect((await db.skill.findUnique({ where: { id: "microsoft-excel" } }))?.status).toBe("UNVERIFIED");
    expect((await db.skill.findUnique({ where: { id: "adobe-xd" } }))?.status).toBe("REJECTED_BY_USER");
    // Re-rendering keeps the decisions, and re-importing the rendered file is idempotent.
    const rendered = renderChecklist(await listSkills(db), await unsureSkillIds(db));
    expect(rendered).toMatch(/- \[x\] Microsoft Word <!-- microsoft-word -->/);
    expect(rendered).toMatch(/Microsoft Excel <!-- microsoft-excel -->.* \?$/m);
    const again = await importChecklist(db, rendered);
    expect(again.confirmed).toEqual(["microsoft-word"]);
    expect(again.unsure).toEqual(["microsoft-excel"]);
  });
});

describe("user decisions travel only through the checklist (D4)", () => {
  it("a fresh database applies recorded decisions only via the ticked checklist", async () => {
    const { db } = testDb();
    const inv = loadInventoryFile(KIT_INVENTORY);
    const decided = structuredClone(inv);
    decided.skills.find((s) => s.id === "microsoft-word")!.status = "CONFIRMED_BY_USER";
    decided.skills.find((s) => s.id === "adobe-xd")!.status = "REJECTED_BY_USER";
    const r = await importInventory(db, decided);
    expect(r.pendingUserDecisions.sort()).toEqual(["adobe-xd", "microsoft-word"]);
    expect((await db.skill.findUniqueOrThrow({ where: { id: "microsoft-word" } })).status).toBe("UNVERIFIED");
    const md = readFileSync(KIT_CHECKLIST, "utf8").replace("- [ ] Microsoft Word <!-- microsoft-word -->", "- [x] Microsoft Word <!-- microsoft-word -->");
    await importChecklist(db, md);
    expect((await db.skill.findUniqueOrThrow({ where: { id: "microsoft-word" } })).status).toBe("CONFIRMED_BY_USER");
    expect((await db.skill.findUniqueOrThrow({ where: { id: "adobe-xd" } })).status).toBe("REJECTED_BY_USER");
    const ev = await db.skillStatusEvent.findMany({ where: { skillId: "microsoft-word", to: "CONFIRMED_BY_USER" } });
    expect(ev.map((e) => e.actor)).toEqual(["user:checklist"]);
  });
});

describe("answers-later (Phase 3 inputs)", () => {
  it("filled lines become CONFIRMED_BY_USER; blanks stay UNVERIFIED and are never used", async () => {
    const md = readFileSync(ANSWERS_TEMPLATE, "utf8")
      .replace("- Phone:", "- Phone: (213) 555-0100")
      .replace("- Work authorization in the US:", "- Work authorization in the US: Yes");
    const parsed = parseAnswers(md);
    expect(parsed.find((p) => p.spec.key === "contact.phone")?.value).toBe("(213) 555-0100");
    expect(parsed.find((p) => p.spec.key === "contact.portfolio")?.value).toBeNull();
    const { db } = testDb();
    const key = testKey();
    const r = await importAnswers(db, md, key);
    expect(r.confirmed.sort()).toEqual(["contact.phone", "work.authorization"]);
    expect(await getUsableProfileValue(db, "contact.phone", key)).toBe("(213) 555-0100");
    expect(await getUsableProfileValue(db, "work.sponsorship", key)).toBeNull();
    const auth = await db.profileValue.findUnique({ where: { key: "work.authorization" } });
    expect(auth?.value).not.toBe("Yes"); // sensitive → encrypted at rest
    expect(await getUsableProfileValue(db, "work.authorization", key)).toBe("Yes");
  });
});
