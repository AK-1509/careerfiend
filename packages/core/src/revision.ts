import { decrypt, encrypt, hashObject, isEncrypted, randomId, sha256, type FieldSource, type SemanticFieldType, type Warning } from "@careerfiend/shared";
import type { Db, Tx } from "@careerfiend/db";
import { fromJson, toJson } from "@careerfiend/db";

/**
 * An ApplicationRevision is the immutable snapshot of exactly what would be
 * submitted. Its hash covers the résumé and cover-letter bytes, every answer,
 * every upload, the target URL, the job snapshot and the source commit.
 */

export interface RevisionAnswer {
  fieldKey: string;
  label: string;
  step: number;
  semanticType: SemanticFieldType;
  control: string;
  required: boolean;
  /** Encrypted at rest when `sensitive`. */
  value: string | null;
  sensitive: boolean;
  source: FieldSource;
  provenance: string[];
  confidence: number;
  note: string | null;
}

export interface RevisionPayload {
  version: 1;
  targetUrl: string;
  finalSubmitLabel: string | null;
  jobId: string;
  jobContentHash: string;
  sourceCommit: string;
  documents: { type: "resume" | "cover_letter"; format: "pdf" | "docx" | "txt"; path: string; sha256: string }[];
  answers: RevisionAnswer[];
  uploads: { fieldKey: string; path: string; sha256: string }[];
  coverLetter: { paragraphs: string[]; generator: string };
}

function plainAnswers(payload: RevisionPayload, key: Buffer): { fieldKey: string; value: string | null }[] {
  return payload.answers
    .map((a) => ({ fieldKey: a.fieldKey, value: a.value && isEncrypted(a.value) ? decrypt(a.value, key) : a.value }))
    .sort((x, y) => x.fieldKey.localeCompare(y.fieldKey));
}

export function computeRevisionHash(payload: RevisionPayload, key: Buffer, fileHashes?: Map<string, string>): string {
  const h = (path: string, recorded: string) => fileHashes?.get(path) ?? recorded;
  return hashObject({
    targetUrl: payload.targetUrl,
    finalSubmitLabel: payload.finalSubmitLabel,
    jobContentHash: payload.jobContentHash,
    sourceCommit: payload.sourceCommit,
    documents: payload.documents
      .map((d) => ({ type: d.type, format: d.format, sha256: h(d.path, d.sha256) }))
      .sort((a, b) => `${a.type}${a.format}`.localeCompare(`${b.type}${b.format}`)),
    answers: plainAnswers(payload, key),
    uploads: payload.uploads.map((u) => ({ fieldKey: u.fieldKey, sha256: h(u.path, u.sha256) })).sort((a, b) => a.fieldKey.localeCompare(b.fieldKey)),
  });
}

/**
 * Recompute the hash from the file bytes as they are now (`read` returns null
 * for a missing file, which makes the result null). A replaced résumé or
 * upload therefore changes the hash.
 */
export async function recomputeHash(payload: RevisionPayload, key: Buffer, read: (p: string) => Promise<Buffer | null>): Promise<string | null> {
  const hashes = new Map<string, string>();
  for (const p of [...payload.documents.map((d) => d.path), ...payload.uploads.map((u) => u.path)]) {
    const data = await read(p);
    if (!data) return null;
    hashes.set(p, sha256(data));
  }
  return computeRevisionHash(payload, key, hashes);
}

export function sealAnswers(answers: RevisionAnswer[], key: Buffer): RevisionAnswer[] {
  return answers.map((a) => (a.sensitive && a.value && !isEncrypted(a.value) ? { ...a, value: encrypt(a.value, key) } : a));
}

export function openAnswer(a: RevisionAnswer, key: Buffer): string | null {
  return a.value && isEncrypted(a.value) ? decrypt(a.value, key) : a.value;
}

export async function createRevision(
  db: Db | Tx,
  applicationId: string,
  payload: RevisionPayload,
  warnings: Warning[],
  reason: string,
  key: Buffer,
): Promise<{ id: string; number: number; hash: string }> {
  const last = await db.applicationRevision.findFirst({ where: { applicationId }, orderBy: { number: "desc" } });
  const number = (last?.number ?? 0) + 1;
  const sealed: RevisionPayload = { ...payload, answers: sealAnswers(payload.answers, key) };
  const hash = computeRevisionHash(sealed, key);
  const id = randomId("rev");
  await db.applicationRevision.create({ data: { id, applicationId, number, hash, payload: toJson(sealed), warnings: toJson(warnings), reason } });
  await db.application.update({ where: { id: applicationId }, data: { currentRevisionId: id } });
  return { id, number, hash };
}

export async function currentRevision(db: Db | Tx, applicationId: string) {
  const app = await db.application.findUniqueOrThrow({ where: { id: applicationId } });
  if (!app.currentRevisionId) return null;
  const row = await db.applicationRevision.findUniqueOrThrow({ where: { id: app.currentRevisionId } });
  return { row, payload: fromJson<RevisionPayload>(row.payload, null as unknown as RevisionPayload), warnings: fromJson<Warning[]>(row.warnings, []) };
}

export function unresolvedRequired(payload: RevisionPayload): RevisionAnswer[] {
  return payload.answers.filter((a) => a.required && (a.value === null || a.value === ""));
}
