# Failure states and manual recovery

The dashboard shows the category, the message and these instructions on the application page (`RECOVERY_INSTRUCTIONS` in `packages/shared/src/errors.ts`).

| Category                     | What happened                                                                            | What to do                                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `MISSING_PROFILE_DATA`       | A required field has no verified or confirmed value                                      | Answer the question on the application page. Tick "reusable" to store it for next time.                            |
| `SENSITIVE_ANSWER_REQUIRED`  | Authorization, EEO, salary, attestation… without a stored rule                           | Answer it, or fill the matching line in `answers-later.md` and import it on the Profile page.                      |
| `VALIDATION_FAILED`          | The site rejected a value (message captured)                                             | The question is re-opened with the site's message. Answer again.                                                   |
| `LOGIN_REQUIRED`             | Sign-in page                                                                             | Sign in yourself in the CareerFiend browser window, then press **Resume**. Cookies persist.                        |
| `CAPTCHA_OR_BOT_CHECK`       | CAPTCHA / bot check                                                                      | Complete it yourself in the browser window, then **Resume**. Never automated.                                      |
| `UNSUPPORTED_FIELD`          | A control the engine cannot operate, or an assessment                                    | Fill it during takeover and **Resume**, or apply manually.                                                         |
| `UNEXPECTED_NAVIGATION`      | The form went to another site (login, payment…)                                          | Check the browser window. Resume only if the page is legitimate.                                                   |
| `PAGE_CHANGED`               | Listing gone, form changed, or already shows a confirmation                              | Check the listing. If a confirmation shows, you applied before: check email, then reject this one.                 |
| `SITE_NOT_PERMITTED`         | LinkedIn/Indeed Easy Apply, robots.txt, or no Apply link                                 | Documents are generated; apply manually with them.                                                                 |
| `DOCUMENT_GENERATION_FAILED` | Résumé failed the verbatim check or the page limit                                       | Should not happen with a valid resume.json; run `npm run doctor`. The error names the span.                        |
| `SOURCE_CHANGED`             | Your résumé changed after the draft was built (blocking)                                 | **Regenerate documents** on the application page.                                                                  |
| `SUBMISSION_UNCERTAIN`       | The submit click happened but no confirmation was seen, or the worker stopped mid-submit | **Do not resubmit.** Check email and the employer portal, then press "It was submitted" or "It was not submitted". |
| `NETWORK_TRANSIENT`          | Network error                                                                            | Preparation retries automatically with backoff (never submission).                                                 |
| `FATAL_CONFIGURATION`        | No résumé yet, missing server key, bad `.env.local`, revoked Gmail token                 | Upload your résumé or fill out the Profile page; operators: check `/api/health` and the env vars in the README.    |

## Worker restarts

Stop the worker any time (Ctrl+C). On start it runs `recoverAfterRestart`:

- preparation items whose lease expired go back to the queue and resume from the application's state;
- a submission whose lease expired becomes `SUBMISSION_UNCERTAIN` and is never retried;
- approvals are consumed exactly once, and a second submit request returns the existing attempt.

## Other manual actions

- **Ready to apply / Apply yourself:** in the public edition every application ends at "Ready to apply" with the tailored documents (`DOCUMENTS_READY`); with form filling on, one CareerFiend could not finish shows "Apply yourself". Either way, apply on the employer's site, then press "I applied: mark as submitted".
- **Try filling it automatically again** (`FORM_FILLING=on` only): allowed for "Apply yourself" applications where nothing was submitted.
- **Regenerate:** available on every application except while the worker is working on it.
- **Edit after approval:** any answer or cover-letter edit creates a new revision and invalidates the approval.
- **Delete application data:** application page → Danger zone (type `DELETE`). Removes the files and all rows for the application. **Delete account** (Settings) drops the account's whole tenant database.
- **Restore a backup:** stop the worker, then `pg_restore --clean --no-owner -d "$DATABASE_URL_UNPOOLED" private/backups/<stamp>/careerfiend.dump` (or use Neon's point-in-time restore). A dump holds every account (the shared schema and each `t_…` schema). The encryption key (`APP_ENCRYPTION_KEY`) is not in the backup; keep it.
