import type { Db, Tx } from '../db/db';
import type { Clock } from '../lib/clock';
import type { Logger } from '../lib/log';
import type { OutMessage, WhatsAppPort } from '../ports';
import { errClass } from '../lib/errors';
import { newId } from '../lib/ids';
import { enqueue, type Job } from './queue';
import type { Gateway } from './gateway';

export const WINDOW_MS = 24 * 3600_000;
export const inWindow = (last: Date | string | null | undefined, now: Date): boolean =>
  !!last && now.getTime() - new Date(last).getTime() < WINDOW_MS;

/**
 * Outbound WhatsApp as a transactional outbox: messages are queued in the same transaction as the change
 * that caused them, then delivered by a job with a durable dedupe key and the 24h window guard.
 */
export class Messenger {
  constructor(private db: Db, private clock: Clock, private wa: WhatsAppPort, private gateway: Gateway, private log: Logger) {}

  async queue(tx: Tx, m: { workspaceId: string | null; to: string; msg: OutMessage; key: string }): Promise<void> {
    await enqueue(tx, this.clock, 'send', { to: m.to, msg: m.msg, key: m.key, ws: m.workspaceId }, { workspaceId: m.workspaceId, dedupeKey: 'send:' + m.key, maxAttempts: 3 });
  }

  async deliver(job: Job): Promise<void> {
    const { to, msg, key, ws } = job.payload as { to: string; msg: OutMessage; key: string; ws: string | null };
    const now = this.clock.now();
    const conv = await this.db.system((tx) => tx.one<{ last_inbound_at: Date | null }>('SELECT last_inbound_at FROM conversations WHERE phone=$1', [to]));
    const kind = msg.kind;
    if (this.wa.kind !== 'web' && kind !== 'template' && !inWindow(conv?.last_inbound_at, now)) {
      await this.db.system(async (tx) => {
        await tx.q(`INSERT INTO outbound_messages(id, workspace_id, to_phone, kind, status, created_at) VALUES($1,$2,$3,$4,'blocked_window',$5)`, [newId('out'), ws, to, kind, now]);
        await tx.q('UPDATE jobs SET dedupe_key=NULL WHERE id=$1', [job.id]); // a blocked message must stay sendable later
      });
      this.log.info('outbound_blocked_window', { ws, key });
      return;
    }
    const id = newId('out');
    const claimed = await this.db.system((tx) => tx.q(`INSERT INTO outbound_messages(id, workspace_id, to_phone, kind, dedupe_key, status, created_at)
      VALUES($1,$2,$3,$4,$5,'sending',$6) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`, [id, ws, to, kind, key, now]));
    if (!claimed.length) return;
    try {
      const r = await this.gateway.call('messenger', 'wa.send', { workspaceId: ws }, () => this.wa.send(to, msg));
      await this.db.system((tx) => tx.q(`UPDATE outbound_messages SET status='sent', wa_id=$2 WHERE id=$1`, [id, r.waId]));
    } catch (e) {
      const cls = errClass(e);
      // Only a definitive rejection or a request that never left frees the key; anything else may have been delivered.
      if (cls === 'definitive' || cls === 'not_sent') {
        await this.db.system(async (tx) => {
          await tx.q(`UPDATE outbound_messages SET status='failed', dedupe_key=NULL, error=$2 WHERE id=$1`, [id, (e as Error).message]);
          if (cls === 'definitive') await tx.q('UPDATE jobs SET dedupe_key=NULL WHERE id=$1', [job.id]);
        });
        if (cls === 'not_sent') throw e;
      } else {
        await this.db.system((tx) => tx.q(`UPDATE outbound_messages SET status='unknown', error=$2 WHERE id=$1`, [id, (e as Error).message]));
      }
    }
  }

  async onStatus(s: { id: string; status: string }): Promise<void> {
    const map: Record<string, string> = { sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed' };
    const st = map[s.status];
    if (st) await this.db.system((tx) => tx.q(`UPDATE outbound_messages SET status=$2 WHERE wa_id=$1`, [s.id, st]));
  }
}
