# Architecture

TypeScript monorepo (npm workspaces): Next.js dashboard, Prisma + Postgres, a bounded worker, Zod at boundaries, Vitest. This is the public, multi-account edition of a single-user copilot: almost every service is unchanged, and isolation comes from giving each account its own database (see **Tenancy**). Deployment: dashboard and worker on Vercel (worker = `/api/worker`, bounded runs) with one Neon Postgres; running everything on one computer (embedded PGlite) remains supported.

```text
apps/dashboard          Next.js 16 App Router; server components + server actions call packages/core directly
apps/worker             durable queue consumer: ingest, prepare, submit, email poll, watchlist, retention
packages/shared         Zod schemas, state machine, redacting logger, config, AES-256-GCM helpers, hashing
packages/db             Prisma 7 schema (Postgres), migrations, client factory (pg or embedded PGlite)
packages/profile        résumé schema; résumé PDF → text (pdf.js via unpdf) → résumé (rules, or a model checked word for word); facts with provenance keys; skills inventory
packages/job-parser     site policy + robots, JSON-LD/DOM extraction, requirement split, region gate, public ATS clients
packages/matcher        job analysis for tailoring (requirement → evidence, keyword match; no decisions), claim limits, unknown-skill detection, relevance, skill bank
packages/documents      résumé (selection, order, page fitting, source-checked spans), DOCX/PDF/TXT, cover letter + claim validation
packages/bullets        job-specific bullets: vocabulary, requirement templates, experience profiles, retrieval, scoring, evidence, validators, selection, eval
packages/policy         field classification, sensitive-field rules, answer policy, button classifier, approval invariant
packages/form-engine    Playwright inspection/filling, multi-step walk, pauses, submission guard, revision replay
packages/email          EmailProvider, Gmail REST behind an endpoint allowlist, OAuth PKCE, matcher, classifier, fake
packages/ai             provider interface; Anthropic (structured outputs) and any OpenAI-compatible API; per-account connections (LM_PRESETS); NullProvider
packages/core           services: accounts, tenancy, language-model connection, stored résumé + uploads, queue, ingest, prepare, review, submission, email, queries, skill bank + GitHub
fixtures/               listing pages, ATS-like forms, ATS API JSON, a synthetic résumé, skills inventory and answers, fixture server
scripts/                setup, backup, db:deploy (every schema), hosted:env (secrets), eval:bullets
tests/                  shared helpers and end-to-end tests (pipeline + dashboard UI)
private/                gitignored: embedded databases (one folder per account when self-hosted), local file copies
```

## Decisions and tradeoffs

- **Tenancy: a database per account.** `packages/core/src/tenancy.ts`. The shared schema holds only `Account`. Each account gets a tenant: a Postgres schema `t_<id>` on the same database (Prisma's `PrismaPg` `schema` option over one shared connection pool; migrated on first use, `npm run db:deploy` upgrades all), or a PGlite folder when self-hosted. `tenantContext(base, account)` returns an `AppContext` with that tenant's client, an HKDF-derived encryption key, per-account output folders, the account's GitHub user and its connected model. Every service written for one person's data runs unchanged on it, so there is no `WHERE accountId = …` to forget. Tradeoff: schemas multiply with accounts (fine for thousands; past that, shard by database).
- **Accounts and sessions.** `core/auth.ts`, `shared/auth.ts`: email + scrypt password, per-account lockout, a signed cookie `v2.<accountId>.<expiry>.<passwordFingerprint>.<mac>`. `proxy.ts` checks only the signature; `lib/ctx.ts` resolves the account in the database on every request (deleted accounts and changed passwords sign out) and opens its tenant.
- **Résumé source.** `core/resume-source.ts`: the stored résumé (`ResumeDraft`, resume.json shape) replaces the git repo; each save is a version `v<N>` that plays the role the commit played (facts pinned to it, `SOURCE_CHANGED` on drafts built on an older one). Uploads (`ResumeUpload`) keep the PDF and its text. Skills on the résumé become `VERIFIED_FROM_SOURCE` with the entries that name them as evidence.
- **Bring-your-own model.** `core/lm.ts`, `ai/connection.ts`: the connection (key included) is encrypted in the tenant; `tenantContext` builds the provider per request. No connection → `NullProvider` (deterministic paths). Custom base URLs must be public (https when hosted).
- **Form filling is off by default** (`FORM_FILLING`). Preparation ends at `MANUAL` with `DOCUMENTS_READY` once the documents are built; the form engine, approval and submission paths stay for self-hosters who turn it on.

- **Services in `packages/core`, not in the dashboard.** The dashboard, worker, scripts and tests call the same functions. There is no separate HTTP API: mutations are Next.js server actions. Every page, action and route requires a signed-in account (`proxy.ts` plus a check inside each action and route).
- **Prisma 7 with driver adapters.** `postgres://` URLs use `@prisma/adapter-pg`; `pglite:<dir>` / `pglite:memory` use embedded PGlite (laptop-only use and tests; single process). One migration set in `packages/db/prisma/migrations`, applied by `npm run db:deploy` (Postgres) or automatically (PGlite), tracked in `_cf_migrations`. Tests run on PGlite; `TEST_PG_ADMIN_URL` runs the integration suite on a real server, and the dashboard e2e test starts a throwaway Postgres.
- **Hosted worker.** `/api/worker` answers at once and runs `runAllTenants` in `after()`: accounts least recently served first, each in its tenant context under its own run lock (compare-and-swap on a settings row), with a time slice large enough for one preparation; each run recovers, schedules recurring work and processes items until ~30 s before its budget, starting only kinds that fit. Leases last the budget plus a minute, so a killed run's item is retried (preparation) or becomes `SUBMISSION_UNCERTAIN` (submission, never retried).
- **Project Recommendations.** `packages/core/src/projects.ts` runs two model steps per `ProjectIdeaRun` on the account's own model: a private mapping (tasks many saved jobs share, each matched to one real experience) and the ideas, validated by code (queued job ids, requirement ids of those jobs, no naming the experience, one sentence, no repeats) with one repair round. Each phase runs in its own `/api/projects/run?account=<id>` invocation, claimed by compare-and-swap. Refresh limit: 3 non-failed refreshes per rolling 5 hours.
- **Database-backed queue.** `WorkItem` rows with leases. Crash recovery (`recoverAfterRestart`) releases stale preparation leases and turns a stale SUBMIT lease into `SUBMISSION_UNCERTAIN`; submits are never retried.
- **Browser.** Used to render listing pages that need JavaScript and, with form filling on, to fill forms. One per worker run, per account.
- **Deterministic first, model second.** Extraction, requirement splitting, skill detection, matching, résumé selection, form classification and email matching are deterministic. When the account has connected a model, it may propose a requirement split, skill mappings, new skill labels, cover-letter drafts, free-text answers and email classes. Every proposal is schema-validated and then checked by policy code (verbatim page text, known skill ids, cited fact keys, exact numbers). Without a key everything still works; letters use a plain fallback and free-text questions go to `NEEDS_INPUT`.
- **Providers:** `packages/ai/src/common.ts` holds every task's prompt and schema (`TASKS`), shared by `AnthropicProvider` (structured outputs, server-side refusal fallback) and the OpenAI-compatible client (`DeepSeekProvider`, exported also as `OpenAICompatibleProvider`: `/chat/completions` in JSON mode, zod validation with one corrective retry; OpenAI gets `max_completion_tokens`). Which one, which model and whose key is each account's choice.
- **Résumé = typed spans.** Every line is built from `content` spans copied from the stored résumé, `date` spans formatted from the entry's own dates, and allowlisted labels/separators. `checkVerbatim` enforces D2 on every build; a failure aborts generation.
- **PDF is the page-count authority** (pdfkit, Helvetica). DOCX mirrors the layout with Arial at the same sizes. Page fitting binary-searches the number of trims (lowest-ranked bullet first, then entries; Education never).
- **Revision hash** covers résumé/letter bytes, answers (plaintext), uploads, target URL, final-button label, job content hash and résumé version. It is recomputed from the current bytes at the submit boundary (local copy, else the database copy) and again by the worker from exactly the files it uploads.
- **Gmail without the Google SDK.** A small REST client with one choke point (`GmailProvider.call`) that only permits read and add-label calls.

## State machine

`packages/shared/src/state-machine.ts`. Explicit transitions: preparation steps may pause or fail early; `NEEDS_INPUT → GENERATING_DOCUMENTS` after skill confirmation; `APPROVED → READY_FOR_REVIEW` when an edit invalidates approval; `SUBMISSION_UNCERTAIN → SUBMITTED | MANUAL` by hand; replies may skip `CONFIRMATION_RECEIVED`. There is no failed state for you to see: whenever CareerFiend cannot finish an application (a CAPTCHA or spam check, a site it may not automate, an error, a refused submission) it goes to `MANUAL` ("Apply yourself") with the documents ready, and you apply on the employer's site and mark it `SUBMITTED`. `MANUAL → QUEUED` only when nothing was submitted. `FAILED` remains only as a legacy value (migration 0006 moved those rows to `MANUAL`). Regenerate works in every state: before submission it rebuilds the draft as a new revision; otherwise a `REGENERATE_DOCUMENTS` work item rebuilds the documents without changing the state. Every change goes through `transition()`, which updates conditionally on the expected current state and appends a `StatusEvent`.

## Security boundary for model output

The model never receives tools. Its text cannot trigger browser actions, database writes, email actions or submission: only enumerated service functions do that, and those take values that already passed policy checks. Listing text, form labels and email bodies are wrapped in `<untrusted_*>` tags with a standing instruction that they are data.
