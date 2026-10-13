import { describe, expect, it } from "vitest";
import {
  acceptDraft,
  checkApprovable,
  checkSubmitInvariant,
  chooseOption,
  classifyButton,
  classifyField,
  proposeValue,
  type FieldInput,
  type ProfileContext,
} from "../src/index";

const d = (label: string, control: any = "text", options: string[] = []) =>
  classifyField({ label, context: "", name: "", autocomplete: "", inputType: control, control, options });

describe("field classification", () => {
  it("classifies ordinary and sensitive fields", () => {
    expect(d("First Name")).toBe("first_name");
    expect(d("Email address")).toBe("email");
    expect(d("Resume/CV", "file")).toBe("resume_upload");
    expect(d("Are you legally authorized to work in the United States?", "radio")).toBe("work_authorization");
    expect(d("Will you now or in the future require visa sponsorship?", "radio")).toBe("sponsorship");
    expect(d("Desired salary")).toBe("compensation");
    expect(d("Race / Ethnicity", "select")).toBe("demographic");
    expect(d("Protected veteran status", "select")).toBe("veteran");
    expect(d("Have you ever been convicted of a felony?", "select")).toBe("criminal_history");
    expect(d("Signature (type your full name)")).toBe("signature");
    expect(d("I agree to the privacy notice", "checkbox")).toBe("consent");
    expect(d("Do you have experience with GMP?", "radio")).toBe("skill_question");
    expect(d("Why are you interested in this role?", "textarea")).toBe("custom_free_response");
  });
});

describe("final-submit classification (never by position)", () => {
  const b = (name: string, extra: Partial<Parameters<typeof classifyButton>[0]> = {}) =>
    classifyButton({ name, type: "button", tag: "button", nearbyText: "", submitsForm: false, forwardButtonsOnPage: 0, reviewPage: false, ...extra });
  it("recognizes submit, next, back and ambiguous controls", () => {
    expect(b("Submit application", { submitsForm: true })).toBe("final_submit");
    expect(b("Apply now")).toBe("final_submit");
    expect(b("Next")).toBe("next");
    expect(b("Save and continue", { submitsForm: true })).toBe("next");
    expect(b("Back")).toBe("back");
    expect(b("Upload resume")).toBe("upload");
    expect(b("Go", { submitsForm: true })).toBe("final_submit"); // unknown label that submits: never click
    expect(b("", { submitsForm: true })).toBe("final_submit");
    expect(b("Continue", { submitsForm: true, reviewPage: true })).toBe("final_submit");
  });
});

describe("option choice", () => {
  it("matches exact, yes/no and unique containment only", () => {
    expect(chooseOption("Yes", ["Yes", "No"])).toBe("Yes");
    expect(chooseOption("yes, I am", ["Yes, I am authorized", "No"])).toBe("Yes, I am authorized");
    expect(chooseOption("California", ["Choose one", "California", "Oregon"])).toBe("California");
    expect(chooseOption("Blue", ["Red", "Green"])).toBeNull();
  });
});

const ctx: ProfileContext = {
  name: "Test Applicant",
  email: "applicant@example.com",
  location: "Los Angeles, CA",
  links: [{ label: "GitHub", url: "https://github.com/example" }],
  headline: "h",
  currentRole: null,
  latestEducation: null,
  values: {},
  skills: [
    {
      id: "gmp",
      label: "GMP",
      aliases: [],
      category: "domain",
      status: "VERIFIED_FROM_SOURCE",
      origin: "resume",
      inResumeRegistry: true,
      evidence: [{ key: "experiences[a].responsibilities[0]", kind: "work" }],
    },
    {
      id: "r",
      label: "R",
      aliases: [],
      category: "technical",
      status: "VERIFIED_FROM_SOURCE",
      origin: "resume",
      inResumeRegistry: true,
      evidence: [{ key: "experiences[e].responsibilities[1]", kind: "coursework" }],
    },
    {
      id: "microsoft-excel",
      label: "Microsoft Excel",
      aliases: [],
      category: "tool",
      status: "UNVERIFIED",
      origin: "inferred",
      inResumeRegistry: false,
      evidence: [],
    },
  ],
  documents: { resumePath: "/tmp/r.pdf", resumeSha256: "abc", coverLetterPath: null, coverLetterSha256: null, coverLetterText: null },
  eeoPolicy: "UNSET",
  job: { company: "Acme", title: "QA", sourceUrl: "https://acme.example/jobs/1" },
  userAnswers: {},
};
const f = (label: string, semanticType: any, extra: Partial<FieldInput> = {}): FieldInput => ({
  fieldKey: `${label}:text`,
  label,
  context: "",
  semanticType,
  control: "text",
  required: true,
  options: [],
  ...extra,
});

describe("answer policy", () => {
  it("fills verified values and pauses on everything else", () => {
    expect(proposeValue(f("Email", "email"), ctx)).toMatchObject({ value: "applicant@example.com", reviewState: "FILLED", source: "resume" });
    expect(proposeValue(f("Phone", "phone"), ctx).reviewState).toBe("NEEDS_INPUT");
    expect(proposeValue(f("Phone", "phone", { required: false }), ctx).reviewState).toBe("SKIPPED_OPTIONAL");
  });
  it("sensitive questions pause without an explicit rule", () => {
    for (const t of [
      "work_authorization",
      "sponsorship",
      "compensation",
      "demographic",
      "veteran",
      "disability",
      "criminal_history",
      "signature",
      "attestation",
      "consent",
    ]) {
      expect(proposeValue(f(t, t), ctx).reviewState, t).toBe("SENSITIVE_PENDING");
    }
    const withRule = { ...ctx, values: { "work.authorization": "Yes" } };
    expect(proposeValue(f("Authorized?", "work_authorization", { control: "radio", options: ["Yes", "No"] }), withRule)).toMatchObject({
      value: "Yes",
      reviewState: "FILLED",
    });
    const prefer = { ...ctx, eeoPolicy: "PREFER_NOT_TO_ANSWER" as const };
    expect(proposeValue(f("Gender", "demographic", { control: "select", options: ["Male", "Female", "Decline to self-identify"] }), prefer).value).toBe(
      "Decline to self-identify",
    );
    expect(proposeValue(f("Veteran", "veteran", { control: "select", options: ["I am a veteran", "I am not a veteran"] }), prefer).reviewState).toBe(
      "SENSITIVE_PENDING",
    );
  });
  it("skill questions: verified → Yes, unverified → ask, coursework-only hands-on → ask, years → ask", () => {
    const radio = { control: "radio", options: ["Yes", "No"] };
    expect(proposeValue(f("Do you have experience with GMP?", "skill_question", radio), ctx)).toMatchObject({ value: "Yes", source: "skills" });
    expect(proposeValue(f("Do you have experience with Microsoft Excel?", "skill_question", radio), ctx).reviewState).toBe("NEEDS_INPUT");
    expect(proposeValue(f("Do you have professional experience with R?", "skill_question", radio), ctx).reviewState).toBe("NEEDS_INPUT");
    expect(proposeValue(f("How many years of experience with GMP?", "skill_question"), ctx).reviewState).toBe("NEEDS_INPUT");
  });
  it("user answers win and never become verified facts elsewhere", () => {
    const withAnswer = { ...ctx, userAnswers: { "Phone:text": "555-0100" } };
    expect(proposeValue(f("Phone", "phone"), withAnswer)).toMatchObject({ value: "555-0100", source: "user-answer" });
  });
  it("AI free-response drafts must cite facts and keep numbers exact", () => {
    const keys = new Set(["k1"]);
    const facts = new Map([["k1", "Achieved a 3.4% conversion rate."]]);
    const field = f("Why us?", "custom_free_response");
    expect(
      acceptDraft(field, { answer: "I reached 3.4% conversion.", claimKeys: ["k1"], confidence: 0.9, cannotAnswerReason: "" }, keys, facts).reviewState,
    ).toBe("FILLED");
    expect(
      acceptDraft(field, { answer: "I reached 5% conversion.", claimKeys: ["k1"], confidence: 0.9, cannotAnswerReason: "" }, keys, facts).reviewState,
    ).toBe("NEEDS_INPUT");
    expect(acceptDraft(field, { answer: "Something.", claimKeys: [], confidence: 0.9, cannotAnswerReason: "" }, keys, facts).reviewState).toBe("NEEDS_INPUT");
    expect(acceptDraft(field, { answer: "x", claimKeys: ["k1"], confidence: 0.3, cannotAnswerReason: "" }, keys, facts).reviewState).toBe("NEEDS_INPUT");
  });
});

describe("approval invariant", () => {
  const base = {
    state: "APPROVED" as const,
    currentRevisionHash: "h1",
    recomputedHash: "h1",
    approval: { revisionHash: "h1", consumedAt: null, invalidatedAt: null, confirmation: "APPROVE" },
    unresolvedRequiredFields: 0,
    warnings: [],
    acknowledgedWarningCodes: [],
    expectedConfirmation: "SUBMIT",
    submitConfirmation: "SUBMIT",
  };
  it("passes only when every condition holds", () => {
    expect(checkSubmitInvariant(base)).toEqual({ ok: true });
    const fails: Partial<typeof base>[] = [
      { state: "READY_FOR_REVIEW" as any },
      { approval: null as any },
      { approval: { ...base.approval, revisionHash: "old" } },
      { approval: { ...base.approval, consumedAt: new Date() as any } },
      { approval: { ...base.approval, invalidatedAt: new Date() as any } },
      { recomputedHash: "tampered" },
      { unresolvedRequiredFields: 1 },
      { warnings: [{ code: "SOURCE_CHANGED", message: "", blocking: true, acknowledged: false }] as any },
      { warnings: [{ code: "EXPERIENCE_GAP", message: "", blocking: false, acknowledged: false }] as any },
      { submitConfirmation: "" },
    ];
    for (const patch of fails) expect(checkSubmitInvariant({ ...base, ...patch } as any).ok, JSON.stringify(patch)).toBe(false);
    expect(
      checkSubmitInvariant({
        ...base,
        warnings: [{ code: "EXPERIENCE_GAP", message: "", blocking: false, acknowledged: false }],
        acknowledgedWarningCodes: ["EXPERIENCE_GAP"],
      } as any),
    ).toEqual({ ok: true });
  });
  it("approval requires READY_FOR_REVIEW and the explicit confirmation", () => {
    expect(
      checkApprovable({ state: "READY_FOR_REVIEW", unresolvedRequiredFields: 0, warnings: [], acknowledgedWarningCodes: [], confirmation: "APPROVE" }).ok,
    ).toBe(true);
    expect(checkApprovable({ state: "NEEDS_INPUT", unresolvedRequiredFields: 0, warnings: [], acknowledgedWarningCodes: [], confirmation: "APPROVE" }).ok).toBe(
      false,
    );
    expect(
      checkApprovable({ state: "READY_FOR_REVIEW", unresolvedRequiredFields: 0, warnings: [], acknowledgedWarningCodes: [], confirmation: "yes" }).ok,
    ).toBe(false);
  });
});
