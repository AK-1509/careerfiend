import { z } from "zod";

/* ------------------------------------------------------------------ skills */

export const SKILL_STATUSES = ["VERIFIED_FROM_SOURCE", "CONFIRMED_BY_USER", "UNVERIFIED", "REJECTED_BY_USER"] as const;
export const SkillStatusSchema = z.enum(SKILL_STATUSES);
export type SkillStatus = z.infer<typeof SkillStatusSchema>;

/** Only these statuses may count toward a match or fill a form field (D4). */
export const USABLE_STATUSES: readonly SkillStatus[] = ["VERIFIED_FROM_SOURCE", "CONFIRMED_BY_USER"];
export function isUsableStatus(status: string): boolean {
  return (USABLE_STATUSES as readonly string[]).includes(status);
}

export const SkillCategorySchema = z.enum(["technical", "soft", "domain", "tool", "language"]);
export type SkillCategory = z.infer<typeof SkillCategorySchema>;
export const SkillOriginSchema = z.enum(["resume", "inferred", "job-description"]);

export const EvidenceKindSchema = z.enum(["work", "project", "coursework", "thesis", "profile"]);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

export const EvidenceRefSchema = z.object({ key: z.string().min(1), kind: EvidenceKindSchema });
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const InventorySkillSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  category: SkillCategorySchema,
  status: SkillStatusSchema,
  origin: SkillOriginSchema,
  inResumeRegistry: z.boolean().default(false),
  evidence: z.array(EvidenceRefSchema).default([]),
  scope: z.string().optional(),
  claimLimit: z.string().optional(),
  basis: z.string().optional(),
  confirmGroup: z.string().optional(),
  parent: z.string().optional(),
  firstSeen: z.object({ jobId: z.string(), requirement: z.string() }).optional(),
  suggestedEvidence: z.array(z.string()).optional(),
});
export type InventorySkill = z.infer<typeof InventorySkillSchema>;

export const SkillsInventoryFileSchema = z.object({
  $comment: z.string().optional(),
  version: z.number(),
  source: z.object({ file: z.string(), repoPath: z.string(), pinnedCommit: z.string() }),
  excluded: z.array(z.object({ label: z.string(), reason: z.string() })),
  statuses: z.record(z.string(), z.string()),
  origins: z.record(z.string(), z.string()),
  skills: z.array(InventorySkillSchema),
});
export type SkillsInventoryFile = z.infer<typeof SkillsInventoryFileSchema>;

/* -------------------------------------------------------------- job listing */

export const REQUIREMENT_CATEGORIES = ["required", "preferred", "responsibility", "logistics", "unknown"] as const;
export const RequirementCategorySchema = z.enum(REQUIREMENT_CATEGORIES);
export type RequirementCategory = z.infer<typeof RequirementCategorySchema>;

export const RequirementKindSchema = z.enum(["skill", "experience-years", "degree", "license", "certification", "clearance", "location", "other"]);
export type RequirementKind = z.infer<typeof RequirementKindSchema>;

export const DegreeLevelSchema = z.enum(["none", "associate", "bachelor", "master", "doctorate", "professional"]);
export type DegreeLevel = z.infer<typeof DegreeLevelSchema>;

export const RequirementSchema = z.object({
  id: z.string(),
  category: RequirementCategorySchema,
  kind: RequirementKindSchema,
  text: z.string().min(1),
  /** For experience-years requirements. */
  years: z.number().nonnegative().optional(),
  /** For degree requirements. */
  degreeLevel: DegreeLevelSchema.optional(),
  /** "familiarity" / "coursework" style requirements accept coursework evidence. */
  depth: z.enum(["familiarity", "hands-on", "years", "unspecified"]).default("unspecified"),
});
export type Requirement = z.infer<typeof RequirementSchema>;

export const WorkplaceTypeSchema = z.enum(["onsite", "hybrid", "remote", "unknown"]);
export type WorkplaceType = z.infer<typeof WorkplaceTypeSchema>;

export const JobLocationSchema = z.object({
  raw: z.string(),
  locations: z.array(z.string()),
  workplaceType: WorkplaceTypeSchema,
  /** For remote roles: who may apply. */
  remoteScope: z.enum(["US", "global", "other", "unknown"]).nullable(),
});
export type JobLocation = z.infer<typeof JobLocationSchema>;

export const NormalizedJobSchema = z.object({
  sourceUrl: z.string().url(),
  canonicalUrl: z.string().url(),
  applyUrl: z.string().url().nullable(),
  company: z.string().min(1),
  title: z.string().min(1),
  location: JobLocationSchema,
  compensation: z.string().nullable(),
  description: z.string().min(1),
  requirements: z.array(RequirementSchema),
  applicationInstructions: z.string().nullable(),
  postedAt: z.string().nullable(),
  validThrough: z.string().nullable(),
  source: z.enum(["fixture", "page", "greenhouse", "lever", "ashby", "import"]),
  atsIdentifiers: z.record(z.string(), z.string()).default({}),
  expired: z.boolean().default(false),
});
export type NormalizedJob = z.infer<typeof NormalizedJobSchema>;

/* -------------------------------------------------------------- form fields */

export const SEMANTIC_FIELD_TYPES = [
  "first_name",
  "last_name",
  "full_name",
  "preferred_name",
  "email",
  "phone",
  "address",
  "city",
  "state",
  "postal_code",
  "country",
  "location",
  "resume_upload",
  "cover_letter_upload",
  "cover_letter_text",
  "linkedin",
  "github",
  "portfolio",
  "website",
  "work_history",
  "current_company",
  "current_title",
  "education_school",
  "education_degree",
  "education_end",
  "work_authorization",
  "sponsorship",
  "compensation",
  "start_date",
  "notice_period",
  "relocation",
  "background_check",
  "demographic",
  "disability",
  "veteran",
  "criminal_history",
  "consent",
  "signature",
  "attestation",
  "how_heard",
  "skill_question",
  "language_proficiency",
  "custom_free_response",
  "unknown",
] as const;
export const SemanticFieldTypeSchema = z.enum(SEMANTIC_FIELD_TYPES);
export type SemanticFieldType = z.infer<typeof SemanticFieldTypeSchema>;

export const ControlKindSchema = z.enum([
  "text",
  "email",
  "tel",
  "url",
  "number",
  "date",
  "textarea",
  "select",
  "radio",
  "checkbox",
  "file",
  "combobox",
  "unsupported",
]);
export type ControlKind = z.infer<typeof ControlKindSchema>;

export const FieldSourceSchema = z.enum(["resume", "profile", "skills", "user-answer", "document", "ai-draft", "none"]);
export type FieldSource = z.infer<typeof FieldSourceSchema>;

export const ReviewStateSchema = z.enum(["FILLED", "NEEDS_INPUT", "SENSITIVE_PENDING", "SKIPPED_OPTIONAL", "FILL_FAILED"]);
export type ReviewState = z.infer<typeof ReviewStateSchema>;

export const FormFieldManifestSchema = z.object({
  step: z.number().int().nonnegative(),
  fieldKey: z.string(),
  label: z.string(),
  control: ControlKindSchema,
  semanticType: SemanticFieldTypeSchema,
  required: z.boolean(),
  options: z.array(z.string()).default([]),
  proposedValue: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  source: FieldSourceSchema,
  provenance: z.array(z.string()).default([]),
  sensitive: z.boolean(),
  reviewState: ReviewStateSchema,
  validationMessage: z.string().nullable().default(null),
  note: z.string().nullable().default(null),
});
export type FormFieldManifest = z.infer<typeof FormFieldManifestSchema>;

/* ------------------------------------------------------------------- email */

export const EMAIL_CLASSES = ["confirmation", "action_required", "recruiter_response", "interview", "rejection", "offer", "other"] as const;
export const EmailClassSchema = z.enum(EMAIL_CLASSES);
export type EmailClass = z.infer<typeof EmailClassSchema>;

/* ------------------------------------------------------------------- facts */

export const FACT_KINDS = ["profile", "experience", "summary", "responsibility", "skill", "language"] as const;
export const FactKindSchema = z.enum(FACT_KINDS);
export type FactKind = z.infer<typeof FactKindSchema>;

export const ExperienceFactSchema = z.object({
  id: z.string(),
  key: z.string(),
  kind: FactKindSchema,
  experienceId: z.string().nullable(),
  text: z.string(),
  status: z.literal("VERIFIED_FROM_SOURCE"),
});
export type ExperienceFactData = z.infer<typeof ExperienceFactSchema>;

/* -------------------------------------------------------------- warnings */

export const WarningSchema = z.object({
  code: z.string(),
  message: z.string(),
  /** Blocking warnings must be resolved (not merely acknowledged) before approval. */
  blocking: z.boolean(),
  acknowledged: z.boolean().default(false),
});
export type Warning = z.infer<typeof WarningSchema>;
