import { createHash, randomBytes } from "node:crypto";
import { CareerFiendError } from "@careerfiend/shared";
import type { EmailMeta, EmailProvider, SyncPage } from "./types";

/**
 * Gmail over REST with user-consented OAuth 2.0 (Desktop client, PKCE,
 * loopback redirect). No Google SDK: every request goes through `call`,
 * which only permits the endpoints below. There is no code path for send,
 * reply, forward, delete, trash, archive or mark-read.
 *
 * Scope note (see docs/threat-model.md): Gmail has no "label messages only"
 * scope. Adding a label to a message requires gmail.modify. "readonly" mode
 * requests gmail.readonly and never labels (dashboard-only tracking).
 */

export const GMAIL_SCOPES = {
  label: ["https://www.googleapis.com/auth/gmail.modify"],
  readonly: ["https://www.googleapis.com/auth/gmail.readonly"],
} as const;

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** The complete list of Gmail API calls CareerFiend can make. */
export const ALLOWED_CALLS: { method: "GET" | "POST"; path: RegExp }[] = [
  { method: "GET", path: /^\/profile$/ },
  { method: "GET", path: /^\/messages$/ },
  { method: "GET", path: /^\/messages\/[A-Za-z0-9]+$/ },
  { method: "GET", path: /^\/history$/ },
  { method: "GET", path: /^\/labels$/ },
  { method: "POST", path: /^\/labels$/ },
  { method: "POST", path: /^\/messages\/[A-Za-z0-9]+\/modify$/ },
];

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string;
}

export interface TokenStore {
  load(): Promise<OAuthTokens | null>;
  save(tokens: OAuthTokens): Promise<void>;
  clear(): Promise<void>;
}

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export type HttpFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

/* ------------------------------------------------------------------ OAuth */

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function authorizationUrl(client: OAuthClient, redirectUri: string, mode: "label" | "readonly", state: string, challenge: string): string {
  const u = new URL(AUTH_URL);
  u.searchParams.set("client_id", client.clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GMAIL_SCOPES[mode].join(" "));
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", state);
  return u.toString();
}

export async function exchangeCode(
  client: OAuthClient,
  code: string,
  redirectUri: string,
  verifier: string,
  http: HttpFetch = fetch as unknown as HttpFetch,
): Promise<OAuthTokens> {
  const res = await http(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }).toString(),
  });
  if (!res.ok) throw new CareerFiendError("FATAL_CONFIGURATION", `Google token exchange failed (HTTP ${res.status}).`);
  const t = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope: string };
  if (!t.refresh_token) throw new CareerFiendError("FATAL_CONFIGURATION", "Google did not return a refresh token. Disconnect and connect again.");
  return { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + (t.expires_in - 60) * 1000, scope: t.scope };
}

export async function revokeTokens(tokens: OAuthTokens | null, http: HttpFetch = fetch as unknown as HttpFetch): Promise<void> {
  if (!tokens) return;
  await http(`${REVOKE_URL}?token=${encodeURIComponent(tokens.refresh_token)}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
  }).catch(() => undefined);
}

/* --------------------------------------------------------------- provider */

export class GmailProvider implements EmailProvider {
  readonly name = "gmail";
  private labelCache = new Map<string, string>();

  constructor(
    private client: OAuthClient,
    private store: TokenStore,
    readonly mode: "label" | "readonly",
    private http: HttpFetch = fetch as unknown as HttpFetch,
  ) {}

  private async accessToken(): Promise<string> {
    const t = await this.store.load();
    if (!t) throw new CareerFiendError("FATAL_CONFIGURATION", "Gmail is not connected.");
    if (t.expires_at > Date.now()) return t.access_token;
    const res = await this.http(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.client.clientId,
        client_secret: this.client.clientSecret,
        refresh_token: t.refresh_token,
        grant_type: "refresh_token",
      }).toString(),
    });
    if (res.status === 400 || res.status === 401) throw new CareerFiendError("FATAL_CONFIGURATION", "Gmail access was revoked or expired. Reconnect Gmail.");
    if (!res.ok) throw new CareerFiendError("NETWORK_TRANSIENT", `Token refresh failed (HTTP ${res.status}).`);
    const n = (await res.json()) as { access_token: string; expires_in: number };
    const next = { ...t, access_token: n.access_token, expires_at: Date.now() + (n.expires_in - 60) * 1000 };
    await this.store.save(next);
    return next.access_token;
  }

  /** The single choke point for Gmail API calls. */
  async call<T>(method: "GET" | "POST", path: string, query: Record<string, string | string[]> = {}, body?: unknown): Promise<T> {
    if (!ALLOWED_CALLS.some((c) => c.method === method && c.path.test(path))) {
      throw new CareerFiendError("FATAL_CONFIGURATION", `Gmail call not permitted: ${method} ${path}`);
    }
    if (method === "POST" && this.mode === "readonly")
      throw new CareerFiendError("FATAL_CONFIGURATION", "Gmail is connected read-only; labels are not applied.");
    if (path.endsWith("/modify")) {
      const keys = Object.keys((body ?? {}) as object);
      if (keys.some((k) => k !== "addLabelIds")) throw new CareerFiendError("FATAL_CONFIGURATION", "Only addLabelIds is permitted on messages.modify.");
    }
    const u = new URL(API + path);
    for (const [k, v] of Object.entries(query)) for (const one of Array.isArray(v) ? v : [v]) u.searchParams.append(k, one);
    const res = await this.http(u.toString(), {
      method,
      headers: { authorization: `Bearer ${await this.accessToken()}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 404) throw Object.assign(new CareerFiendError("PAGE_CHANGED", `Gmail 404 on ${path}`), { status: 404 });
    if (res.status === 429 || res.status >= 500) throw new CareerFiendError("NETWORK_TRANSIENT", `Gmail HTTP ${res.status}`);
    if (!res.ok) throw new CareerFiendError("FATAL_CONFIGURATION", `Gmail HTTP ${res.status} on ${path}`);
    return (await res.json()) as T;
  }

  async account(): Promise<string> {
    return (await this.call<{ emailAddress: string }>("GET", "/profile")).emailAddress;
  }

  private async meta(id: string): Promise<EmailMeta> {
    const m = await this.call<{ id: string; threadId: string; snippet: string; internalDate: string; payload: { headers: { name: string; value: string }[] } }>(
      "GET",
      `/messages/${id}`,
      {
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"],
      },
    );
    const h = (n: string) => m.payload.headers.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
    return {
      id: m.id,
      threadId: m.threadId,
      from: h("From"),
      to: h("To"),
      subject: h("Subject"),
      date: new Date(Number(m.internalDate)),
      snippet: m.snippet ?? "",
    };
  }

  async sync(cursor: string | null, query: string): Promise<SyncPage> {
    const profile = await this.call<{ historyId: string }>("GET", "/profile");
    let ids: string[] = [];
    let fullSync = false;
    if (cursor) {
      try {
        let pageToken: string | undefined;
        do {
          const h = await this.call<{ history?: { messagesAdded?: { message: { id: string } }[] }[]; nextPageToken?: string }>("GET", "/history", {
            startHistoryId: cursor,
            historyTypes: "messageAdded",
            ...(pageToken ? { pageToken } : {}),
          });
          for (const rec of h.history ?? []) for (const a of rec.messagesAdded ?? []) ids.push(a.message.id);
          pageToken = h.nextPageToken;
        } while (pageToken);
      } catch (err) {
        if ((err as { status?: number }).status !== 404) throw err;
        cursor = null; // history too old: fall back to a bounded search
      }
    }
    if (!cursor) {
      fullSync = true;
      let pageToken: string | undefined;
      let pages = 0;
      do {
        const r = await this.call<{ messages?: { id: string }[]; nextPageToken?: string }>("GET", "/messages", {
          q: query,
          maxResults: "100",
          ...(pageToken ? { pageToken } : {}),
        });
        ids.push(...(r.messages ?? []).map((m) => m.id));
        pageToken = r.nextPageToken;
      } while (pageToken && ++pages < 5);
    }
    ids = [...new Set(ids)];
    const messages: EmailMeta[] = [];
    for (const id of ids) messages.push(await this.meta(id));
    return { messages, cursor: profile.historyId, fullSync };
  }

  async ensureLabel(name: string): Promise<string> {
    if (this.labelCache.has(name)) return this.labelCache.get(name)!;
    const list = await this.call<{ labels: { id: string; name: string }[] }>("GET", "/labels");
    for (const l of list.labels) this.labelCache.set(l.name, l.id);
    if (this.labelCache.has(name)) return this.labelCache.get(name)!;
    const created = await this.call<{ id: string }>("POST", "/labels", {}, { name, labelListVisibility: "labelShow", messageListVisibility: "show" });
    this.labelCache.set(name, created.id);
    return created.id;
  }

  async addLabels(messageId: string, labelIds: string[]): Promise<void> {
    if (this.mode === "readonly" || !labelIds.length) return;
    await this.call("POST", `/messages/${messageId}/modify`, {}, { addLabelIds: labelIds });
  }
}
