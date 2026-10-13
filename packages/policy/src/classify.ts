import type { ControlKind, SemanticFieldType } from "@careerfiend/shared";

/**
 * Field classification from the label, surrounding question text, name /
 * autocomplete attributes and options. Order matters: the first matching rule
 * wins, sensitive classes are checked before generic ones.
 */

export interface FieldDescriptor {
  label: string;
  /** Question text around the control (legend, help text). */
  context: string;
  name: string;
  autocomplete: string;
  inputType: string;
  control: ControlKind;
  options: string[];
}

const RULES: { type: SemanticFieldType; re: RegExp; controls?: ControlKind[] }[] = [
  // ---- sensitive first
  { type: "sponsorship", re: /\b(sponsor(ship)?|visa|h-?1b|immigration (status|support))\b/i },
  {
    type: "work_authorization",
    re: /\b(authori[sz]ed to work|work authori[sz]ation|legally (authorized|eligible)|right to work|eligible to work|employment eligibility)\b/i,
  },
  { type: "compensation", re: /\b(salary|compensation|pay (expectation|requirement|range)|desired (pay|rate|wage)|expected (pay|salary|rate)|hourly rate)\b/i },
  { type: "relocation", re: /\b(relocat(e|ion)|willing to move)\b/i },
  { type: "background_check", re: /\b(background (check|screen|investigation)|drug (test|screen)|pre-?employment (screen|assessment))\b/i },
  { type: "criminal_history", re: /\b(convicted|conviction|felony|criminal (history|record)|misdemeanor)\b/i },
  { type: "veteran", re: /\b(veteran|military service|protected veteran)\b/i },
  { type: "disability", re: /\b(disability|disabled|handicap)\b/i },
  {
    type: "demographic",
    re: /\b(gender|sex\b|race|ethnicity|hispanic|latino|sexual orientation|pronouns|transgender|age\b|date of birth|birth ?date|marital)\b/i,
  },
  { type: "signature", re: /\b(signature|sign (here|your name)|e-?sign|type your (full )?name to sign)\b/i },
  { type: "attestation", re: /\b(certify|attest|affirm|i (declare|acknowledge) that|true and (complete|correct)|arbitration)\b/i },
  { type: "consent", re: /\b(consent|agree|privacy (policy|notice)|terms (of|and) (use|service|conditions)|opt[- ]in|text messages|sms)\b/i },
  // ---- documents
  { type: "resume_upload", re: /\b(resume|résumé|cv|curriculum vitae)\b/i, controls: ["file"] },
  { type: "cover_letter_upload", re: /\bcover letter\b/i, controls: ["file"] },
  { type: "cover_letter_text", re: /\bcover letter\b/i, controls: ["textarea"] },
  // ---- identity and contact
  { type: "first_name", re: /\b(first|given) name\b|^first$|\bfname\b/i },
  { type: "last_name", re: /\b(last|family|sur) ?name\b|^last$|\blname\b/i },
  { type: "preferred_name", re: /\b(preferred|nick) ?name\b/i },
  { type: "full_name", re: /^(full |legal )?name\b|\byour name\b|^name\s*\*?$/i },
  { type: "email", re: /\be-?mail\b/i },
  { type: "phone", re: /\b(phone|mobile|cell|telephone)\b/i },
  { type: "linkedin", re: /\blinked ?in\b/i },
  { type: "github", re: /\bgithub\b/i },
  { type: "portfolio", re: /\bportfolio\b/i },
  { type: "website", re: /\b(website|personal (site|url)|other (link|url)|url)\b/i },
  { type: "postal_code", re: /\b(zip|postal)( ?code)?\b/i },
  { type: "address", re: /\b(street|address( line)?)\b/i },
  { type: "city", re: /\bcity\b/i },
  { type: "state", re: /\b(state|province|region)\b/i },
  { type: "country", re: /\bcountry\b/i },
  { type: "location", re: /\b(location|where are you (located|based)|current (location|city))\b/i },
  // ---- history
  { type: "current_company", re: /\b(current|most recent) (company|employer)\b/i },
  { type: "current_title", re: /\b(current|most recent) (job )?title\b/i },
  { type: "education_school", re: /\b(school|university|college|institution)\b/i },
  { type: "education_degree", re: /\b(degree|discipline|major|field of study)\b/i },
  { type: "education_end", re: /\b(graduation|grad(uation)? date|end date|completion date)\b/i },
  { type: "start_date", re: /\b(start date|available to start|earliest (start|availability)|when can you start|availability)\b/i },
  { type: "notice_period", re: /\bnotice period\b/i },
  { type: "how_heard", re: /\b(how did you hear|hear about (us|this)|referral source|source)\b/i },
  {
    type: "language_proficiency",
    re: /\b(proficiency|fluency|fluent|level)\b.*\b(english|spanish|french|german|italian|portuguese|chinese|mandarin|cantonese|japanese|korean|hindi|arabic|russian|language)\b|\b(english|spanish|french|german|italian|portuguese|chinese|mandarin|cantonese|japanese|korean|hindi|arabic|russian)\b.*\b(proficiency|fluency|level)\b/i,
  },
  {
    type: "skill_question",
    re: /\b(do you have|have you (used|worked)|experience (with|in|using)|familiar with|years of experience|proficient in|how many years)\b/i,
  },
  { type: "work_history", re: /\b(employment history|work history|previous employer)\b/i },
];

export const SENSITIVE_TYPES: readonly SemanticFieldType[] = [
  "work_authorization",
  "sponsorship",
  "compensation",
  "relocation",
  "background_check",
  "demographic",
  "disability",
  "veteran",
  "criminal_history",
  "consent",
  "signature",
  "attestation",
];

/** Legal attestations stay visible on the approval screen, always. */
export const ALWAYS_REVIEW_TYPES: readonly SemanticFieldType[] = ["signature", "attestation", "consent"];

export function isSensitive(type: SemanticFieldType): boolean {
  return SENSITIVE_TYPES.includes(type);
}

export function classifyField(d: FieldDescriptor): SemanticFieldType {
  if (d.autocomplete) {
    const ac = d.autocomplete.toLowerCase();
    const map: Record<string, SemanticFieldType> = {
      "given-name": "first_name",
      "family-name": "last_name",
      name: "full_name",
      email: "email",
      tel: "phone",
      "postal-code": "postal_code",
      "address-line1": "address",
      "street-address": "address",
      "address-level2": "city",
      "address-level1": "state",
      country: "country",
      "country-name": "country",
      url: "website",
    };
    for (const [k, v] of Object.entries(map)) if (ac.split(/\s+/).includes(k)) return v;
  }
  if (d.inputType === "email") return "email";
  if (d.inputType === "tel") return "phone";
  const primary = `${d.label}`.trim();
  const secondary = `${d.context} ${d.name.replace(/[_\-[\]]+/g, " ")}`.trim();
  for (const text of [primary, `${primary} ${secondary}`]) {
    for (const r of RULES) {
      if (r.controls && !r.controls.includes(d.control)) continue;
      if (r.re.test(text)) return r.type;
    }
  }
  if (d.control === "file") return "resume_upload";
  if (d.control === "textarea") return "custom_free_response";
  return "unknown";
}
