import { CareerFiendError, sha256 } from "@careerfiend/shared";
import { ResumeSchema, type Resume } from "./resume-schema";

/** Name used in messages for the résumé document (resume.json shape). */
export const RESUME_FILE = "your résumé";

/** One version of the person's résumé, pinned (the public edition stores it; "commit" is its version, "v<N>"). */
export interface ResumeSource {
  repoPath: string;
  commit: string;
  fileSha256: string;
  /** `${commit}:${fileSha256}` (D1). */
  checksum: string;
  /** Exact JSON text of this version. */
  rawText: string;
  resume: Resume;
  /** Always false in the public edition (kept for the shared document code). */
  workingTreeDiffers: boolean;
}

export function parseResumeSource(input: { repoPath: string; commit: string; rawText: string; workingText?: string }): ResumeSource {
  let json: unknown;
  try {
    json = JSON.parse(input.rawText);
  } catch (err) {
    throw new CareerFiendError("FATAL_CONFIGURATION", `${RESUME_FILE} is not valid JSON.`, { cause: err });
  }
  const parsed = ResumeSchema.safeParse(json);
  if (!parsed.success) {
    throw new CareerFiendError(
      "FATAL_CONFIGURATION",
      `${RESUME_FILE} failed schema validation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const fileSha256 = sha256(input.rawText);
  return {
    repoPath: input.repoPath,
    commit: input.commit,
    fileSha256,
    checksum: `${input.commit}:${fileSha256}`,
    rawText: input.rawText,
    resume: parsed.data,
    workingTreeDiffers: input.workingText !== undefined && input.workingText !== input.rawText,
  };
}
