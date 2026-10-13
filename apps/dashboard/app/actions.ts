"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  addWatchlistCompany,
  applyToJob,
  answerQuestion,
  approve,
  assignEmail,
  changePassword,
  connectLm,
  deleteAccount,
  disconnectLm,
  editResume,
  skipLm,
  startBlankResume,
  uploadResumePdf,
  defer,
  deleteApplicationData,
  disconnectGmail,
  dismissEmail,
  editAnswer,
  editCoverLetter,
  enqueue,
  describeEnqueue,
  enqueueUrls,
  gmailProvider,
  pollEmail,
  markAppliedManually,
  regenerate,
  rejectApplication,
  reprioritize,
  requestSubmission,
  requestProjectIdeas,
  requestDemandMap,
  requestTransferRefresh,
  setBankedSkillStatus,
  ProjectIdeasError,
  resolveUncertain,
  resumeTakeover,
  retryPreparation,
  startGmailConnect,
  updateWorkerSettings,
} from "@careerfiend/core";
import { decideSkill, parseResumeDate, setProfileValue, slugify, ANSWER_SPECS, type Experience, type Resume } from "@careerfiend/profile";
import type { EmailClass } from "@careerfiend/shared";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@careerfiend/shared";
import { baseCtx, ctx } from "@/lib/ctx";
import { sessionCookieOptions } from "@/lib/cookie";
import { requireSession } from "@/lib/session";
import { kickProjects, kickWorker } from "@/lib/kick";

function back(path: string, result: { msg?: string; error?: string }): never {
  const u = new URLSearchParams();
  if (result.msg) u.set("msg", result.msg);
  if (result.error) u.set("error", result.error);
  revalidatePath(path.split("?")[0]!);
  redirect(`${path}${path.includes("?") ? "&" : "?"}${u.toString()}`);
}

async function attempt(path: string, fn: () => Promise<string>): Promise<never> {
  let result: { msg?: string; error?: string };
  try {
    result = { msg: await fn() };
    kickWorker(); // hosted: anything you do may have queued work for the worker
  } catch (err) {
    const reasons = (err as { reasons?: string[] }).reasons;
    result = { error: reasons?.length ? reasons.join(" ") : (err as Error).message };
  }
  back(path, result);
}

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

/* ---------------------------------------------------------- daily queue */

export async function addUrls(f: FormData) {
  await requireSession();
  await attempt("/", async () => {
    return describeEnqueue(await enqueueUrls(await ctx(), str(f, "urls")));
  });
}

export async function saveWorkerSettings(f: FormData) {
  await requireSession();
  await attempt("/", async () => {
    const limit = str(f, "dailyLimit");
    await updateWorkerSettings(await ctx(), { dailyLimit: limit ? Number(limit) : null, runWindow: str(f, "runWindow"), endOfDay: str(f, "endOfDay") });
    return "Worker settings saved.";
  });
}

export async function toggleWorker(f: FormData) {
  await requireSession();
  await attempt("/", async () => {
    const paused = str(f, "paused") === "true";
    await updateWorkerSettings(await ctx(), { paused });
    return paused ? "Worker paused." : "Worker resumed.";
  });
}

export async function runWorkerNowAction() {
  await requireSession();
  await attempt("/", async () => {
    if ((await ctx()).config.CAREERFIEND_MODE !== "hosted") return "Start the worker on your computer with npm run worker.";
    return "Worker started. It works through the queue in the background; refresh in a minute.";
  });
}

/** Bulk actions: reject, defer, reprioritize only. Never approve or submit. */
export async function bulkAction(f: FormData) {
  await requireSession();
  await attempt("/", async () => {
    const ids = f.getAll("ids").map(String);
    const action = str(f, "action");
    if (!ids.length) throw new Error("Select at least one application.");
    for (const id of ids) {
      if (action === "reject") await rejectApplication(await ctx(), id, "Bulk reject");
      else if (action === "defer") await defer(await ctx(), id, Number(str(f, "days") || 1));
      else if (action === "priority") await reprioritize(await ctx(), id, Number(str(f, "priority") || 0));
      else throw new Error("Unknown bulk action.");
    }
    return `${action} applied to ${ids.length} application(s).`;
  });
}

/* -------------------------------------------------------- application */

const appPath = (id: string) => `/applications/${id}`;

export async function answerQuestionAction(f: FormData) {
  await requireSession();
  const id = str(f, "applicationId");
  await attempt(appPath(id), async () => {
    const r = await answerQuestion(await ctx(), str(f, "questionId"), str(f, "answer"), { reusable: f.get("reusable") === "on" });
    return r.requeued ? "Answer saved. The worker will continue preparing this application." : "Answer saved.";
  });
}

export async function resumeTakeoverAction(f: FormData) {
  await requireSession();
  const id = str(f, "applicationId");
  await attempt(appPath(id), async () => ((await resumeTakeover(await ctx(), id)) ? "Resumed. The worker continues from the current page." : "Recorded."));
}

export async function editAnswerAction(f: FormData) {
  await requireSession();
  const id = str(f, "applicationId");
  await attempt(appPath(id), async () => {
    const r = await editAnswer(await ctx(), id, str(f, "fieldKey"), String(f.get("value") ?? ""));
    return `Saved as revision ${r.revisionNumber}. Any earlier approval is no longer valid.`;
  });
}

export async function editLetterAction(f: FormData) {
  await requireSession();
  const id = str(f, "applicationId");
  await attempt(appPath(id), async () => {
    const paragraphs = String(f.get("letter") ?? "").split(/\n\s*\n/);
    const r = await editCoverLetter(await ctx(), id, paragraphs);
    return `Cover letter saved as revision ${r.revisionNumber}.${r.problems.length ? ` Check: ${r.problems.join(" ")}` : ""}`;
  });
}

export async function approveAction(f: FormData) {
  await requireSession();
  const id = str(f, "applicationId");
  await attempt(appPath(id), async () => {
    await approve(await ctx(), id, {
      revisionHash: str(f, "revisionHash"),
      confirmation: str(f, "confirmation"),
      acknowledgedWarnings: f.getAll("ack").map(String),
    });
    return "Approved. Nothing has been submitted. Confirm submission separately when you are ready.";
  });
}

export async function submitAction(f: FormData) {
  await requireSession();
  const id = str(f, "applicationId");
  await attempt(appPath(id), async () => {
    const r = await requestSubmission(await ctx(), id, { confirmation: str(f, "confirmation") });
    return r.existing
      ? "This approval was already used; no second submission was created."
      : "Submission queued. The worker submits it once and records the confirmation.";
  });
}

export async function rejectAction(f: FormData) {
  await requireSession();
  const id = str(f, "applicationId");
  await attempt(appPath(id), async () => {
    await rejectApplication(await ctx(), id, str(f, "reason"));
    return "Application rejected.";
  });
}

export async function regenerateAction(f: FormData) {
  await requireSession();
  const id = str(f, "applicationId");
  await attempt(appPath(id), async () => {
    const kind = await regenerate(await ctx(), id);
    return kind === "draft"
      ? "Regenerating the résumé, cover letter and answers. This takes a minute or two; reload to see them."
      : "Regenerating the résumé and cover letter. This takes a minute or two; reload to see them. The application's status does not change.";
  });
}

export async function retryAction(f: FormData) {
  await requireSession();
  const id = str(f, "applicationId");
  await attempt(appPath(id), async () => {
    await retryPreparation(await ctx(), id);
    return "Preparation re-queued.";
  });
}

export async function markAppliedAction(f: FormData) {
  await requireSession();
  const id = str(f, "applicationId");
  await attempt(appPath(id), async () => {
    await markAppliedManually(await ctx(), id, str(f, "note"));
    return "Marked as applied. Replies to this application are now tracked.";
  });
}

export async function resolveUncertainAction(f: FormData) {
  await requireSession();
  const id = str(f, "applicationId");
  await attempt(appPath(id), async () => {
    const outcome = str(f, "outcome") === "SUBMITTED" ? "SUBMITTED" : "FAILED";
    await resolveUncertain(await ctx(), id, outcome, str(f, "note"));
    return outcome === "SUBMITTED" ? "Marked as submitted." : "Marked as not submitted. It is waiting for you to apply yourself.";
  });
}

export async function deleteApplicationAction(f: FormData) {
  await requireSession();
  const id = str(f, "applicationId");
  if (str(f, "confirmation") !== "DELETE") back(appPath(id), { error: "Type DELETE to confirm." });
  let error: string | undefined;
  try {
    await deleteApplicationData(await ctx(), id);
  } catch (err) {
    error = (err as Error).message;
  }
  if (error) back(appPath(id), { error });
  back("/tracker", { msg: "Application data deleted." });
}

/* --------------------------------------------------------------- skills */

export async function skillDecisionAction(f: FormData) {
  await requireSession();
  await attempt(`/skills${str(f, "returnQuery")}`, async () => {
    const decision = str(f, "decision") as "CONFIRMED_BY_USER" | "REJECTED_BY_USER" | "UNVERIFIED";
    await decideSkill((await ctx()).db, str(f, "skillId"), decision, "user:dashboard", "Skills page");
    return "Saved.";
  });
}

/* ------------------------------------------------------------------ jobs */

export async function applyToJobAction(f: FormData) {
  await requireSession();
  await attempt("/jobs", async () => applyToJob(await ctx(), str(f, "jobId")));
}

/* ------------------------------------------------------------ skill bank */

export async function bankStatusAction(f: FormData) {
  await requireSession();
  const status = str(f, "status") === "REMOVED" ? "REMOVED" : "ACTIVE";
  await attempt(`/bank${str(f, "returnQuery")}`, async () => setBankedSkillStatus(await ctx(), str(f, "id"), status));
}

export async function refreshTransfersAction() {
  await requireSession();
  await attempt("/bank", async () => requestTransferRefresh(await ctx()));
}

/* -------------------------------------------------------------- profile */

export async function setProfileValueAction(f: FormData) {
  await requireSession();
  await attempt("/profile", async () => {
    const key = str(f, "key");
    const spec = ANSWER_SPECS.find((s) => s.key === key);
    const existing = await (await ctx()).db.profileValue.findUnique({ where: { key } });
    const value = str(f, "value");
    if (!value) throw new Error("Enter a value.");
    await setProfileValue(
      (await ctx()).db,
      { key, label: spec?.label ?? existing?.label ?? key, value, sensitive: spec?.sensitive ?? existing?.sensitive ?? false, source: "dashboard" },
      (await ctx()).key(),
    );
    return "Saved.";
  });
}

/* ---------------------------------------------------------------- email */

export async function gmailConnectAction(f: FormData) {
  await requireSession();
  let url: string | null = null;
  let error: string | undefined;
  try {
    const c = (await ctx()).config;
    // Hosted: a "Web application" OAuth client with this redirect URI; local: a Desktop client (loopback).
    const origin = c.PUBLIC_URL ?? `http://127.0.0.1:${c.DASHBOARD_PORT}`;
    url = await startGmailConnect(await ctx(), `${origin.replace(/\/$/, "")}/api/gmail/callback`, str(f, "mode") === "readonly" ? "readonly" : "label");
  } catch (err) {
    error = (err as Error).message;
  }
  if (error || !url) back("/email", { error: error ?? "Could not start Gmail connection." });
  redirect(url);
}

export async function gmailDisconnectAction() {
  await requireSession();
  await attempt("/email", async () => {
    await disconnectGmail(await ctx());
    return "Gmail disconnected. Tokens were revoked at Google and deleted locally.";
  });
}

export async function pollEmailAction() {
  await requireSession();
  await attempt("/email", async () => {
    const provider = await gmailProvider(await ctx());
    if (!provider) throw new Error("Gmail is not connected.");
    const r = await pollEmail(await ctx(), provider);
    return `Checked ${r.processed} new message(s): ${r.matched} matched, ${r.unmatched} need review, ${r.ignored} unrelated.`;
  });
}

export async function assignEmailAction(f: FormData) {
  await requireSession();
  await attempt("/email", async () => {
    const provider = await gmailProvider(await ctx());
    const { FakeEmailProvider } = await import("@careerfiend/email");
    await assignEmail(
      await ctx(),
      provider ?? new FakeEmailProvider("readonly"),
      str(f, "emailId"),
      str(f, "applicationId"),
      (str(f, "classification") || undefined) as EmailClass | undefined,
    );
    return "Email assigned.";
  });
}

export async function dismissEmailAction(f: FormData) {
  await requireSession();
  await attempt("/email", async () => {
    await dismissEmail(await ctx(), str(f, "emailId"));
    return "Dismissed.";
  });
}

/* --------------------------------------------------- project ideas */

export async function rebuildDemandAction() {
  await requireSession();
  await attempt("/projects", async () => requestDemandMap(await ctx()));
}

export async function generateProjectIdeasAction(f: FormData) {
  await requireSession();
  const trigger = str(f, "trigger") === "refresh" ? "refresh" : "initial";
  let error: string | undefined;
  try {
    await requestProjectIdeas(await ctx(), trigger);
    kickProjects(await ctx());
  } catch (err) {
    error = err instanceof ProjectIdeasError ? err.message : (err as Error).message;
  }
  back("/projects", error ? { error } : { msg: "Researching the market for your queue. This takes 2 to 5 minutes; the page updates by itself." });
}

/* ------------------------------------------------------------ watchlist */

export async function addWatchAction(f: FormData) {
  await requireSession();
  await attempt("/watchlist", async () => {
    const ats = str(f, "ats") as "greenhouse" | "lever" | "ashby";
    if (!["greenhouse", "lever", "ashby"].includes(ats)) throw new Error("Choose Greenhouse, Lever or Ashby.");
    if (!/^[A-Za-z0-9_.-]+$/.test(str(f, "boardSlug"))) throw new Error("Board slug may contain letters, digits, dot, dash and underscore only.");
    await addWatchlistCompany(await ctx(), { ats, boardSlug: str(f, "boardSlug"), name: str(f, "name") });
    return "Company added.";
  });
}

export async function toggleWatchAction(f: FormData) {
  await requireSession();
  await attempt("/watchlist", async () => {
    const id = str(f, "id");
    const row = await (await ctx()).db.watchlistCompany.findUniqueOrThrow({ where: { id } });
    await (await ctx()).db.watchlistCompany.update({ where: { id }, data: { enabled: !row.enabled } });
    return row.enabled ? "Disabled." : "Enabled.";
  });
}

export async function pollWatchlistNowAction() {
  await requireSession();
  await attempt("/watchlist", async () => {
    await enqueue((await ctx()).db, "WATCHLIST_POLL", {}, { dedupeKey: "manual:watchlist" });
    return "Watchlist poll queued for the worker.";
  });
}

/* ------------------------------------------------------ résumé (public) */

export async function uploadResumeAction(f: FormData) {
  await requireSession();
  const back = str(f, "back") === "/" ? "/" : "/profile";
  await attempt(back, async () => {
    const file = f.get("resume");
    if (!(file instanceof File) || !file.size) throw new Error("Choose your résumé PDF first.");
    const r = await uploadResumePdf(await ctx(), { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    const how = r.method === "rules+model" ? "with your language model" : "with the built-in reader";
    return [
      `Résumé read ${how}: ${r.experiences} entr${r.experiences === 1 ? "y" : "ies"}, ${r.skills} skill${r.skills === 1 ? "" : "s"} (version ${r.version}).`,
      ...r.notes,
      "Review everything on the Profile page.",
    ].join(" ");
  });
}

export async function startBlankResumeAction(f: FormData) {
  await requireSession();
  await attempt("/profile", async () => {
    await startBlankResume(await ctx(), str(f, "name"));
    return "Profile started. Add your experience, projects and education below.";
  });
}

function parseLinks(text: string): { label: string; url: string }[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [a, b] = l.includes("|") ? l.split("|").map((x) => x.trim()) : ["", l];
      const url = /^https?:\/\//i.test(b!) ? b! : `https://${b}`;
      let label = a || "Website";
      try {
        const host = new URL(url).hostname;
        if (!a) label = /linkedin/.test(host) ? "LinkedIn" : /github/.test(host) ? "GitHub" : "Website";
      } catch {
        throw new Error(`Not a link: ${b}`);
      }
      return { label, url };
    });
}

export async function saveContactAction(f: FormData) {
  await requireSession();
  await attempt("/profile", async () => {
    const r = await editResume(await ctx(), (res) => {
      res.profile = {
        name: str(f, "name"),
        headline: str(f, "headline"),
        location: str(f, "location"),
        email: str(f, "email"),
        links: parseLinks(String(f.get("links") ?? "")),
      };
    });
    return r.changed ? `Saved (version ${r.version}).` : "No changes.";
  });
}

function dateField(f: FormData, name: string, label: string): string {
  const raw = str(f, name);
  if (!raw) return "";
  const d = /^\d{4}(-\d{2})?$/.test(raw) ? raw : parseResumeDate(raw);
  if (!d) throw new Error(`${label}: write a month like "2023-01" or "Jan 2023", or a year like "2023".`);
  return d;
}

export async function saveEntryAction(f: FormData) {
  await requireSession();
  await attempt("/profile", async () => {
    const id = str(f, "id");
    const type = str(f, "type") as Experience["type"];
    if (!["work", "project", "education"].includes(type)) throw new Error("Choose a section.");
    const title = str(f, "title");
    if (!title) throw new Error("Give the entry a title (job title, project name or degree).");
    const present = f.get("present") === "on";
    const url = str(f, "url");
    if (url && !/^https?:\/\/\S+$/i.test(url)) throw new Error("The link must start with https://");
    const fields = {
      type,
      title,
      organization: str(f, "organization"),
      location: str(f, "location"),
      startDate: dateField(f, "start", "Start"),
      endDate: present ? null : dateField(f, "end", "End"),
      summary: "",
      responsibilities: String(f.get("bullets") ?? "")
        .split(/\r?\n/)
        .map((l) => l.replace(/^\s*[•\-*▪●]\s*/, "").trim())
        .filter(Boolean),
    };
    const r = await editResume(await ctx(), (res: Resume) => {
      const existing = res.experiences.find((e) => e.id === id);
      if (existing) {
        Object.assign(existing, fields);
        if (url) existing.url = url;
        else delete existing.url;
        return;
      }
      const used = new Set(res.experiences.map((e) => e.id));
      let newId = slugify(`${fields.organization} ${fields.title}`, type);
      for (let n = 2; used.has(newId); n++) newId = `${slugify(`${fields.organization} ${fields.title}`, type)}-${n}`;
      res.experiences.push({ id: newId, ...fields, ...(url ? { url } : {}), endorsedSkills: [], gallery: [], thumbnailId: null });
    });
    return r.changed ? `Saved (version ${r.version}).` : "No changes.";
  });
}

export async function deleteEntryAction(f: FormData) {
  await requireSession();
  await attempt("/profile", async () => {
    const id = str(f, "id");
    await editResume(await ctx(), (res) => {
      res.experiences = res.experiences.filter((e) => e.id !== id);
    });
    return "Entry removed.";
  });
}

export async function moveEntryAction(f: FormData) {
  await requireSession();
  await attempt("/profile", async () => {
    const id = str(f, "id");
    const dir = str(f, "dir") === "up" ? -1 : 1;
    await editResume(await ctx(), (res) => {
      const list = res.experiences;
      const i = list.findIndex((e) => e.id === id);
      if (i < 0) return;
      // Swap with the nearest entry of the same section.
      for (let j = i + dir; j >= 0 && j < list.length; j += dir) {
        if (list[j]!.type === list[i]!.type) {
          [list[i], list[j]] = [list[j]!, list[i]!];
          break;
        }
      }
    });
    return "Moved.";
  });
}

export async function saveSkillsAction(f: FormData) {
  await requireSession();
  await attempt("/profile", async () => {
    const split = (k: string) =>
      String(f.get(k) ?? "")
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter((s) => s && s.length <= 60);
    const r = await editResume(await ctx(), (res) => {
      const used = new Set<string>();
      const prior = new Map(res.skills.map((s) => [s.label.toLowerCase(), s.id]));
      const skills: Resume["skills"] = [];
      for (const category of ["technical", "soft", "domain"] as const) {
        for (const label of split(category)) {
          if (skills.some((s) => s.label.toLowerCase() === label.toLowerCase())) continue;
          let id = prior.get(label.toLowerCase()) ?? slugify(label, "skill");
          for (let n = 2; used.has(id); n++) id = `${slugify(label, "skill")}-${n}`;
          used.add(id);
          skills.push({ id, label, category });
        }
      }
      res.skills = skills;
      const langs: string[] = [];
      for (const l of split("languages")) if (!langs.some((x) => x.toLowerCase() === l.toLowerCase())) langs.push(l);
      res.languages = langs;
    });
    return r.changed ? `Skills saved (version ${r.version}).` : "No changes.";
  });
}

export async function setGithubUserAction(f: FormData) {
  await requireSession();
  await attempt("/profile", async () => {
    const user = str(f, "githubUser")
      .replace(/^https?:\/\/github\.com\//i, "")
      .replace(/\/.*$/, "");
    if (user && !/^[A-Za-z0-9-]{1,39}$/.test(user)) throw new Error("That is not a GitHub user name.");
    const c = await ctx();
    if (user) await c.db.setting.upsert({ where: { key: "profile.githubUser" }, create: { key: "profile.githubUser", value: user }, update: { value: user } });
    else await c.db.setting.deleteMany({ where: { key: "profile.githubUser" } });
    await c.db.setting.deleteMany({ where: { key: { in: ["github.repos", "github.status"] } } });
    return user ? `Public repositories of ${user} will back your transferable skills.` : "GitHub projects turned off.";
  });
}

/* ------------------------------------------------- language model (public) */

export async function connectLmAction(f: FormData) {
  await requireSession();
  const back = str(f, "back") === "/" ? "/" : "/settings";
  await attempt(back, async () => {
    const s = await connectLm(await ctx(), {
      provider: str(f, "provider"),
      model: str(f, "model"),
      fastModel: str(f, "fastModel"),
      baseUrl: str(f, "baseUrl"),
      apiKey: String(f.get("apiKey") ?? ""),
    });
    return s.status === "connected" ? `Connected to ${s.providerLabel} (${s.model}). Project Recommendations are on.` : "Saved.";
  });
}

export async function skipLmAction(f: FormData) {
  await requireSession();
  const back = str(f, "back") === "/" ? "/" : "/settings";
  await attempt(back, async () => {
    await skipLm(await ctx());
    return "Skipped. Everything except Project Recommendations works without a model; connect one any time in Settings.";
  });
}

export async function disconnectLmAction() {
  await requireSession();
  await attempt("/settings", async () => {
    await disconnectLm(await ctx());
    return "Language model disconnected and its key deleted.";
  });
}

/* --------------------------------------------------------- account (public) */

export async function changePasswordAction(f: FormData) {
  await requireSession();
  const c = await ctx();
  let error: string | undefined;
  try {
    if (String(f.get("next") ?? "") !== String(f.get("confirm") ?? "")) throw new Error("The new passwords do not match.");
    const token = await changePassword(baseCtx(), c.account!.id, String(f.get("current") ?? ""), String(f.get("next") ?? ""));
    (await cookies()).set(SESSION_COOKIE, token, sessionCookieOptions());
  } catch (err) {
    error = (err as Error).message;
  }
  back("/settings", error ? { error } : { msg: "Password changed. Other devices were signed out." });
}

export async function deleteAccountAction(f: FormData) {
  await requireSession();
  const c = await ctx();
  if (str(f, "confirmation") !== "DELETE") back("/settings", { error: "Type DELETE to confirm." });
  let error: string | undefined;
  try {
    await deleteAccount(baseCtx(), c.account!.id, String(f.get("password") ?? ""));
  } catch (err) {
    error = (err as Error).message;
  }
  if (error) back("/settings", { error });
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login?msg=" + encodeURIComponent("Your account and all of its data were deleted."));
}
