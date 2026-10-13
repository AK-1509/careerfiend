import { canTransition, decrypt, encrypt, randomId, type ApplicationState, type EmailClass } from "@careerfiend/shared";
import { fromJson, toJson } from "@careerfiend/db";
import {
  applicationLabel,
  authorizationUrl,
  classifyDeterministic,
  exchangeCode,
  GmailProvider,
  matchEmail,
  pkcePair,
  revokeTokens,
  ROOT_LABEL,
  searchQuery,
  STATUS_LABELS,
  type EmailMeta,
  type EmailProvider,
  type HttpFetch,
  type OAuthTokens,
  type TokenStore,
  type TrackedApplication,
} from "@careerfiend/email";
import type { AppContext } from "./context";
import { transition } from "./transitions";

const POST_SUBMIT = ["SUBMITTED", "CONFIRMATION_RECEIVED", "RESPONDED", "INTERVIEW", "OFFER"];

/** Which state a classified email moves an application to (when valid). */
export const EMAIL_STATE: Record<EmailClass, ApplicationState | null> = {
  confirmation: "CONFIRMATION_RECEIVED",
  action_required: "RESPONDED",
  recruiter_response: "RESPONDED",
  interview: "INTERVIEW",
  rejection: "REJECTED",
  offer: "OFFER",
  other: null,
};

async function trackedApplications(ctx: AppContext): Promise<TrackedApplication[]> {
  const apps = await ctx.db.application.findMany({ where: { state: { in: POST_SUBMIT } }, include: { job: true, emails: true } });
  return apps.map((a) => {
    const t = fromJson<{
      company?: string;
      role?: string;
      domains?: string[];
      atsHosts?: string[];
      atsIdentifiers?: Record<string, string>;
      recipient?: string;
      submittedAt?: string;
    }>(a.tracking, {});
    return {
      id: a.id,
      company: t.company ?? a.job.company,
      role: t.role ?? a.job.title,
      domains: t.domains ?? [],
      atsHosts: t.atsHosts ?? [],
      atsIdentifiers: t.atsIdentifiers ?? {},
      recipient: t.recipient ?? null,
      submittedAt: new Date(t.submittedAt ?? a.updatedAt),
      threadIds: a.emails.map((e) => e.threadId),
    };
  });
}

async function applyMatch(
  ctx: AppContext,
  provider: EmailProvider,
  emailId: string,
  msg: EmailMeta,
  applicationId: string,
  cls: EmailClass,
  confidence: number,
  evidence: unknown,
  assignedBy: "auto" | "manual",
): Promise<void> {
  const app = await ctx.db.application.findUniqueOrThrow({ where: { id: applicationId }, include: { job: true } });
  const appLabel = applicationLabel(app.job.company, app.job.title, app.id);
  const statusLabel = STATUS_LABELS[cls];
  const labelNames = [ROOT_LABEL, appLabel, ...(statusLabel ? [statusLabel] : [])];
  if (provider.mode === "label") {
    const ids: string[] = [];
    for (const n of labelNames) ids.push(await provider.ensureLabel(n));
    await provider.addLabels(msg.id, ids);
  }
  await ctx.db.emailThreadLink.upsert({
    where: { applicationId_messageId: { applicationId, messageId: msg.id } },
    create: {
      id: randomId("etl"),
      applicationId,
      emailId,
      threadId: msg.threadId,
      messageId: msg.id,
      evidence: toJson(evidence),
      label: appLabel,
      classification: cls,
      confidence,
      assignedBy,
    },
    update: { classification: cls, confidence, assignedBy },
  });
  const to = EMAIL_STATE[cls];
  if (to && app.state !== to && canTransition(app.state as ApplicationState, to)) {
    await transition(ctx.db, applicationId, to, `email:${provider.name}`, `${cls} email: "${msg.subject.slice(0, 80)}"`);
  } else {
    await ctx.db.statusEvent.create({
      data: {
        id: randomId("se"),
        applicationId,
        from: app.state,
        to: app.state,
        actor: `email:${provider.name}`,
        reason: `${cls} email: "${msg.subject.slice(0, 80)}"`,
      },
    });
  }
}

export interface PollSummary {
  processed: number;
  matched: number;
  unmatched: number;
  ignored: number;
  skippedAlreadySeen: number;
}

/**
 * One incremental poll. Idempotent: a message id is processed once (unique
 * providerId), and the cursor advances only after the batch succeeds.
 */
export async function pollEmail(ctx: AppContext, provider: EmailProvider): Promise<PollSummary> {
  const apps = await trackedApplications(ctx);
  const summary: PollSummary = { processed: 0, matched: 0, unmatched: 0, ignored: 0, skippedAlreadySeen: 0 };
  if (!apps.length) return summary;
  const cursorKey = `email.cursor.${provider.name}`;
  const cursor = (await ctx.db.setting.findUnique({ where: { key: cursorKey } }))?.value ?? null;
  const page = await provider.sync(cursor, searchQuery(apps));
  for (const msg of page.messages) {
    if (await ctx.db.emailMessage.findUnique({ where: { providerId: msg.id } })) {
      summary.skippedAlreadySeen++;
      continue;
    }
    summary.processed++;
    const decision = matchEmail(msg, apps);
    let cls = classifyDeterministic(msg);
    if (decision.status === "MATCHED" && cls.classification === "other" && ctx.ai.available) {
      try {
        const ai = await ctx.ai.classifyEmail({ subject: msg.subject, from: msg.from, snippet: msg.snippet });
        if (ai.confidence >= 0.75) cls = ai;
      } catch (err) {
        ctx.logger.warn("email.ai_classify_failed", { error: err });
      }
    }
    const emailId = randomId("em");
    const keep = decision.status !== "IGNORED";
    await ctx.db.emailMessage.create({
      data: {
        id: emailId,
        providerId: msg.id,
        threadId: msg.threadId,
        // Data minimization: unrelated mail keeps only its id.
        fromAddress: keep ? msg.from : "",
        toAddress: keep ? msg.to : null,
        subject: keep ? msg.subject : "",
        snippet: keep ? msg.snippet.slice(0, 500) : "",
        receivedAt: msg.date,
        matchStatus: decision.status,
        classification: keep ? cls.classification : null,
        confidence: keep ? cls.confidence : null,
        evidence: toJson(keep ? decision.candidates : []),
      },
    });
    if (decision.status === "MATCHED") {
      await applyMatch(
        ctx,
        provider,
        emailId,
        msg,
        decision.best!.applicationId,
        cls.classification,
        Math.min(cls.confidence, decision.best!.score),
        decision.best,
        "auto",
      );
      summary.matched++;
    } else if (decision.status === "UNMATCHED") summary.unmatched++;
    else summary.ignored++;
  }
  if (page.cursor) await ctx.db.setting.upsert({ where: { key: cursorKey }, create: { key: cursorKey, value: page.cursor }, update: { value: page.cursor } });
  ctx.logger.info("email.polled", { count: summary.processed, status: `${summary.matched}/${summary.unmatched}/${summary.ignored}` });
  return summary;
}

/** Manual assignment from the Unmatched queue. */
export async function assignEmail(
  ctx: AppContext,
  provider: EmailProvider,
  emailId: string,
  applicationId: string,
  classification?: EmailClass,
): Promise<void> {
  const e = await ctx.db.emailMessage.findUniqueOrThrow({ where: { id: emailId } });
  const msg: EmailMeta = {
    id: e.providerId,
    threadId: e.threadId,
    from: e.fromAddress,
    to: e.toAddress ?? "",
    subject: e.subject,
    date: e.receivedAt,
    snippet: e.snippet,
  };
  const cls = classification ?? (e.classification as EmailClass | null) ?? "other";
  await applyMatch(ctx, provider, e.id, msg, applicationId, cls, 1, { manual: true }, "manual");
  await ctx.db.emailMessage.update({ where: { id: e.id }, data: { matchStatus: "MATCHED", classification: cls } });
}

export async function dismissEmail(ctx: AppContext, emailId: string): Promise<void> {
  await ctx.db.emailMessage.update({
    where: { id: emailId },
    data: { matchStatus: "IGNORED", subject: "", fromAddress: "", toAddress: null, snippet: "", evidence: "[]" },
  });
}

/* ------------------------------------------------------ Gmail connection */

export function dbTokenStore(ctx: AppContext): TokenStore {
  return {
    async load() {
      const row = await ctx.db.oAuthToken.findUnique({ where: { provider: "gmail" } });
      return row ? (JSON.parse(decrypt(row.encrypted, ctx.key())) as OAuthTokens) : null;
    },
    async save(tokens) {
      const encrypted = encrypt(JSON.stringify(tokens), ctx.key());
      await ctx.db.oAuthToken.upsert({
        where: { provider: "gmail" },
        create: { provider: "gmail", encrypted, scope: tokens.scope },
        update: { encrypted, scope: tokens.scope },
      });
    },
    async clear() {
      await ctx.db.oAuthToken.deleteMany({ where: { provider: "gmail" } });
    },
  };
}

async function setting(ctx: AppContext, key: string): Promise<string | null> {
  return (await ctx.db.setting.findUnique({ where: { key } }))?.value ?? null;
}
async function putSetting(ctx: AppContext, key: string, value: string): Promise<void> {
  await ctx.db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

function oauthClient(ctx: AppContext) {
  if (!ctx.config.GMAIL_OAUTH_CLIENT_ID || !ctx.config.GMAIL_OAUTH_CLIENT_SECRET) {
    throw new Error("Set GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET in .env.local (Google Cloud → OAuth client, Desktop app type).");
  }
  return { clientId: ctx.config.GMAIL_OAUTH_CLIENT_ID, clientSecret: ctx.config.GMAIL_OAUTH_CLIENT_SECRET };
}

export async function startGmailConnect(ctx: AppContext, redirectUri: string, mode: "label" | "readonly"): Promise<string> {
  const { verifier, challenge } = pkcePair();
  const state = randomId("st");
  await putSetting(ctx, "gmail.pending", encrypt(JSON.stringify({ verifier, state, mode, redirectUri }), ctx.key()));
  return authorizationUrl(oauthClient(ctx), redirectUri, mode, state, challenge);
}

export async function finishGmailConnect(ctx: AppContext, code: string, state: string, http?: HttpFetch): Promise<string> {
  const raw = await setting(ctx, "gmail.pending");
  if (!raw) throw new Error("No Gmail connection is in progress.");
  const pending = JSON.parse(decrypt(raw, ctx.key())) as { verifier: string; state: string; mode: "label" | "readonly"; redirectUri: string };
  if (pending.state !== state) throw new Error("OAuth state mismatch. Start the connection again.");
  const tokens = await exchangeCode(oauthClient(ctx), code, pending.redirectUri, pending.verifier, http);
  await dbTokenStore(ctx).save(tokens);
  await putSetting(ctx, "gmail.mode", pending.mode);
  await ctx.db.setting.delete({ where: { key: "gmail.pending" } });
  const provider = await gmailProvider(ctx, http);
  const account = provider ? await provider.account() : "";
  await putSetting(ctx, "gmail.account", account);
  return account;
}

export async function gmailProvider(ctx: AppContext, http?: HttpFetch): Promise<GmailProvider | null> {
  const store = dbTokenStore(ctx);
  if (!(await ctx.db.oAuthToken.findUnique({ where: { provider: "gmail" } }))) return null;
  const mode = ((await setting(ctx, "gmail.mode")) as "label" | "readonly" | null) ?? "readonly";
  return new GmailProvider(oauthClient(ctx), store, mode, http);
}

/** Revoke at Google and delete local tokens and the sync cursor. */
export async function disconnectGmail(ctx: AppContext, http?: HttpFetch): Promise<void> {
  const store = dbTokenStore(ctx);
  await revokeTokens(await store.load().catch(() => null), http);
  await store.clear();
  await ctx.db.setting.deleteMany({ where: { key: { in: ["gmail.mode", "gmail.account", "gmail.pending", "email.cursor.gmail"] } } });
}

export async function gmailStatus(ctx: AppContext): Promise<{ connected: boolean; account: string | null; mode: string | null; lastCursor: string | null }> {
  return {
    connected: !!(await ctx.db.oAuthToken.findUnique({ where: { provider: "gmail" } })),
    account: await setting(ctx, "gmail.account"),
    mode: await setting(ctx, "gmail.mode"),
    lastCursor: await setting(ctx, "email.cursor.gmail"),
  };
}
