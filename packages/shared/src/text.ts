/** Lowercase, hyphen-separated slug. */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Normalized label used for skill de-duplication: case, punctuation and
 * spacing are ignored, so "Node.js", "node js" and "NodeJS" collide.
 */
export function normalizeLabel(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9+#]+/g, "");
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Escape a string for use inside a RegExp. */
export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word, case-insensitive containment. Handles labels like "C++" and "R". */
export function containsTerm(haystack: string, term: string): boolean {
  const t = term.trim();
  if (!t) return false;
  const re = new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(t)}(?=$|[^A-Za-z0-9+#])`, "i");
  return re.test(haystack);
}
