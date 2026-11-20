import type { JobLocation, WorkplaceType } from "@careerfiend/shared";

const NON_US_REMOTE =
  /\b(uk|united kingdom|europe|emea|eu\b|germany|france|spain|netherlands|ireland|canada|india|apac|asia|australia|latam|mexico|brazil|poland|portugal|israel|singapore|japan|philippines)\b/i;
const US_REMOTE = /\b(us|u\.s\.|usa|united states|us-based|u\.s\.-based|anywhere in the (us|u\.s\.|united states)|north america)\b/i;

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
