import { isUsableStatus, normalizeLabel, slugify, type FieldSource, type InventorySkill, type ReviewState, type SemanticFieldType } from "@careerfiend/shared";
import { ALWAYS_REVIEW_TYPES, isSensitive } from "./classify";

/**
 * Deterministic answer policy. Only VERIFIED_FROM_SOURCE / CONFIRMED_BY_USER
 * data and explicit user rules may fill a field. Sensitive fields need an
 * explicit stored preference. Anything else becomes NEEDS_INPUT.
 */

export const AUTOFILL_CONFIDENCE = 0.75;

export interface ProfileContext {
  name: string;
  email: string;
  location: string;
  links: { label: string; url: string }[];
  headline: string;
  currentRole: { title: string; organization: string; titleKey: string; orgKey: string } | null;
  latestEducation: { title: string; organization: string; endDate: string | null; key: string } | null;
  /** CONFIRMED_BY_USER profile values (answers-later.md and dashboard answers), decrypted. */
  values: Record<string, string>;
  skills: InventorySkill[];
  documents: {
    resumePath: string | null;
    resumeSha256: string | null;
    coverLetterPath: string | null;
    coverLetterSha256: string | null;
    coverLetterText: string | null;
  };
  eeoPolicy: "PREFER_NOT_TO_ANSWER" | "ASK_EACH_TIME" | "STORED_ANSWERS" | "UNSET";
  job: { company: string; title: string; sourceUrl: string };
  /** Answers the user gave to this application's questions, keyed by fieldKey. */
  userAnswers: Record<string, string>;
}

export interface FieldInput {
  fieldKey: string;
  label: string;
  context: string;
  semanticType: SemanticFieldType;
  control: string;
  required: boolean;
  options: string[];
}

export interface Proposal {
  value: string | null;
  confidence: number;
  source: FieldSource;
  provenance: string[];
  reviewState: ReviewState;
  sensitive: boolean;
  note: string | null;
  /** The question to ask when the value is missing. */
  question?: string;
}

/** Stable key for a field across runs of the same application. */
export function fieldKeyFor(label: string, control: string, name = ""): string {
  const base = slugify(label || name).slice(0, 80) || "field";
  return `${base}:${control}`;
}

/** Key under which a reusable answer to this question is stored. */
export function reusableKeyFor(field: Pick<FieldInput, "semanticType" | "label">): string {
  const bySemantic: Partial<Record<SemanticFieldType, string>> = {
    phone: "contact.phone",
    portfolio: "contact.portfolio",
    website: "contact.portfolio",
    work_authorization: "work.authorization",
    sponsorship: "work.sponsorship",
    compensation: "work.minimumPay",
    start_date: "work.startDate",
    notice_period: "work.startDate",
    relocation: "work.relocation",
    background_check: "work.backgroundChecks",
  };
  return bySemantic[field.semanticType] ?? `answer.${slugify(field.label).slice(0, 80)}`;
}

const YES = /^(yes|y|true|i am|i do|i will|i have|agree|i agree|accept)\b/i;
const NO = /^(no|n|false|i am not|i do not|i don't|i will not|i won't)\b/i;
const PREFER_NOT = /(prefer not|decline|don'?t wish|do not wish|choose not|not to (say|disclose|answer|self-identify)|rather not|i don'?t want to answer)/i;

/**
 * Pick the option matching a desired answer. Exact (normalized) match first,
 * then yes/no semantics, then a unique containment match. Null when unsure.
 */
export function chooseOption(desired: string, options: string[]): string | null {
  const opts = options.filter((o) => o.trim() && !/^(select|choose|--|please select)/i.test(o.trim()));
  if (!opts.length) return null;
  const nd = normalizeLabel(desired);
  const exact = opts.find((o) => normalizeLabel(o) === nd);
  if (exact) return exact;
  if (YES.test(desired.trim())) {
    const y = opts.filter((o) => YES.test(o.trim()));
    if (y.length === 1) return y[0]!;
  }
  if (NO.test(desired.trim())) {
    const n = opts.filter((o) => NO.test(o.trim()));
    if (n.length === 1) return n[0]!;
  }
  const contains = opts.filter((o) => normalizeLabel(o).includes(nd) || (nd.length > 3 && nd.includes(normalizeLabel(o))));
  return contains.length === 1 ? contains[0]! : null;
}

const US_STATES: Record<string, string> = { CA: "California" };

function need(field: FieldInput, question: string, sensitive: boolean, note: string | null = null): Proposal {
  return {
    value: null,
    confidence: 0,
    source: "none",
    provenance: [],
    reviewState: !field.required ? "SKIPPED_OPTIONAL" : sensitive ? "SENSITIVE_PENDING" : "NEEDS_INPUT",
    sensitive,
    note,
    question,
  };
}

function ok(value: string, source: FieldSource, provenance: string[], confidence: number, sensitive: boolean, note: string | null = null): Proposal {
  return { value, confidence, source, provenance, reviewState: confidence >= AUTOFILL_CONFIDENCE ? "FILLED" : "NEEDS_INPUT", sensitive, note };
}

/** Fit a value to a choice control, or ask. */
function fit(field: FieldInput, p: Proposal): Proposal {
  if (p.value === null || !field.options.length || !["select", "radio", "combobox"].includes(field.control)) return p;
  const chosen = chooseOption(p.value, field.options);
  if (chosen) return { ...p, value: chosen };
  return need(field, `"${field.label}": your stored answer "${p.value}" does not match any option (${field.options.join(" / ")}). Pick one.`, p.sensitive);
}

/**
 * Propose a value for one field. Free-response drafting (AI) is handled by the
 * caller, which passes the result through `acceptDraft`.
 */
export function proposeValue(field: FieldInput, ctx: ProfileContext): Proposal {
  const sensitive = isSensitive(field.semanticType);
  const q = (text: string) => need(field, text, sensitive);

  // 1. An answer the user gave to this exact question always wins.
  const answered = ctx.userAnswers[field.fieldKey];
  if (answered !== undefined && answered !== "") {
    return fit(
      field,
      ok(
        answered,
        "user-answer",
        [`answer:${field.fieldKey}`],
        1,
        sensitive,
        ALWAYS_REVIEW_TYPES.includes(field.semanticType) ? "Legal attestation: review before approving." : null,
      ),
    );
  }
  // 2. A reusable rule the user saved for this kind of question.
  const reusable = ctx.values[reusableKeyFor(field)];
  if (reusable) {
    return fit(
      field,
      ok(
        reusable,
        "profile",
        [`profile:${reusableKeyFor(field)}`],
        1,
        sensitive,
        ALWAYS_REVIEW_TYPES.includes(field.semanticType) ? "Legal attestation: review before approving." : null,
      ),
    );
  }

  const [first, ...rest] = ctx.name.split(/\s+/);
  const [city, stateCode] = ctx.location.split(",").map((s) => s.trim());
  const link = (re: RegExp) => ctx.links.find((l) => re.test(l.label) || re.test(l.url));

  switch (field.semanticType) {
    case "first_name":
      return ok(first ?? ctx.name, "resume", ["profile.name"], 0.95, false);
    case "last_name":
      return rest.length ? ok(rest.join(" "), "resume", ["profile.name"], 0.95, false) : q("What last name should forms use?");
    case "full_name":
      return ok(ctx.name, "resume", ["profile.name"], 0.95, false);
    case "preferred_name":
      return field.required ? ok(first ?? ctx.name, "resume", ["profile.name"], 0.8, false) : need(field, "Preferred name", false);
    case "email":
      return ok(ctx.email, "resume", ["profile.email"], 0.98, false);
    case "phone":
      return q("What phone number should applications use? (Profile page: Phone)");
    case "linkedin": {
      const l = link(/linkedin/i);
      return l ? ok(l.url, "resume", [`profile.links[${ctx.links.indexOf(l)}]`], 0.95, false) : q("LinkedIn URL");
    }
    case "github": {
      const l = link(/github/i);
      return l ? ok(l.url, "resume", [`profile.links[${ctx.links.indexOf(l)}]`], 0.95, false) : q("GitHub URL");
    }
    case "portfolio":
    case "website":
      return q("Which portfolio or website link should forms use? (Profile page: Portfolio link)");
    case "city":
      return city ? ok(city, "resume", ["profile.location"], 0.9, false) : q("City");
    case "state":
      if (!stateCode) return q("State");
      return fit(
        field,
        ok(
          field.options.length && !field.options.some((o) => normalizeLabel(o) === normalizeLabel(stateCode)) ? (US_STATES[stateCode] ?? stateCode) : stateCode,
          "resume",
          ["profile.location"],
          0.9,
          false,
        ),
      );
    case "country":
      // "Los Angeles, CA" is in the United States.
      return stateCode && US_STATES[stateCode] ? fit(field, ok("United States", "resume", ["profile.location"], 0.9, false)) : q("Country");
    case "location":
      return fit(field, ok(ctx.location, "resume", ["profile.location"], 0.9, false));
    case "address":
    case "postal_code":
      return q(`${field.label}: your street address and ZIP code are not stored. Answer here, or leave optional fields blank.`);
    case "resume_upload":
      return ctx.documents.resumePath
        ? ok(ctx.documents.resumePath, "document", [`sha256:${ctx.documents.resumeSha256}`], 1, false)
        : q("Résumé file is missing.");
    case "cover_letter_upload":
      return ctx.documents.coverLetterPath
        ? ok(ctx.documents.coverLetterPath, "document", [`sha256:${ctx.documents.coverLetterSha256}`], 1, false)
        : q("Cover letter file is missing.");
    case "cover_letter_text":
      return ctx.documents.coverLetterText
        ? ok(ctx.documents.coverLetterText, "document", [`sha256:${ctx.documents.coverLetterSha256}`], 1, false)
        : q("Cover letter text is missing.");
    case "current_company":
      return ctx.currentRole ? ok(ctx.currentRole.organization, "resume", [ctx.currentRole.orgKey], 0.9, false) : q("Current company");
    case "current_title":
      return ctx.currentRole ? ok(ctx.currentRole.title, "resume", [ctx.currentRole.titleKey], 0.9, false) : q("Current title");
    case "education_school":
      return ctx.latestEducation
        ? fit(field, ok(ctx.latestEducation.organization, "resume", [`${ctx.latestEducation.key}.organization`], 0.8, false))
        : q("School");
    case "education_degree":
      return ctx.latestEducation ? fit(field, ok(ctx.latestEducation.title, "resume", [`${ctx.latestEducation.key}.title`], 0.8, false)) : q("Degree");
    case "education_end": {
      const shown = ctx.values["education.expected"];
      if (shown) return ok(shown, "profile", ["profile:education.expected"], 1, false);
      return ctx.latestEducation?.endDate
        ? ok(ctx.latestEducation.endDate, "resume", [`${ctx.latestEducation.key}.endDate`], 0.8, false)
        : q("Graduation date");
    }
    case "start_date":
    case "notice_period":
      return q("Earliest start date / notice period (Profile page)");
    case "how_heard": {
      const fromBoard = /linkedin\.com/i.test(ctx.job.sourceUrl) ? "LinkedIn" : /indeed\./i.test(ctx.job.sourceUrl) ? "Indeed" : "Company website";
      const chosen = field.options.length ? chooseOption(fromBoard, field.options) : fromBoard;
      return chosen ? ok(chosen, "profile", [`source:${ctx.job.sourceUrl}`], 0.8, false) : q("How did you hear about this job?");
    }
    case "language_proficiency": {
      const lang = ["english", "spanish", "french", "german", "chinese", "hindi"].find((l) =>
        new RegExp(`\\b${l}\\b`, "i").test(`${field.label} ${field.context}`),
      );
      const v = lang ? ctx.values[`language.${lang}`] : undefined;
      return v ? fit(field, ok(v, "profile", [`profile:language.${lang}`], 1, false)) : q(`${field.label}: proficiency is not stated on your résumé.`);
    }
    case "skill_question":
      return skillAnswer(field, ctx);
    case "demographic":
    case "disability":
    case "veteran": {
      if (ctx.eeoPolicy === "PREFER_NOT_TO_ANSWER") {
        const opt = field.options.find((o) => PREFER_NOT.test(o));
        if (opt) return ok(opt, "profile", ["profile:eeo.policy"], 1, true, "EEO policy: prefer not to answer.");
        return field.required
          ? q(`${field.label}: no "prefer not to answer" option exists. Answer or decline this application.`)
          : need(field, field.label, true);
      }
      return q(`${field.label} (EEO / self-identification). Your policy is ${ctx.eeoPolicy === "UNSET" ? "not set" : "ask each time"}.`);
    }
    case "work_authorization":
      return q("Are you authorized to work in the US? (Profile page: Work authorization)");
    case "sponsorship":
      return q("Will you need visa sponsorship now or later? (Profile page: Sponsorship)");
    case "compensation":
      return q(`${field.label}: no compensation rule is stored (Profile page: Minimum pay).`);
    case "relocation":
      return q(`${field.label}: relocation preference is not stored.`);
    case "background_check":
      return q(`${field.label}: background-check consent needs your answer.`);
    case "criminal_history":
    case "signature":
    case "attestation":
    case "consent":
      return q(`${field.label}: legal question. CareerFiend never answers these without your explicit answer.`);
    case "custom_free_response":
    case "work_history":
    case "unknown":
    default:
      return q(field.label || "Unlabeled field");
  }
}

function skillAnswer(field: FieldInput, ctx: ProfileContext): Proposal {
  const text = `${field.label} ${field.context}`;
  if (/how many|number of years|years of/i.test(text)) {
    return need(field, `${field.label}: CareerFiend does not calculate years-of-experience claims. Answer this yourself.`, false);
  }
  const mentioned = ctx.skills.filter((s) =>
    [s.label, ...s.aliases].some((f) => f.length > 2 && new RegExp(`\\b${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)),
  );
  if (!mentioned.length) return need(field, `${field.label}: the skill asked about is not in your inventory.`, false);
  const s = mentioned[0]!;
  if (s.status === "REJECTED_BY_USER") return fit(field, ok("No", "skills", [`skill:${s.id}`], 0.9, false, `You rejected ${s.label}.`));
  if (!isUsableStatus(s.status)) return need(field, `${field.label}: ${s.label} is UNVERIFIED. Confirm or reject it on the Skills page.`, false);
  const courseworkOnly = s.evidence.length > 0 && s.evidence.every((e) => e.kind === "coursework" || e.kind === "thesis");
  if (courseworkOnly && /\b(professional|hands-on|work experience|industry)\b/i.test(text)) {
    return need(field, `${field.label}: ${s.label} is coursework/thesis only (${s.claimLimit ?? "claim limit"}).`, false);
  }
  return fit(field, ok("Yes", "skills", [`skill:${s.id}`, ...s.evidence.map((e) => e.key)], 0.9, false, s.claimLimit ?? null));
}

/** Validate an AI free-response draft before it can fill a field. */
export function acceptDraft(
  field: FieldInput,
  draft: { answer: string; claimKeys: string[]; confidence: number; cannotAnswerReason: string },
  allowedKeys: Set<string>,
  factText: Map<string, string>,
): Proposal {
  if (!draft.answer.trim() || draft.confidence < AUTOFILL_CONFIDENCE) {
    return need(field, `${field.label}${draft.cannotAnswerReason ? ` (${draft.cannotAnswerReason})` : ""}`, false, "AI could not answer confidently.");
  }
  const unknown = draft.claimKeys.filter((k) => !allowedKeys.has(k));
  if (unknown.length || draft.claimKeys.length === 0) {
    return need(field, field.label, false, "AI draft cited no verified facts or unknown keys; not used.");
  }
  const cited = draft.claimKeys.map((k) => factText.get(k) ?? "").join(" ");
  const nums = [...draft.answer.matchAll(/\d[\d,.]*%?/g)].map((m) => m[0].replace(/[.,]$/, ""));
  if (nums.some((n) => !cited.includes(n))) return need(field, field.label, false, "AI draft used a number not in its cited facts; not used.");
  return {
    value: draft.answer.trim(),
    confidence: draft.confidence,
    source: "ai-draft",
    provenance: draft.claimKeys,
    reviewState: "FILLED",
    sensitive: false,
    note: "Drafted by AI from cited facts. Review before approving.",
  };
}
