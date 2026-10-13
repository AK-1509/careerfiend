# Data flow (public edition)

Where each person's data lives, who can read it, and what leaves the deployment. "Operator" is whoever runs the deployment (their Vercel and Neon accounts).

## In the database

The shared schema holds only accounts. Everything else belongs to one account and lives in that account's own tenant: a Postgres schema `t_<id>` (hosted: Neon), or a PGlite folder `private/data/tenants/t_<id>` when self-hosted without Postgres.

| Data                                                                                                            | Where                     | Protection                                                                                   |
| --------------------------------------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------- |
| Account: email, scrypt password hash, lockout counters, timestamps                                              | Shared schema (`Account`) | Password never stored; Neon: encrypted at rest by the provider, TLS in transit               |
| Uploaded résumé PDFs and their extracted text                                                                   | Tenant (`ResumeUpload`)   | Readable only through that account's session; not encrypted by CareerFiend                   |
| The structured résumé (each saved version), facts, skills, jobs, applications, revisions, audit log, skill bank | Tenant                    | As above                                                                                     |
| Generated résumés and cover letters (PDF, DOCX, TXT)                                                            | Tenant (`StoredFile`)     | As above                                                                                     |
| The connected language model: provider, model, base URL and **API key**                                         | Tenant (`Setting`)        | AES-256-GCM with the account's own key; the key is shown again only as its last 4 characters |
| Application answers (self-hosted form filling only), Gmail tokens (only if the operator configured Gmail)       | Tenant                    | Sensitive ones AES-256-GCM with the account's own key                                        |

## Encryption keys

`APP_ENCRYPTION_KEY` (hosted: a Sensitive environment variable on Vercel; self-hosted: OS keychain or a key file) is the server key. Each account's key is derived from it with HKDF and the account id, so one account's encrypted values cannot be decrypted with another's key. Neon never receives either. Losing the server key makes every stored model key and sensitive answer unreadable (people would reconnect their model).

## Sent to other services

| Destination                                                          | What is sent                                                                                                                                                                                                                                                                                        | What is never sent                                                                                                       |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| The person's own language model (only if they connected one)         | Per call: the text of their uploaded PDF (when reading it), one job excerpt, the relevant résumé lines for one listing, skill-bank labels, or for Project Recommendations the requirement texts of their saved jobs plus their work/project lines and public repo descriptions. Billed to their key | Their password, sensitive answers, other accounts' data (contact details only inside the PDF text, when the PDF is read) |
| Employer career sites and public ATS APIs (Greenhouse, Lever, Ashby) | Anonymous GET requests for the listings people paste (public addresses only; robots.txt honored), and one read-only browser visit to each listing's application page to list its questions (nothing is typed or submitted)                                                                          | Anything about the person                                                                                                |
| GitHub API + raw files (optional, per account)                       | GETs of the public repository list and READMEs of the GitHub user the person entered on their Profile page, once a day (anonymous, or with the operator's read-only `GITHUB_TOKEN`)                                                                                                                 | Anything about the person                                                                                                |
| Employer / ATS form (only with `FORM_FILLING=on`, self-hosted)       | Form values and uploads during preparation; the final submit only after approval + confirmation                                                                                                                                                                                                     | Sensitive answers without a stored rule                                                                                  |
| Gmail API / Google OAuth (only if the operator configured Gmail)     | Reads limited to application-related mail; label creation; `addLabelIds`; consent and token exchange                                                                                                                                                                                                | Sends, replies, deletes, archives, read-state changes                                                                    |
| Neon (hosted)                                                        | The database contents above                                                                                                                                                                                                                                                                         | The server encryption key                                                                                                |
| Vercel (hosted)                                                      | Page requests; holds the server encryption key and session secret as environment variables                                                                                                                                                                                                          | Passwords (only their scrypt hashes, in the database)                                                                    |

## Not stored anywhere

Passwords (only hashes), a model key in readable form, and any LinkedIn or Indeed page (those links are refused before anything is fetched).

## Deleting

**Settings → Delete account** drops the account row and its entire tenant schema (or folder): résumé, uploads, applications, documents, skills, ideas and the model key. An application's data can also be deleted on its own page (Danger zone).
