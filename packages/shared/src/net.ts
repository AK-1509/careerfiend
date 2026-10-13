import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { CareerFiendError } from "./errors";

/**
 * Outbound-address guard (public edition). Anyone with an account can paste a
 * URL or an AI base URL that the server then fetches, so every such request
 * must go to the public internet: never to loopback, private, link-local
 * (cloud metadata), carrier-grade NAT or other reserved ranges.
 */

function ipv4Private(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** True for addresses that are not on the public internet. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return ipv4Private(ip);
  if (v === 6) {
    const x = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return ipv4Private(mapped[1]!);
    return (
      x === "::" ||
      x === "::1" ||
      x.startsWith("fc") ||
      x.startsWith("fd") ||
      x.startsWith("fe8") ||
      x.startsWith("fe9") ||
      x.startsWith("fea") ||
      x.startsWith("feb") ||
      x.startsWith("ff")
    );
  }
  return true;
}

export interface PublicUrlOptions {
  /** Allow localhost / 127.0.0.1 (the fixture site in tests, a local Ollama on your own computer). */
  allowLocalhost?: boolean;
  /** Injected resolver (tests). */
  resolve?: (host: string) => Promise<string[]>;
}

const defaultResolve = async (host: string) => (await lookup(host, { all: true })).map((a) => a.address);

/** Throws unless `url` is http(s) and its host resolves only to public addresses. */
export async function assertPublicUrl(url: string, opts: PublicUrlOptions = {}): Promise<URL> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new CareerFiendError("VALIDATION_FAILED", `Not a valid URL: ${url.slice(0, 100)}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new CareerFiendError("VALIDATION_FAILED", "Only http and https addresses can be used.");
  if (u.username || u.password) throw new CareerFiendError("VALIDATION_FAILED", "Addresses with a user name or password are not allowed.");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (local && opts.allowLocalhost) return u;
  if (local || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new CareerFiendError("VALIDATION_FAILED", `${host} is not a public address.`);
  }
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = await (opts.resolve ?? defaultResolve)(host);
    } catch (err) {
      throw new CareerFiendError("NETWORK_TRANSIENT", `Could not look up ${host}.`, { cause: err });
    }
  }
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new CareerFiendError("VALIDATION_FAILED", `${host} is not a public address.`);
  return u;
}

/**
 * fetch() that checks the address of the first request and of every redirect
 * before following it (at most 5 hops).
 */
export async function fetchPublic(url: string, init: RequestInit = {}, opts: PublicUrlOptions = {}): Promise<Response> {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    await assertPublicUrl(current, opts);
    const res = await fetch(current, { ...init, redirect: "manual" });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return res;
    await res.body?.cancel();
    current = new URL(location, current).toString();
  }
  throw new CareerFiendError("VALIDATION_FAILED", "Too many redirects.");
}
