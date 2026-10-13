# Product spec (public edition)

## What CareerFiend does

1. Lets anyone create an account (email + password). Each account's data is kept apart from every other account's.
2. Reads the résumé PDF the person uploads, keeps the file, and turns it into a structured résumé they can review and correct. Experience, projects, education and skills can also be typed or edited on the Profile page.
3. Asks the person to connect a language model of their choice (Anthropic, OpenAI, Google Gemini, OpenRouter, Groq, DeepSeek, Mistral or any OpenAI-compatible API) with their own key, or to skip.
4. Takes application links the person sends it. LinkedIn and Indeed links are refused with a clear message: follow the listing on that site to the employer's application page and send that link instead.
5. For every link: reads the listing and builds a one-page résumé tailored to it from the person's own lines (reordered, with job-specific bullets that only restate what a line proves), and a cover letter where every claim cites a résumé line.
6. Lists answers to the application form's questions to copy and paste: it opens the form read-only (never typing, clicking or submitting), answers each question from the résumé, saved answers, the cover letter or a cited model draft, and lets the person paste more questions.
7. Tracks every application (Ready to apply → Applied → replies) and builds a skill bank from the listings the person chose.
8. With a model connected: Project Recommendations (small tools the person could build that show they can do what their saved jobs ask for), plus sharper requirement reading, bullets, letters and PDF reading.

## Users

The general public. One account per person; no sharing between accounts. The operator of a deployment sees only what the database holds (see `docs/data-flow.md`).

## Rules that never change

- Nothing on a tailored résumé or cover letter that the person's own résumé lines do not support. A missing bullet beats a made-up one.
- CareerFiend never decides whether someone applies. Every link they send gets documents.
- No LinkedIn or Indeed reading, no scraping, robots.txt honored, public ATS endpoints only.
- No operator-paid AI: each person's model runs on their own key, and only for them.
- An account can delete itself and all of its data at any time.

## Self-hosting extras (off by default)

- `FORM_FILLING=on`: the worker also fills the application form in a browser up to (never including) the final button, then waits for review, a typed `APPROVE` and a separate typed `SUBMIT`, exactly as the single-user edition did.
- Gmail reply tracking: needs a Google OAuth client configured by the operator; the Email tab appears only then.

## Non-goals

- Auto-submitting, bulk-approving or bulk-submitting.
- LinkedIn Easy Apply, Indeed Apply, or reading either site.
- Solving CAPTCHAs or bypassing logins.
- Sending, replying to, archiving or deleting email.

## Degraded modes

- No model connected: résumés are tailored by the deterministic rules (ordering, keyword skills line, ATS check); cover letters use a plain two-sentence draft flagged for editing; Project Recommendations ask for a model.
- A PDF that is a scanned image: refused with directions to export a text PDF or fill out the Profile page.
