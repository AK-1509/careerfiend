# Job-specific bullets

`@careerfiend/bullets` turns a parsed listing plus your stored experience into job-specific résumé bullets. It is a processing layer on top of what CareerFiend already produces: listing ingestion and the résumé builder are unchanged, and `resume.json` and the stored facts are never written.

**The rule.** The job description decides the framing, your experience decides the facts, and the validators decide whether the transformation is legitimate.

## Pipeline

| Stage                                                                                                                                                                                                               | Module                        | Model                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Requirement extraction (existing parsed requirements; degrees, licenses, clearance, logistics excluded)                                                                                                             | `normalize.ts#buildTemplates` | —                                                                                                              |
| Grammatical decomposition: actions, objects, skills/methods, stakeholders, outcome, context, constraints; employer names, locations, culture language, seniority and framing removed                                | `normalize.ts#decompose`      | fast model only for low-confidence parses, one batched call; fragments kept only if they occur in the sentence |
| Canonical template ("Develop product goals and KPIs using competitive intelligence with leadership")                                                                                                                | `normalize.ts#templateText`   | —                                                                                                              |
| Vocabulary: action families, concept families (product, business, technical, design, analytics, marketing, research, operations, quality, finance, people), named tools, stakeholder categories, low-value language | `vocabulary.ts`               | —                                                                                                              |
| Experience representation: per work/project entry, actions, objects, skills, tools, methods, stakeholders, outputs, outcomes, metrics, scale, each with source line ids                                             | `experience.ts`               | fast model once per résumé version (cached in `ExperienceProfileCache`)                                        |
| Candidate retrieval in a shared concept space (no embedding service in the stack: sparse vectors over concept families, related families, actions, tools, stakeholders, stems)                                      | `semantic.ts`                 | —                                                                                                              |
| Structured scoring: action, object/domain, skill, method, stakeholder, outcome, industry, semantic; weights by requirement type                                                                                     | `scoring.ts`                  | —                                                                                                              |
| Reranking of the small candidate set (support level, supported items, evidence ids, unsupported items, legitimate framing)                                                                                          | pipeline                      | main model, one batched call (effort low)                                                                      |
| Evidence extraction: relevant vs proven                                                                                                                                                                             | `evidence.ts`                 | —                                                                                                              |
| Grounded generation with an evidence ledger                                                                                                                                                                         | pipeline                      | main model, one batched call (effort medium)                                                                   |
| Validation: grounding, requirement alignment, ATS terminology, quality/duplication                                                                                                                                  | `validate.ts`                 | —                                                                                                              |
| Repair: failures fed back as instructions, at most 2 rounds, then discard                                                                                                                                           | pipeline                      | main model, one batched call per round                                                                         |
| Selection: one bullet per requirement and per résumé line, only where it beats the original                                                                                                                         | `select.ts`                   | —                                                                                                              |

Model calls per curated résumé: typically 2–4 (rerank, generate, up to two repairs), plus an occasional fast decomposition call; experience extraction runs once per résumé version. A time budget (90 s) stops new repair rounds.

## Relevant vs proven

_Relevant_ means the experience is related to what the employer wants (retrieval and scores). _Proven_ means a cited résumé line shows that specific element: the same concept family, the same named tool, the same stakeholder category, the same action family paired with the same object in one line. Tools, stakeholders, people management, outcomes, credentials and titles are proven only literally. The reranking model may vouch for a general concept on a line it cites, never for those.

"Develop pricing models using SQL" against "Analyzed product pricing and revenue trends": related, but neither pricing models nor SQL is proven, so no bullet is generated and the original line stays.

## ATS terminology

- **Exact:** the evidence already uses the employer's wording. Keep it.
- **Equivalent:** the evidence shows the same concept in other words ("success metrics" for "KPIs"). The bullet may use the employer's wording.
- **Unsupported:** never inserted. These terms are sent to the generator as `avoidTerms` and blocked by the grounding validator.

The ATS validator requires the employer's wording for at most the two highest-value supported terms (named tools and the requirement's core objects); repetition fails the quality validator.

## Output

`generateJobSpecificBullets(jobRequirements, userExperiences, resumeContext)` returns `bullets` (experience id, requirement id, replaced line id, folded line ids, text, original text, template, relevance score, grounding status, evidence ids, matched terms, ledger, attempts), `rejected` (with reasons), `templates` and `metrics`. The résumé builder takes `text` for each replaced line; the metadata is stored in the résumé's provenance and shown on the application page.

## Observability and evaluation

Structured logs (ids only, never résumé text): `bullets.template` (requirement id, confidence, method), `bullets.match` (requirement id, experience id, score, support), `bullets.attempt` (attempt, pass/fail, failure codes, alignment), `bullets.model` (stage, tier, latency), `bullets.done`, `bullets.profiles`, and `ai.call` with the model used.

`npm run eval:bullets` replays the stored cases in `fixtures/bullets/cases.json` with their scripted model answers and prints: unsupported claim rate (must be 0; the run fails otherwise), grounding accuracy, requirement alignment, supported keyword coverage, duplicate rate, average retries, latency and model calls per résumé. `-- --live` runs the same cases against the configured provider.
