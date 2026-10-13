# Site support

What CareerFiend reads and automates, and on what terms. Code: `packages/job-parser/src/site-policy.ts`.

## Supported URL patterns

| Pattern                                                                | Read                                                                                          | Fill form                                    | Notes                                                                                                                                                                               |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `boards.greenhouse.io/<board>/jobs/<id>`, `job-boards.greenhouse.io/…` | Public Job Board API (`boards-api.greenhouse.io/v1/boards/<board>/jobs/<id>`)                 | Yes (generic engine)                         | Hosted application form on the same page                                                                                                                                            |
| `jobs.lever.co/<site>/<id>`                                            | Public Postings API (`api.lever.co/v0/postings/<site>/<id>?mode=json`)                        | Yes                                          | Apply URL = `…/apply`                                                                                                                                                               |
| `jobs.ashbyhq.com/<board>/<id>`                                        | Public posting API (`api.ashbyhq.com/posting-api/job-board/<board>?includeCompensation=true`) | Yes                                          | React form; combobox support in the engine                                                                                                                                          |
| `*.myworkdayjobs.com`                                                  | Rendered page                                                                                 | Yes, but usually `LOGIN_REQUIRED` → takeover | Account creation is always yours                                                                                                                                                    |
| Other employer career pages                                            | Rendered page, JSON-LD `JobPosting` first, DOM second                                         | Yes                                          | robots.txt is honored                                                                                                                                                               |
| `linkedin.com`, `indeed.*`, `joinhandshake.com`                        | **Never**                                                                                     | **Never**                                    | Refused when pasted, with directions: open the listing on that site, follow it to the employer's application page, and send that link instead. These sites forbid automated reading |
| `localhost`, private addresses                                         | Only `localhost`, and only with `ALLOW_LOCALHOST_TARGETS=true`                                | Same                                         | Fixture site for tests. Every other address must resolve to the public internet (`shared/net.ts`)                                                                                   |

## Discovery endpoints (D6): terms check

Recorded 2026-09-25. Only the public, unauthenticated GET endpoints are used; volume is a few requests per watched company per account every 6 hours.

| Vendor     | Documentation                                              | Status                                                                                                                                                                                                                                                                                    |
| ---------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lever      | https://github.com/lever/postings-api                      | **Verified.** The docs state published postings are publicly viewable; GET endpoints `api.lever.co/v0/postings/SITE?mode=json` and `/SITE/POSTING-ID` need no authentication; no GET rate limit is stated (the 2 req/s limit applies to application POSTs, which CareerFiend never uses). |
| Greenhouse | https://developers.greenhouse.io/job-board.html            | **Not yet verified in writing.** The documentation host was unreachable from the build environment. The Job Board API is widely documented as public for GET. Read the page and record the result here before enabling a Greenhouse watchlist entry.                                      |
| Ashby      | https://developers.ashbyhq.com/docs/public-job-posting-api | **Not yet verified in writing.** Same reason. Read the page and record the result here before enabling an Ashby watchlist entry.                                                                                                                                                          |

Pasting a single Greenhouse or Ashby job URL reads one public posting, like opening it in a browser. The open item above is about recurring watchlist polling.

## Form engine (only with `FORM_FILLING=on`, self-hosted): known limitations

- Controls it operates: text, email, tel, url, number, date, textarea, native select, radio groups, checkboxes (single and grouped by name, grouped only for display), file inputs, ARIA `combobox` with `aria-controls` listbox, ARIA `checkbox`.
- Not operated (→ `UNSUPPORTED_FIELD`, takeover): rich-text editors, drag-and-drop uploads without a file input, date pickers without a text input, iframes from other origins, multi-select comboboxes.
- Final submission is identified by accessible name and form structure, never by position. Unknown buttons that submit a form are treated as final submission and never clicked during preparation. A page guard blocks any form submission that was not started by a button CareerFiend marked for that click.
- CAPTCHA, login, assessments and timed tests always pause for a takeover. CareerFiend does not solve or bypass them.
- ATS-specific adapters: none yet. Add them only after a local fixture reproduces the pattern.

## Before the first live application

1. Pick one real listing on Greenhouse, Lever or Ashby. Read that site's terms.
2. Save the page (File → Save As) into `fixtures/ats-pages/` and make sure `npm run test` still passes with a test for it.
3. Run one preparation with the visible browser, watch it stop before the final button, and review the revision.
