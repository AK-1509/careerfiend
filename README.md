# CareerFiend

Tailored résumés and cover letters for every job you apply to, for anyone. Upload your résumé once; send CareerFiend the application links of the jobs you want; for each one it builds a one-page résumé shaped to that listing's wording (for applicant tracking systems) from your own lines, and a cover letter where every claim cites one of them. It tracks every application, builds a skill bank from the listings you chose, and, if you connect a language model of your choice, recommends small projects that would prove you can do what those jobs ask.

This is the public, multi-account edition of a single-user job-application copilot. Each account's data lives in its own database schema, separate from everyone else's.

## Using it

1. **Create an account** (email + password).
2. **Upload your résumé PDF.** CareerFiend reads it (text PDFs; scanned images can't be read), keeps the file, and shows what it found on the **Profile** page, where you can fix anything and add or edit experience, projects, education and skills by hand. You can also skip the PDF and fill out the Profile page from scratch.
3. **Connect a language model, or skip.** Pick a provider (Anthropic, OpenAI, Google Gemini, OpenRouter, Groq, DeepSeek, Mistral, or any OpenAI-compatible API), paste your own API key and a model id. CareerFiend sends one tiny test request, then stores the key encrypted. It turns on **Project Recommendations** and sharpens tailored bullets, cover letters and the reading of your PDF. Skip it and everything else still works on built-in rules. You can connect, switch or disconnect any time in **Settings**.
4. **Paste application links** on the Applications page, one per line: the employer's own job or application page (their careers site, Greenhouse, Lever, Ashby, Workday...).

   > **LinkedIn and Indeed links don't work.** Open the listing on LinkedIn or Indeed, follow it to the employer's application page (click **Apply** or **Apply on company site**), and send that link instead.

5. Each link becomes an application. When it shows **Ready to apply**, open it: download the tailored résumé and cover letter (PDF, DOCX or text), and use the **answers for the application form**, each with a **Copy** button. Apply on the employer's site, then press **I applied** so CareerFiend tracks it.

   CareerFiend never fills or submits the form. It opens the application page read-only to list its questions (including later steps already on the page) and answers each one from your résumé, your saved answers on the Profile page (phone, work authorization, salary...), the tailored cover letter, or, for open questions such as "Why are you interested?", a draft by your connected model that must cite your résumé lines. If the form can't be read (a sign-in wall, for example), you get the usual application questions instead, and you can paste any other question from the form to get an answer.

What the tailoring may and may not do:

- **Job-specific bullets.** For an important requirement, CareerFiend finds the line of your résumé that genuinely shows it and may rewrite that one line in the employer's wording. Every claim must trace to your line: no new tools, numbers, people, titles or results. A rewrite that fails a check is repaired at most twice, then dropped (the original line stays).
- **Skills line** with up to 10 of the listing's keywords that you hold or banked, in the listing's wording; an **ATS keyword check** shows which of the listing's skills your résumé covers.
- It never decides whether you should apply: every link gets documents.

## Deploy (Vercel + Neon, about 15 minutes)

1. Fork this repository and import it as a Vercel project with **Root Directory** `apps/dashboard`.
2. Vercel → **Storage** → add a **Neon** Postgres database to the project (sets `DATABASE_URL` and `DATABASE_URL_UNPOOLED`).
3. On any computer with the repo: `npm install && npm run hosted:env -- --all --url https://<your-app>.vercel.app`. Paste `private/vercel.env` into Vercel → Settings → Environment Variables, keep a safe copy of `APP_ENCRYPTION_KEY`, then delete the file.
4. Redeploy. Tables are created on first use (`npm run db:deploy` upgrades every account's schema at once after an update). `GET /api/health` shows whether sign-in, the key and the database are ready (no personal data).
5. Optional: set the repository variable `CAREERFIEND_URL` (GitHub → Settings → Variables) to your URL so `.github/workflows/worker-tick.yml` also runs the worker every 30 minutes (it already starts after every action and from the daily Vercel Cron).

Environment variables (see `.env.example`): `CAREERFIEND_MODE=hosted`, `DATABASE_URL`, `APP_ENCRYPTION_KEY_SOURCE=env:APP_ENCRYPTION_KEY`, `APP_ENCRYPTION_KEY`, `SESSION_SECRET`, `PUBLIC_URL`, and optionally `SIGNUPS_OPEN=false` (close sign-ups), `MAX_UPLOAD_MB` (default 4, at most 4.5 on Vercel), `GITHUB_TOKEN` (read-only, raises GitHub's rate limit for the optional "GitHub projects" feature). No AI key is needed: every person brings their own.

**Never change `APP_ENCRYPTION_KEY`** on a deployment with accounts: each account's stored model key is encrypted with a key derived from it.

## Run it on your own computer

Requirements: Node.js **22.12+**. Postgres is optional: without `DATABASE_URL` an embedded PGlite database is used (one folder per account under `private/data/tenants/`), but embedded databases allow one process at a time, so to run the dashboard and the worker together set `DATABASE_URL` to a Postgres server.

```bash
npm install                # also generates the Prisma client
npx playwright install chromium
npm run setup              # .env.local, SESSION_SECRET, private/ folders, git hook
npm run build && npm run dashboard    # http://127.0.0.1:3100 — create an account there
npm run worker             # in a second terminal: reads listings and builds documents for every account
```

Self-hosting extras: `FORM_FILLING=on` makes the worker also fill each application form in a browser up to (never including) the final button, then wait for your review, a typed `APPROVE` and a separate typed `SUBMIT`. Gmail reply tracking appears when `GMAIL_OAUTH_CLIENT_ID` / `GMAIL_OAUTH_CLIENT_SECRET` are set (each account connects its own inbox; read and add-label only). Neither is recommended for a public deployment.

## Project Recommendations

With a model connected, the **Project Recommendations** tab suggests at least 5 small tools you could build quickly with AI coding help (a weekend to two weeks). Each one makes easier a task that several of your saved jobs ask for, so building it shows you can do that task. The model first maps the tasks your listings share to the one experience of yours that gives you a real angle on each (kept private); then it writes one-line ideas that never name that experience. Code keeps only ideas tied to real requirements of at least 2 saved jobs. Refresh: 5 new ideas, at most 3 refreshes per rolling 5 hours. The sidebar lists the skills your saved jobs ask for most, sorted into _not on your résumé yet_, _transferable_ and _already shown_.

## Privacy and security

- Every account's data is in its own Postgres schema; a request can only open the schema of its signed-in account. **Settings → Delete account** removes the account and its whole schema.
- Your model key is encrypted with a key unique to your account and shown again only as its last 4 characters. It is used only for your requests and billed by your provider.
- Pasted links are fetched only if they point to the public internet (never internal addresses); robots.txt is honored; LinkedIn and Indeed are never fetched.
- Details: `docs/data-flow.md` (where data lives and what leaves), `docs/threat-model.md`, `docs/architecture.md`.

## Test

```bash
npm run format:check && npm run lint && npm run typecheck
npm test            # unit + integration (fixture site, headless Chromium, embedded Postgres)
npm run build
npm run test:e2e    # the built dashboard in a browser on a throwaway real Postgres: sign-up, PDF upload, model skip, links, isolation, account deletion
npm run check       # all of the above
```

Tests never touch real job sites and use only synthetic data (`fixtures/`).

## Layout

See `docs/architecture.md`.
