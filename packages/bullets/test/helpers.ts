import type { Resume } from "@careerfiend/profile";
import type { NormalizedJob, Requirement } from "@careerfiend/shared";

/** Small résumés and listings for bullet-pipeline tests. */
export function resumeOf(
  entries: { id: string; type?: "work" | "project"; title?: string; organization?: string; bullets: string[]; skills?: string[] }[],
): Pick<Resume, "experiences"> {
  return {
    experiences: entries.map((e) => ({
      id: e.id,
      type: e.type ?? "work",
      title: e.title ?? "Analyst",
      organization: e.organization ?? "Org",
      location: "",
      startDate: "2024-01",
      endDate: "2024-06",
      summary: "",
      responsibilities: e.bullets,
      endorsedSkills: e.skills ?? [],
      gallery: [],
    })) as unknown as Resume["experiences"],
  };
}

export function jobOf(
  company: string,
  reqs: { text: string; category?: Requirement["category"]; kind?: Requirement["kind"] }[],
): Pick<NormalizedJob, "company" | "title" | "location" | "requirements"> {
  return {
    company,
    title: "Product Analyst",
    location: { raw: "San Francisco, CA", locations: ["San Francisco, CA"], workplaceType: "onsite", remoteScope: null },
    requirements: reqs.map((r, i) => ({
      id: `req${i}`,
      category: r.category ?? "required",
      kind: r.kind ?? "skill",
      text: r.text,
      depth: "unspecified",
    })) as Requirement[],
  };
}
