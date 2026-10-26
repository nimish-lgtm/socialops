import { createHmac, randomBytes } from 'node:crypto';
import type { Db, Tx } from '../db/db';
import { sha256 } from '../lib/ids';

export type LinkKind = 'reconnect' | 'export' | 'media';

/** One-time or limited-use links. Only a hash of the token is stored. */
export class Links {
  constructor(private db: Db, private secret: string, private baseUrl: string) {}

  async create(tx: Tx, a: { workspaceId: string; kind: LinkKind; ref: string; expiresAt: Date; maxUses?: number }): Promise<string> {
    const raw = randomBytes(24).toString('base64url');
    const token = `${raw}.${createHmac('sha256', this.secret).update(raw).digest('base64url').slice(0, 16)}`;
    await tx.q(`INSERT INTO links(token_hash, workspace_id, kind, ref, expires_at, max_uses) VALUES($1,$2,$3,$4,$5,$6)`,
      [sha256(token), a.workspaceId, a.kind, a.ref, a.expiresAt, a.maxUses ?? 1]);
    return token;
  }

  url(path: string, token: string): string { return `${this.baseUrl}${path}?t=${encodeURIComponent(token)}`; }

  /** Consumes one use. Returns null for unknown, expired, used-up or forged tokens. */
  async redeem(token: string, kind: LinkKind, now: Date): Promise<{ workspaceId: string; ref: string } | null> {
    const [raw, mac] = token.split('.');
    if (!raw || !mac || createHmac('sha256', this.secret).update(raw).digest('base64url').slice(0, 16) !== mac) return null;
    return this.db.system(async (tx) => {
      const row = await tx.one<{ workspace_id: string; ref: string }>(
        `UPDATE links SET uses = uses + 1 WHERE token_hash=$1 AND kind=$2 AND expires_at > $3 AND uses < max_uses RETURNING workspace_id, ref`,
        [sha256(token), kind, now]);
      return row ? { workspaceId: row.workspace_id, ref: row.ref } : null;
    });
  }
}
