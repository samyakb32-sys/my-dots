// Durable Object that decides, atomically, which tap wins when an approval button is pressed more than once at the
// same time. Cloudflare KV has no compare-and-set, so two simultaneous callbacks could both read "pending" and both
// run the action. A Durable Object handles one request at a time, so exactly one claim per approval id succeeds.
// Bound as APPROVAL_LOCK in wrangler.toml; approvals.js falls back to a best-effort KV claim without it.

const KEEP_MS = 24 * 60 * 60 * 1000; // an id is only ever tapped within minutes; forget older claims

export class ApprovalLock {
  constructor(state) {
    this.storage = state.storage;
  }

  async fetch(request) {
    const { id, decision } = await request.json();
    const now = Date.now();
    const existing = await this.storage.get(id);
    if (existing) return Response.json({ won: false, decision: existing.decision });
    await this.storage.put(id, { decision, at: now });
    for (const [key, claim] of await this.storage.list({ limit: 100 })) {
      if (now - claim.at > KEEP_MS) await this.storage.delete(key);
    }
    return Response.json({ won: true });
  }
}
