import type { JobLocation, WorkplaceType } from "@careerfiend/shared";

/** California cities common in job listings (used when ", CA" is absent). */
const CA_CITIES = [
  "los angeles",
  "san francisco",
  "south san francisco",
  "san diego",
  "san jose",
  "irvine",
  "palo alto",
  "mountain view",
  "sunnyvale",
  "oakland",
  "berkeley",
  "emeryville",
  "santa monica",
  "pasadena",
  "sacramento",
  "thousand oaks",
  "carlsbad",
  "redwood city",
  "menlo park",
  "foster city",
  "santa clara",
  "fremont",
  "hayward",
  "culver city",
  "burbank",
  "long beach",
  "torrance",
  "el segundo",
  "brisbane",
  "san mateo",
  "alameda",
  "cupertino",
  "san carlos",
  "newark, ca",
  "la jolla",
  "orange county",
  "bay area",
  "silicon valley",
  "santa barbara",
  "ventura",
  "camarillo",
  "tustin",
  "costa mesa",
  "newport beach",
  "fresno",
  "riverside",
  "vacaville",
  "richmond, ca",
  "novato",
  "pleasanton",
  "livermore",
];

const NON_US_REMOTE =
  /\b(uk|united kingdom|europe|emea|eu\b|germany|france|spain|netherlands|ireland|canada|india|apac|asia|australia|latam|mexico|brazil|poland|portugal|israel|singapore|japan|philippines)\b/i;
const US_REMOTE = /\b(us|u\.s\.|usa|united states|us-based|u\.s\.-based|anywhere in the (us|u\.s\.|united states)|north america)\b/i;

export function isCalifornia(text: string): boolean {
  const t = text.toLowerCase();
  if (/\bcalifornia\b/.test(t)) return true;
  if (/,\s*ca\b/.test(t) || /\bca,\s*(us|usa|united states)\b/.test(t)) return true;
  return CA_CITIES.some((c) => t.includes(c));
}

export function parseLocation(input: {
  raw: string;
  locations?: string[];
  remoteHint?: boolean;
  workplaceHint?: string | null;
  applicantCountries?: string[];
  descriptionText?: string;
}): JobLocation {
  const raw = input.raw.trim();
  const locations = (input.locations?.length ? input.locations : raw.split(/\s*[;|/]\s*|\s+or\s+/i)).map((l) => l.trim()).filter(Boolean);
  const hint = (input.workplaceHint ?? "").toLowerCase();
  const all = `${raw} ${hint}`;
  let workplaceType: WorkplaceType = "unknown";
  if (/hybrid/i.test(all)) workplaceType = "hybrid";
  else if (input.remoteHint || /remote|telecommute|work from home|wfh/i.test(all)) workplaceType = "remote";
  else if (/on-?site|in office|in-office/i.test(all) || locations.length) workplaceType = "onsite";

  let remoteScope: JobLocation["remoteScope"] = null;
  if (workplaceType === "remote") {
    const countries = (input.applicantCountries ?? []).map((c) => c.toLowerCase());
    const scopeText = `${raw} ${countries.join(" ")}`;
    if (countries.some((c) => c === "us" || c === "usa" || c.includes("united states"))) remoteScope = "US";
    else if (countries.length) remoteScope = "other";
    else if (US_REMOTE.test(scopeText)) remoteScope = "US";
    else if (NON_US_REMOTE.test(scopeText)) remoteScope = "other";
    else if (/anywhere|worldwide|global/i.test(scopeText)) remoteScope = "global";
    else if (
      input.descriptionText &&
      /\b(must (be|reside) (located |based )?in the (us|u\.s\.|united states)|us-based|u\.s\.-based|within the (us|united states))\b/i.test(
        input.descriptionText,
      )
    ) {
      remoteScope = "US";
    } else remoteScope = "unknown";
  }
  return { raw, locations, workplaceType, remoteScope };
}

export interface RegionDecision {
  pass: boolean;
  reason: "REGION" | null;
  /** Non-blocking review warning, e.g. remote scope not stated. */
  warning: string | null;
  explanation: string;
}

/**
 * D5: accept California (on-site or hybrid) and remote roles open to US-based
 * applicants. Reject all others with reason REGION.
 */
export function regionGate(loc: JobLocation): RegionDecision {
  const caLocation = loc.locations.some(isCalifornia) || isCalifornia(loc.raw);
  if (loc.workplaceType === "remote") {
    if (loc.remoteScope === "US" || loc.remoteScope === "global") {
      return { pass: true, reason: null, warning: null, explanation: `Remote, open to US-based applicants (${loc.remoteScope}).` };
    }
    if (loc.remoteScope === "unknown") {
      return {
        pass: true,
        reason: null,
        warning: "REMOTE_SCOPE_UNSTATED: the listing says remote but does not say US applicants are eligible. Check before approving.",
        explanation: "Remote; eligible countries not stated.",
      };
    }
    if (caLocation) return { pass: true, reason: null, warning: null, explanation: "Remote with a California location." };
    return { pass: false, reason: "REGION", warning: null, explanation: `Remote but restricted outside the US (${loc.raw}).` };
  }
  if (caLocation) return { pass: true, reason: null, warning: null, explanation: `${loc.workplaceType === "hybrid" ? "Hybrid" : "On-site"} in California.` };
  if (loc.workplaceType === "unknown" && !loc.raw) {
    return {
      pass: true,
      reason: null,
      warning: "LOCATION_UNSTATED: the listing does not state a location. Check before approving.",
      explanation: "No location stated.",
    };
  }
  return { pass: false, reason: "REGION", warning: null, explanation: `Located outside California (${loc.raw || "unknown"}).` };
}
