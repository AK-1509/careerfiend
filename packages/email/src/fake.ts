import type { EmailMeta, EmailProvider, SyncPage } from "./types";

/**
 * In-memory provider for tests and the fixture demo ("controlled messages").
 * History ids increase with each delivered message, like Gmail's.
 */
export class FakeEmailProvider implements EmailProvider {
  readonly name = "fake";
  readonly labels = new Map<string, string>();
  readonly applied = new Map<string, Set<string>>();
  readonly calls: string[] = [];
  private inbox: { msg: EmailMeta; historyId: number }[] = [];
  private history = 100;

  constructor(readonly mode: "label" | "readonly" = "label") {}

  deliver(msg: EmailMeta): void {
    this.history++;
    this.inbox.push({ msg, historyId: this.history });
  }

  async account(): Promise<string> {
    return "fixture@example.com";
  }

  async sync(cursor: string | null, _query: string): Promise<SyncPage> {
    this.calls.push(`sync:${cursor ?? "full"}`);
    const since = cursor ? Number(cursor) : 0;
    const messages = this.inbox.filter((m) => m.historyId > since).map((m) => m.msg);
    return { messages, cursor: String(this.history), fullSync: !cursor };
  }

  async ensureLabel(name: string): Promise<string> {
    this.calls.push(`label:${name}`);
    if (!this.labels.has(name)) this.labels.set(name, `L${this.labels.size + 1}`);
    return this.labels.get(name)!;
  }

  async addLabels(messageId: string, labelIds: string[]): Promise<void> {
    if (this.mode === "readonly") return;
    this.calls.push(`modify:${messageId}:${labelIds.join(",")}`);
    const set = this.applied.get(messageId) ?? new Set<string>();
    for (const l of labelIds) set.add(l);
    this.applied.set(messageId, set);
  }

  labelNamesOn(messageId: string): string[] {
    const ids = this.applied.get(messageId) ?? new Set();
    return [...this.labels]
      .filter(([, id]) => ids.has(id))
      .map(([name]) => name)
      .sort();
  }
}
