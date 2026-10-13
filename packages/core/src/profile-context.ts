import { decrypt, isEncrypted } from "@careerfiend/shared";
import { getProfileValues, listSkills, parseEeoPolicy, type Resume } from "@careerfiend/profile";
import type { ProfileContext } from "@careerfiend/policy";
import type { AppContext } from "./context";

export interface DocumentRefs {
  resumePath: string | null;
  resumeSha256: string | null;
  coverLetterPath: string | null;
  coverLetterSha256: string | null;
  coverLetterText: string | null;
}

/** Everything the answer policy may use for one application. Only usable values are included. */
export async function buildProfileContext(
  ctx: AppContext,
  resume: Resume,
  applicationId: string,
  job: { company: string; title: string; sourceUrl: string },
  documents: DocumentRefs,
): Promise<ProfileContext> {
  const key = ctx.key();
  const values: Record<string, string> = {};
  for (const v of await getProfileValues(ctx.db, key)) if (v.status === "CONFIRMED_BY_USER" && v.value) values[v.key] = v.value;
  const skills = await listSkills(ctx.db);
  const questions = await ctx.db.userQuestion.findMany({ where: { applicationId, kind: "FIELD", answeredAt: { not: null } } });
  const userAnswers: Record<string, string> = {};
  for (const q of questions) if (q.answer !== null) userAnswers[q.fieldKey] = isEncrypted(q.answer) ? decrypt(q.answer, key) : q.answer;

  const work = resume.experiences
    .filter((e) => e.type === "work")
    .sort((a, b) => (b.endDate === null ? 1 : 0) - (a.endDate === null ? 1 : 0) || b.startDate.localeCompare(a.startDate));
  const current = work.find((e) => e.endDate === null) ?? null;
  const edu = resume.experiences.filter((e) => e.type === "education").sort((a, b) => (b.endDate ?? "9999").localeCompare(a.endDate ?? "9999"));
  const latestEdu = edu[0] ?? null;
  return {
    name: resume.profile.name,
    email: resume.profile.email,
    location: resume.profile.location,
    links: resume.profile.links,
    headline: resume.profile.headline,
    currentRole: current
      ? {
          title: current.title,
          organization: current.organization,
          titleKey: `experiences[${current.id}].title`,
          orgKey: `experiences[${current.id}].organization`,
        }
      : null,
    latestEducation: latestEdu
      ? { title: latestEdu.title, organization: latestEdu.organization, endDate: latestEdu.endDate, key: `experiences[${latestEdu.id}]` }
      : null,
    values,
    skills,
    documents,
    eeoPolicy: parseEeoPolicy(values["eeo.policy"]),
    job,
    userAnswers,
  };
}
