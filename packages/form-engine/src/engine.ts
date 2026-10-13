import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { sha256, type FailureCategory, type FormFieldManifest, type SemanticFieldType } from "@careerfiend/shared";
import { chooseOption, classifyButton, classifyField, fieldKeyFor, isSensitive, type FieldInput, type Proposal } from "@careerfiend/policy";
import { BUTTONS_SCRIPT, GUARD_SCRIPT, INSPECT_ALL_SCRIPT, INSPECT_SCRIPT, STATE_SCRIPT, type PageState, type RawButton, type RawControl } from "./dom";

export interface InspectedField extends FieldInput {
  raw: RawControl;
}

export interface StepRecord {
  step: number;
  url: string;
  screenshotPath: string;
  manifestPath: string;
}

export type PrepareOutcome = "READY" | "NEEDS_INPUT" | "PAUSED" | "FAILED";

export interface PrepareResult {
  outcome: PrepareOutcome;
  category: FailureCategory | null;
  message: string;
  fields: FormFieldManifest[];
  steps: StepRecord[];
  finalSubmitLabel: string | null;
  finalUrl: string;
  blockedSubmits: number;
  /** Unresolved questions keyed by fieldKey. */
  questions: { fieldKey: string; label: string; question: string; semanticType: SemanticFieldType; options: string[]; sensitive: boolean }[];
}

export type Proposer = (field: InspectedField) => Promise<Proposal>;

export interface EngineOptions {
  targetUrl: string;
  outputDir: string;
  /** Hosts the form may legitimately navigate within (target host + ATS hosts). */
  allowedHosts: string[];
  maxSteps?: number;
  stepTimeoutMs?: number;
}

/* ------------------------------------------------------------- helpers */

export async function installGuard(page: Page): Promise<void> {
  await page.context().addInitScript(GUARD_SCRIPT);
  await page.evaluate(GUARD_SCRIPT).catch(() => undefined);
}

export async function pageState(page: Page): Promise<PageState> {
  return (await page.evaluate(STATE_SCRIPT)) as PageState;
}

export async function inspectFields(page: Page, opts: { includeHiddenSteps?: boolean } = {}): Promise<InspectedField[]> {
  const raw = (await page.evaluate(opts.includeHiddenSteps ? INSPECT_ALL_SCRIPT : INSPECT_SCRIPT)) as RawControl[];
  return raw.map((r) => {
    const label = r.label
      .replace(/\s*\*\s*$/, "")
      .replace(/\s*\(required\)\s*$/i, "")
      .trim();
    const semanticType = classifyField({
      label,
      context: r.context,
      name: r.name,
      autocomplete: r.autocomplete,
      inputType: r.inputType,
      control: r.control,
      options: r.options,
    });
    return {
      fieldKey: fieldKeyFor(label, r.control, r.name),
      label,
      context: r.context,
      semanticType,
      control: r.control,
      required: r.required,
      options: r.options,
      raw: r,
    };
  });
}

export async function inspectButtons(page: Page) {
  const raw = (await page.evaluate(BUTTONS_SCRIPT)) as RawButton[];
  const forward = raw.filter((b) => /^(next|continue|proceed|save (and|&) continue)/i.test(b.name)).length;
  const state = await pageState(page);
  const reviewPage = /\b(review (your )?(application|answers)|summary)\b/i.test(`${state.heading} ${state.bodyTextSample}`);
  return raw.map((b) => ({
    raw: b,
    role: classifyButton({
      name: b.name,
      type: b.type,
      tag: b.tag,
      nearbyText: b.nearbyText,
      submitsForm: b.submitsForm,
      forwardButtonsOnPage: forward - (/^(next|continue)/i.test(b.name) ? 1 : 0),
      reviewPage,
    }),
  }));
}

function hostAllowed(url: string, allowed: string[]): boolean {
  try {
    const h = new URL(url).hostname;
    return allowed.some((a) => h === a || h.endsWith(`.${a}`));
  } catch {
    return false;
  }
}

/** Fill one field and read it back. Returns an error message or null. */
export async function fillField(page: Page, field: InspectedField, value: string): Promise<string | null> {
  const loc = page.locator(`[data-cf-id="${field.raw.cfId}"]`);
  try {
    switch (field.control) {
      case "text":
      case "email":
      case "tel":
      case "url":
      case "number":
      case "date":
      case "textarea": {
        await loc.fill(value);
        const back = await loc.inputValue();
        return back === value ? null : `Value did not stick (read back "${back.slice(0, 40)}").`;
      }
      case "select": {
        await loc.selectOption({ label: value });
        const back = await loc.evaluate((el: HTMLSelectElement) =>
          el.options[el.selectedIndex] ? String(el.options[el.selectedIndex]!.textContent).trim() : "",
        );
        return back === value ? null : `Selection did not stick (read back "${back}").`;
      }
      case "radio":
      case "checkbox": {
        if (field.raw.members.length) {
          const target = chooseOption(
            value,
            field.raw.members.map((m) => m.label),
          );
          const member = field.raw.members.find((m) => m.label === target);
          if (!member) return `No option matches "${value}".`;
          const m = page.locator(`[data-cf-id="${member.cfId}"]`);
          await m.check();
          return (await m.isChecked()) ? null : "Option did not stay selected.";
        }
        const want = /^(yes|true|y|1|checked|agree|i agree|accept)/i.test(value.trim());
        if (field.raw.tag === "input") {
          await loc.setChecked(want);
          return (await loc.isChecked()) === want ? null : "Checkbox did not stick.";
        }
        const current = (await loc.getAttribute("aria-checked")) === "true";
        if (current !== want) await loc.click();
        return ((await loc.getAttribute("aria-checked")) === "true") === want ? null : "Custom checkbox did not stick.";
      }
      case "file": {
        await loc.setInputFiles(value);
        const name = await loc.evaluate((el: HTMLInputElement) => (el.files && el.files[0] ? el.files[0].name : ""));
        return name === path.basename(value) ? null : "File did not attach.";
      }
      case "combobox": {
        await loc.click();
        const listId = await loc.getAttribute("aria-controls");
        const scope = listId ? page.locator(`#${listId}`) : page;
        const option = scope.getByRole("option", { name: value, exact: true });
        if ((await option.count()) === 0) return `No option "${value}" in the list.`;
        await option.first().click();
        const shown = ((await loc.getAttribute("data-value")) || (await loc.innerText()) || "").trim();
        return shown.includes(value) ? null : `Combobox shows "${shown}".`;
      }
      default:
        return "Unsupported control type.";
    }
  } catch (err) {
    return `Fill failed: ${(err as Error).message.split("\n")[0]}`;
  }
}

function manifestEntry(step: number, f: InspectedField, p: Proposal, validationMessage: string | null): FormFieldManifest {
  return {
    step,
    fieldKey: f.fieldKey,
    label: f.label,
    control: f.control as FormFieldManifest["control"],
    semanticType: f.semanticType,
    required: f.required,
    options: f.options,
    proposedValue: p.value,
    confidence: p.confidence,
    source: p.source,
    provenance: p.provenance,
    sensitive: p.sensitive || isSensitive(f.semanticType),
    reviewState: p.reviewState,
    validationMessage,
    note: p.note,
  };
}

async function snapshot(page: Page, dir: string, step: number, fields: FormFieldManifest[]): Promise<StepRecord> {
  const stepsDir = path.join(dir, "steps");
  mkdirSync(stepsDir, { recursive: true });
  const screenshotPath = path.join(stepsDir, `step-${step}.png`);
  const manifestPath = path.join(stepsDir, `step-${step}.json`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  // Sanitized manifest: sensitive values are masked on disk; the database holds them encrypted.
  const sanitized = fields
    .filter((f) => f.step === step)
    .map((f) => ({ ...f, proposedValue: f.sensitive && f.proposedValue ? "[sensitive]" : f.proposedValue }));
  writeFileSync(manifestPath, JSON.stringify({ step, url: page.url(), fields: sanitized }, null, 2));
  return { step, url: page.url(), screenshotPath, manifestPath };
}

async function settle(page: Page, ms = 400): Promise<void> {
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await page.waitForTimeout(ms);
}

function blockerOf(state: PageState): { category: FailureCategory; message: string } | null {
  if (state.captcha) return { category: "CAPTCHA_OR_BOT_CHECK", message: "A CAPTCHA or bot check is on the page. Take over in the browser window." };
  if (state.login) return { category: "LOGIN_REQUIRED", message: "The site asks you to sign in. Take over in the browser window." };
  if (state.assessment)
    return { category: "UNSUPPORTED_FIELD", message: "The page starts an assessment or timed test. CareerFiend does not take tests; take over or skip." };
  return null;
}

/* -------------------------------------------------------- read only */

export interface FormReading {
  fields: InspectedField[];
  /** Why the questions could not be read (sign-in wall, CAPTCHA, wrong site...), or null. */
  blocked: string | null;
  finalUrl: string;
}

/**
 * Read an application form's questions without touching it (public edition:
 * the answers are shown for copy and paste). Loads the page with the submit
 * guard installed, never types, selects or clicks; lists the questions of later
 * steps that are already on the page (hidden) too; if the page has no fields it
 * follows at most one "Apply" link on the same site.
 */
export async function readApplicationForm(page: Page, opts: Pick<EngineOptions, "targetUrl" | "allowedHosts" | "stepTimeoutMs">): Promise<FormReading> {
  await installGuard(page);
  const timeout = opts.stepTimeoutMs ?? 30_000;
  const open = async (url: string): Promise<string | null> => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    await settle(page, 1200);
    if (!hostAllowed(page.url(), opts.allowedHosts)) return `The application link led to ${new URL(page.url()).host}, which is not the application site.`;
    const blocker = blockerOf(await pageState(page));
    return blocker ? blocker.message.replace(/ Take over in the browser window\.$/, "").replace(/; take over or skip\.$/, ".") : null;
  };
  let blocked = await open(opts.targetUrl);
  let fields = blocked ? [] : await inspectFields(page, { includeHiddenSteps: true });
  if (!blocked && !fields.length) {
    const next = (await page.evaluate(`(() => {
      const links = Array.from(document.querySelectorAll("a[href]"));
      const a = links.find((l) => /\\bapply\\b/i.test(l.textContent || "") && /^https?:/.test(l.href) && l.href !== location.href);
      return a ? a.href : null;
    })()`)) as string | null;
    if (next && hostAllowed(next, opts.allowedHosts)) {
      blocked = await open(next);
      fields = blocked ? [] : await inspectFields(page, { includeHiddenSteps: true });
    }
  }
  const seen = new Set<string>();
  fields = fields.filter((f) => f.label && !seen.has(f.fieldKey) && seen.add(f.fieldKey));
  return { fields, blocked, finalUrl: page.url() };
}

/* ------------------------------------------------------------- prepare */

/**
 * Fill the application up to, and never including, final submission.
 * Clicks only controls classified as "next". Stops on any unresolved
 * required field, blocker, validation error or unexpected navigation.
 */
export async function prepareApplication(page: Page, opts: EngineOptions, propose: Proposer, startAtCurrentPage = false): Promise<PrepareResult> {
  const maxSteps = opts.maxSteps ?? 12;
  await installGuard(page);
  if (!startAtCurrentPage) {
    await page.goto(opts.targetUrl, { waitUntil: "domcontentloaded", timeout: opts.stepTimeoutMs ?? 30_000 });
  }
  await settle(page);
  const fields: FormFieldManifest[] = [];
  const steps: StepRecord[] = [];
  const result = (outcome: PrepareOutcome, category: FailureCategory | null, message: string, finalSubmitLabel: string | null = null): Promise<PrepareResult> =>
    page.evaluate("window.__cfBlockedSubmits || 0").then((blocked) => ({
      outcome,
      category,
      message,
      fields,
      steps,
      finalSubmitLabel,
      finalUrl: page.url(),
      blockedSubmits: blocked as number,
      questions: fields
        .filter((f) => f.required && (f.reviewState === "NEEDS_INPUT" || f.reviewState === "SENSITIVE_PENDING" || f.reviewState === "FILL_FAILED"))
        .map((f) => ({
          fieldKey: f.fieldKey,
          label: f.label,
          question: f.note && f.reviewState === "FILL_FAILED" ? `${f.label}: ${f.note}` : (f.note ?? f.label),
          semanticType: f.semanticType,
          options: f.options,
          sensitive: f.sensitive,
        })),
    }));

  for (let step = 1; step <= maxSteps; step++) {
    if (!hostAllowed(page.url(), opts.allowedHosts)) {
      return result("PAUSED", "UNEXPECTED_NAVIGATION", `The form navigated to ${new URL(page.url()).host}, which is not the application site.`);
    }
    const state = await pageState(page);
    const blocker = blockerOf(state);
    if (blocker) {
      steps.push(await snapshot(page, opts.outputDir, step, fields));
      return result("PAUSED", blocker.category, blocker.message);
    }
    if (state.confirmation) {
      steps.push(await snapshot(page, opts.outputDir, step, fields));
      return result(
        "FAILED",
        "PAGE_CHANGED",
        "The page already shows an application confirmation. It may have been submitted before; check your email before doing anything else.",
      );
    }

    // Fill until the visible field set stops changing (dynamic fields appear after answers).
    const done = new Set<string>();
    for (let pass = 0; pass < 3; pass++) {
      const inspected = (await inspectFields(page)).filter((f) => !done.has(f.raw.cfId));
      if (!inspected.length) break;
      for (const f of inspected) {
        done.add(f.raw.cfId);
        const p = await propose(f);
        const validation: string | null = f.raw.validation || null;
        let proposal = p;
        if (p.reviewState === "FILLED" && p.value !== null) {
          const current = f.raw.value;
          if (current !== p.value || f.control === "file" || f.control === "radio") {
            const err = await fillField(page, f, p.value);
            if (err) proposal = { ...p, reviewState: "FILL_FAILED", note: err };
          }
        }
        if (proposal.reviewState === "SKIPPED_OPTIONAL" && f.required) proposal = { ...proposal, reviewState: "NEEDS_INPUT" };
        fields.push(manifestEntry(step, f, proposal, validation));
      }
    }
    steps.push(await snapshot(page, opts.outputDir, step, fields));

    const unresolved = fields.filter((f) => f.step === step && f.required && ["NEEDS_INPUT", "SENSITIVE_PENDING", "FILL_FAILED"].includes(f.reviewState));
    if (unresolved.length) {
      const sensitive = unresolved.some((f) => f.reviewState === "SENSITIVE_PENDING");
      return result(
        "NEEDS_INPUT",
        sensitive ? "SENSITIVE_ANSWER_REQUIRED" : unresolved.some((f) => f.reviewState === "FILL_FAILED") ? "UNSUPPORTED_FIELD" : "MISSING_PROFILE_DATA",
        `${unresolved.length} required field(s) need your input on step ${step}.`,
      );
    }

    const buttons = await inspectButtons(page);
    const next = buttons.find((b) => b.role === "next");
    const final = buttons.find((b) => b.role === "final_submit");
    if (next) {
      const before = (await inspectFields(page)).map((f) => f.fieldKey).join("|");
      const beforeUrl = page.url();
      await page.locator(`[data-cf-id="${next.raw.cfId}"]`).evaluate((el: HTMLElement) => {
        el.dataset.cfAllowed = "1";
      });
      await page.locator(`[data-cf-id="${next.raw.cfId}"]`).click();
      await settle(page);
      await page.evaluate(GUARD_SCRIPT).catch(() => undefined);
      const after = (await inspectFields(page)).map((f) => f.fieldKey).join("|");
      if (after === before && page.url() === beforeUrl) {
        const st = await pageState(page);
        const invalid = (await inspectFields(page)).filter((f) => f.raw.invalid || f.raw.validation);
        const msgs = [...st.visibleErrors, ...invalid.map((f) => `${f.label}: ${f.raw.validation || "invalid"}`)];
        for (const f of invalid) {
          const entry = fields.find((x) => x.fieldKey === f.fieldKey && x.step === step);
          if (entry) {
            entry.reviewState = "NEEDS_INPUT";
            entry.validationMessage = f.raw.validation || "The site rejected this value.";
          }
        }
        steps.push(await snapshot(page, opts.outputDir, step, fields));
        return result(
          "NEEDS_INPUT",
          "VALIDATION_FAILED",
          msgs.length ? `The site rejected values: ${msgs.join("; ")}` : "The form did not advance. Take over to see why.",
        );
      }
      continue;
    }
    if (final) {
      return result("READY", null, `Stopped before final submission ("${final.raw.name}").`, final.raw.name);
    }
    return result("PAUSED", "PAGE_CHANGED", "No Next or Submit control was found. Take over in the browser window.");
  }
  return result("PAUSED", "PAGE_CHANGED", `The form has more than ${maxSteps} steps.`);
}

/* -------------------------------------------------------------- submit */

export interface RevisionAnswers {
  /** fieldKey → value (as staged in the approved revision). */
  answers: Record<string, string>;
  /** fieldKey → exact file that was reviewed. */
  uploads: Record<string, { path: string; sha256: string }>;
}

export interface SubmitResult {
  result: "SUBMITTED" | "FAILED" | "UNCERTAIN";
  confirmationUrl: string | null;
  confirmationText: string | null;
  screenshotPath: string | null;
  errorCategory: FailureCategory | null;
  message: string;
}

/**
 * Replay the approved revision and click the final submit control once.
 * Called only by the core submission service after the approval invariant
 * passed and the attempt row (idempotency key) was committed. Never retried.
 */
export async function submitRevision(page: Page, opts: EngineOptions & { confirmTimeoutMs?: number }, revision: RevisionAnswers): Promise<SubmitResult> {
  // Uploads must be the exact reviewed bytes.
  for (const [key, up] of Object.entries(revision.uploads)) {
    const actual = sha256(readFileSync(up.path));
    if (actual !== up.sha256) {
      return {
        result: "FAILED",
        confirmationUrl: null,
        confirmationText: null,
        screenshotPath: null,
        errorCategory: "VALIDATION_FAILED",
        message: `Upload for ${key} changed on disk since approval (hash mismatch). Nothing was submitted.`,
      };
    }
  }
  const replay: Proposer = async (f) => {
    const upload = revision.uploads[f.fieldKey];
    const value = upload?.path ?? revision.answers[f.fieldKey];
    if (value === undefined || value === "") {
      return {
        value: null,
        confidence: 0,
        source: "none",
        provenance: [],
        reviewState: f.required ? "NEEDS_INPUT" : "SKIPPED_OPTIONAL",
        sensitive: false,
        note: "Not in the approved revision.",
      };
    }
    return {
      value,
      confidence: 1,
      source: upload ? "document" : "user-answer",
      provenance: ["approved-revision"],
      reviewState: "FILLED",
      sensitive: false,
      note: null,
    };
  };
  const prepared = await prepareApplication(page, opts, replay);
  if (prepared.outcome !== "READY") {
    return {
      result: "FAILED",
      confirmationUrl: null,
      confirmationText: null,
      screenshotPath: prepared.steps.at(-1)?.screenshotPath ?? null,
      errorCategory: prepared.category ?? "PAGE_CHANGED",
      message: `The form no longer matches the approved revision (${prepared.message}). Nothing was submitted.`,
    };
  }
  // Every field on the form must have been filled from the revision.
  const extra = prepared.fields.filter((f) => f.required && f.reviewState !== "FILLED");
  if (extra.length) {
    return {
      result: "FAILED",
      confirmationUrl: null,
      confirmationText: null,
      screenshotPath: null,
      errorCategory: "PAGE_CHANGED",
      message: `Required fields not in the approved revision: ${extra.map((f) => f.label).join(", ")}. Nothing was submitted.`,
    };
  }
  const buttons = await inspectButtons(page);
  const final = buttons.find((b) => b.role === "final_submit");
  if (!final) {
    return {
      result: "FAILED",
      confirmationUrl: null,
      confirmationText: null,
      screenshotPath: null,
      errorCategory: "PAGE_CHANGED",
      message: "Final submit control not found. Nothing was submitted.",
    };
  }
  const beforeUrl = page.url();
  const loc = page.locator(`[data-cf-id="${final.raw.cfId}"]`);
  await loc.evaluate((el: HTMLElement) => {
    el.dataset.cfAllowed = "1";
  });
  // From this click on, any failure is ambiguous: the site may have received it.
  try {
    await loc.click({ noWaitAfter: true });
  } catch (err) {
    return {
      result: "UNCERTAIN",
      confirmationUrl: page.url(),
      confirmationText: null,
      screenshotPath: null,
      errorCategory: "SUBMISSION_UNCERTAIN",
      message: `Clicking submit raised an error: ${(err as Error).message.split("\n")[0]}`,
    };
  }
  const deadline = Date.now() + (opts.confirmTimeoutMs ?? 20_000);
  let state: PageState | null = null;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    try {
      state = await pageState(page);
    } catch {
      continue; // navigating
    }
    if (state.confirmation) break;
    if (page.url() === beforeUrl && state.visibleErrors.length) break;
  }
  const shotDir = path.join(opts.outputDir, "steps");
  mkdirSync(shotDir, { recursive: true });
  const screenshotPath = path.join(shotDir, "submission-result.png");
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
  if (state?.confirmation) {
    return {
      result: "SUBMITTED",
      confirmationUrl: page.url(),
      confirmationText: state.bodyTextSample.slice(0, 300),
      screenshotPath,
      errorCategory: null,
      message: "Confirmation page detected.",
    };
  }
  if (state && page.url() === beforeUrl && state.visibleErrors.length) {
    return {
      result: "FAILED",
      confirmationUrl: page.url(),
      confirmationText: null,
      screenshotPath,
      errorCategory: "VALIDATION_FAILED",
      message: `The site showed errors after submit: ${state.visibleErrors.join("; ")}`,
    };
  }
  return {
    result: "UNCERTAIN",
    confirmationUrl: page.url(),
    confirmationText: state?.bodyTextSample.slice(0, 300) ?? null,
    screenshotPath,
    errorCategory: "SUBMISSION_UNCERTAIN",
    message: "No confirmation was detected. Do not resubmit; check your email and the employer portal.",
  };
}
