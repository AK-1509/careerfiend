import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { InventorySkill } from "@careerfiend/shared";
import { loadInventoryFile, resumeStringCorpus, type ResumeSource } from "@careerfiend/profile";
import { parseListingHtml } from "@careerfiend/job-parser";
import { matchJob } from "@careerfiend/matcher";
import type { AiProvider, CoverLetterDraft } from "@careerfiend/ai";
import { NullProvider } from "@careerfiend/ai";
import {
  buildResume,
  checkVerbatim,
  fallbackLetter,
  generateCoverLetter,
  lineText,
  pdfText,
  validateSentences,
  validateUserLetter,
  type FallbackBullet,
} from "../src/index";
import { KIT_INVENTORY, makeResumeRepo, readResumeSource, REPO_ROOT } from "../../../tests/helpers";

const skills = (): InventorySkill[] => structuredClone(loadInventoryFile(KIT_INVENTORY).skills);
const job = (name: string) =>
  parseListingHtml(readFileSync(path.join(REPO_ROOT, "fixtures/listings", name), "utf8"), `http://localhost:4545/listings/${name}`, "fixture").job;

const sources: [string, () => ResumeSource][] = [["fixture resume", () => readResumeSource(makeResumeRepo().dir)]];

describe.each(sources)("verbatim résumé (D2): %s", (_name, load) => {
  it("every line is verbatim, fits one page, keeps Education", async () => {
    const src = load();
    const j = job("senior-title-entry-description.html");
    const m = matchJob(j, skills(), { degreeLevel: "bachelor" });
    const build = await buildResume({ resume: src.resume, rawText: src.rawText, results: m.results, jobText: j.description, pageLimit: 1 });
    expect(build.pages).toBe(1);
    expect(checkVerbatim(build.lines, resumeStringCorpus(src.rawText), src.resume)).toEqual([]);
    // D2 regression test: every bullet, the headline and every content span is an exact substring of the pinned file.
    const corpus = resumeStringCorpus(src.rawText);
    for (const line of build.lines) {
      if (line.style === "bullet" || line.style === "headline" || line.style === "name") {
        expect(
          corpus.some((s) => s.includes(lineText(line))),
          lineText(line),
        ).toBe(true);
      }
      for (const span of line.spans.filter((s) => s.kind === "content")) {
        expect(src.rawText.includes(JSON.stringify(span.text).slice(1, -1)) || corpus.some((s) => s.includes(span.text)), span.text).toBe(true);
      }
    }
    const educationIds = src.resume.experiences.filter((e) => e.type === "education").map((e) => e.id);
    expect(build.selection.education.map((e) => e.experience.id)).toEqual(educationIds);
    const { text, pages } = await pdfText(build.pdf);
    expect(pages).toBe(1);
    expect(text).toContain(src.resume.profile.name);
    // The headline is verbatim profile.headline.
    expect(build.lines.find((l) => l.style === "headline")!.spans[0]!.text).toBe(src.resume.profile.headline);
  });

  it("drops lowest-ranked bullets first, then entries, never Education", async () => {
    const src = load();
    // Make the resume far too long for one page by repeating bullets.
    const long = structuredClone(src.resume);
    for (const e of long.experiences) if (e.type !== "education") e.responsibilities = Array.from({ length: 8 }, () => e.responsibilities).flat();
    const raw = JSON.stringify(long);
    const j = job("senior-title-entry-description.html");
    const m = matchJob(j, skills(), { degreeLevel: "bachelor" });
    const build = await buildResume({ resume: long, rawText: raw, results: m.results, jobText: j.description, pageLimit: 1 });
    expect(build.pages).toBe(1);
    expect(build.selection.dropped.length).toBeGreaterThan(0);
    expect(build.selection.education.length).toBe(long.experiences.filter((e) => e.type === "education").length);
    expect(build.selection.dropped[0]!.reason).toMatch(/bullet/);
  });
});

describe("verbatim checker catches edits", () => {
  it("flags a rephrased bullet or an inserted keyword", async () => {
    const src = readResumeSource(makeResumeRepo().dir);
    const j = job("unknown-skill.html");
    const m = matchJob(j, skills(), { degreeLevel: "bachelor" });
    const build = await buildResume({ resume: src.resume, rawText: src.rawText, results: m.results, jobText: j.description, pageLimit: 1 });
    const bullet = build.lines.find((l) => l.style === "bullet")!;
    bullet.spans[0]!.text = `${bullet.spans[0]!.text} using Veeva Vault`;
    const problems = checkVerbatim(build.lines, resumeStringCorpus(src.rawText), src.resume);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.problem).toMatch(/not found verbatim/);
  });
});

describe("cover letter (D3)", () => {
  const allowed = new Map([
    ["experiences[a].responsibilities[0]", "Ran quality-control tests with 99.4% accuracy under GMP protocols."],
    ["experiences[b].responsibilities[4]", "Achieved a 3.4% traffic-conversion rate from more than 2,000 impressions."],
    ["experiences[a].title", "Operations Intern"],
  ]);
  const good: CoverLetterDraft = {
    parts: [
      { part: 1, sentences: [{ text: "Your QA release work on clinical lots is why I'm writing.", claimKeys: [] }] },
      {
        part: 2,
        sentences: [
          {
            text: "As an operations intern I ran protein-quantification tests at 99.4% accuracy under GMP protocols.",
            claimKeys: ["experiences[a].responsibilities[0]", "experiences[a].title"],
          },
        ],
      },
      {
        part: 3,
        sentences: [{ text: "I also validated a product idea and reached a 3.4% conversion rate.", claimKeys: ["experiences[b].responsibilities[4]"] }],
      },
      { part: 4, sentences: [{ text: "Thanks for reading.", claimKeys: [] }] },
    ],
  };

  it("accepts a grounded four-part draft", () => {
    const flat = good.parts.flatMap((p) => p.sentences.map((s) => ({ part: p.part, ...s })));
    expect(validateSentences(flat, allowed, { requireFourParts: true })).toEqual([]);
  });

  it("rejects invented numbers, uncited claims, unknown keys, banned phrasing and stealth naming", () => {
    const bad = [
      { part: 1, text: "I am passionate about quality — truly.", claimKeys: [] },
      { part: 2, text: "I ran tests at 99.9% accuracy.", claimKeys: ["experiences[a].responsibilities[0]"] },
      { part: 3, text: "I led Stealth Startup sales.", claimKeys: ["experiences[z].summary"] },
      { part: 3, text: "I managed a team of five.", claimKeys: [] },
    ];
    const problems = validateSentences(bad, allowed, { requireFourParts: true }).join("\n");
    expect(problems).toMatch(/four parts/);
    expect(problems).toMatch(/"passionate"/);
    expect(problems).toMatch(/em dash/);
    expect(problems).toMatch(/number "99\.9%"/);
    expect(problems).toMatch(/names a stealth employer/);
    expect(problems).toMatch(/not verified facts: experiences\[z\]\.summary/);
    expect(problems).toMatch(/without a source key/);
    expect(problems).toMatch(/number "five"/);
  });

  it("retries once with validation feedback, then returns the problems", async () => {
    const calls: (string[] | undefined)[] = [];
    class Fake extends NullProvider {
      override readonly available = true;
      override async draftCoverLetter(req: Parameters<AiProvider["draftCoverLetter"]>[0]): Promise<CoverLetterDraft> {
        calls.push(req.feedback);
        return { parts: [{ part: 1, sentences: [{ text: "I did 42 things.", claimKeys: [] }] }] };
      }
    }
    const fake: AiProvider = new Fake();
    const letter = await generateCoverLetter(fake, {
      company: "X",
      title: "Y",
      jobExcerpt: "z",
      facts: [...allowed].map(([key, text]) => ({ key, text })),
      fallbackBullets: [],
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.join(" ")).toMatch(/42/);
    expect(letter.problems.length).toBeGreaterThan(0);
  });

  it("without AI, builds a truthful fallback from verbatim bullets and never names the stealth startup", () => {
    const bullets: FallbackBullet[] = [
      {
        key: "experiences[s].responsibilities[1]",
        text: "Produced five pitch decks and investor documents using Figma and Canva.",
        experienceId: "s",
        experienceType: "project",
        title: "Business Development Lead",
        titleKey: "experiences[s].title",
        organization: "Stealth Startup",
        organizationKey: "experiences[s].organization",
      },
      {
        key: "experiences[a].responsibilities[0]",
        text: "Ran quality-control tests with 99.4% accuracy under GMP protocols.",
        experienceId: "a",
        experienceType: "work",
        title: "Operations Intern",
        titleKey: "experiences[a].title",
        organization: "Contoso Pharma",
        organizationKey: "experiences[a].organization",
      },
    ];
    const facts = new Map<string, string>([
      ...allowed,
      ["experiences[s].responsibilities[1]", bullets[0]!.text],
      ["experiences[s].title", "Business Development Lead"],
      ["experiences[s].organization", bullets[0]!.organization],
      ["experiences[a].organization", "Contoso Pharma"],
    ]);
    const letter = fallbackLetter({ company: "Acme", title: "QA Associate" }, bullets, facts);
    expect(letter.generator).toBe("fallback");
    expect(letter.problems).toEqual([]);
    expect(letter.paragraphs.join(" ")).toContain("an early-stage startup");
    expect(letter.paragraphs.join(" ")).not.toMatch(/stealth/i);
    expect(letter.sentences.find((s) => s.part === 2)!.sources.map((s) => s.key)).toContain("experiences[s].responsibilities[1]");
  });

  it("checks numbers in user-edited letters", () => {
    const l = validateUserLetter(
      ["I hit 99.4% accuracy.", "I also did 7 things."],
      [...allowed].map(([key, text]) => ({ key, text })),
    );
    expect(l.problems.join(" ")).toMatch(/"7"/);
    expect(l.problems.join(" ")).not.toMatch(/99\.4/);
  });
});
