/**
 * Which sites CareerFiend may read and automate (D6, BUILD-GUIDE safety rules).
 * Details and terms notes live in docs/site-support.md.
 */

export interface SitePolicy {
  host: string;
  /** May we read the listing page? */
  readAllowed: boolean;
  /** May the form engine fill the application on this host? */
  automationAllowed: boolean;
  /** Job boards: read only to follow the external Apply link. */
  followExternalApplyOnly: boolean;
  kind: "linkedin" | "indeed" | "greenhouse" | "lever" | "ashby" | "workday" | "fixture" | "employer";
  note: string;
}

const BOARD_ONLY = [
  { re: /(^|\.)linkedin\.com$/i, kind: "linkedin" as const },
  { re: /(^|\.)indeed\.[a-z.]+$/i, kind: "indeed" as const },
];

export function sitePolicy(url: string, opts: { allowLocalhost?: boolean } = {}): SitePolicy {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { host: "", readAllowed: false, automationAllowed: false, followExternalApplyOnly: false, kind: "employer", note: "Invalid URL" };
  }
  for (const b of BOARD_ONLY) {
    if (b.re.test(host)) {
      return {
        host,
        readAllowed: true,
        automationAllowed: false,
        followExternalApplyOnly: true,
        kind: b.kind,
        note: "Job board: read only to follow the listing's external Apply link. Easy Apply / Indeed Apply are never automated.",
      };
    }
  }
  if (host === "localhost" || host === "127.0.0.1") {
    return {
      host,
      readAllowed: !!opts.allowLocalhost,
      automationAllowed: !!opts.allowLocalhost,
      followExternalApplyOnly: false,
      kind: "fixture",
      note: opts.allowLocalhost ? "Local fixture site." : "Localhost targets are disabled (set ALLOW_LOCALHOST_TARGETS=true for fixtures).",
    };
  }
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    return { host, readAllowed: true, automationAllowed: true, followExternalApplyOnly: false, kind: "greenhouse", note: "Greenhouse-hosted board." };
  }
  if (/(^|\.)lever\.co$/.test(host)) {
    return { host, readAllowed: true, automationAllowed: true, followExternalApplyOnly: false, kind: "lever", note: "Lever-hosted board." };
  }
  if (/(^|\.)ashbyhq\.com$/.test(host)) {
    return { host, readAllowed: true, automationAllowed: true, followExternalApplyOnly: false, kind: "ashby", note: "Ashby-hosted board." };
  }
  if (/(^|\.)myworkdayjobs\.com$/.test(host)) {
    return {
      host,
      readAllowed: true,
      automationAllowed: true,
      followExternalApplyOnly: false,
      kind: "workday",
      note: "Workday usually requires an account: expect LOGIN_REQUIRED and a takeover.",
    };
  }
  return { host, readAllowed: true, automationAllowed: true, followExternalApplyOnly: false, kind: "employer", note: "Employer site." };
}

/* ------------------------------------------------------------ robots.txt */

/** Minimal robots.txt evaluation for `User-agent: *` and our own agent. */
export function robotsAllows(robotsTxt: string, pathname: string, agent = "careerfiend"): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((field === "allow" || field === "disallow") && current) {
      if (value || field === "allow") current.rules.push({ allow: field === "allow", path: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && agent.toLowerCase().includes(a)));
  const applicable = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  let best: { allow: boolean; len: number } | null = null;
  for (const g of applicable) {
    for (const r of g.rules) {
      if (!r.path) continue;
      const pattern = new RegExp(
        "^" +
          r.path
            .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, ".*")
            .replace(/\\\$$/, "$"),
      );
      if (pattern.test(pathname) && (!best || r.path.length > best.len || (r.path.length === best.len && r.allow))) {
        best = { allow: r.allow, len: r.path.length };
      }
    }
  }
  return best ? best.allow : true;
}

/**
 * Job boards whose robots.txt forbids automated reading of job pages, so a pasted
 * link can never be read (CareerFiend honors robots.txt). Caught at paste time so
 * the user is told at once instead of seeing a silent failure later.
 */
const CLOSED_BOARDS = [
  { re: /(^|\.)linkedin\.com$/i, name: "LinkedIn" },
  { re: /(^|\.)indeed\.[a-z.]+$/i, name: "Indeed" },
  { re: /(^|\.)joinhandshake\.com$/i, name: "Handshake" },
];

/** The board's name when a link points at a job board that forbids automated reading, else null. */
export function closedBoard(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return CLOSED_BOARDS.find((b) => b.re.test(host))?.name ?? null;
  } catch {
    return null;
  }
}
