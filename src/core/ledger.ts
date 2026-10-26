import type { Db } from '../db/db';
import type { Clock } from '../lib/clock';
import { AppError, errClass } from '../lib/errors';

export interface LedgerReq { key: string; adapter: string; op: string; request: Record<string, unknown>; inFlightMs: number; spendMinor?: number }

type Row = { workspace_id: string; status: 'started' | 'done' | 'failed'; response: { error?: string; cls?: string } | null; started_at: Date };

/**
 * Exactly-once external write. done -> stored result; started and still in flight -> try later;
 * started and stale -> reconcile with the platform, else escalate. Ambiguous failures stay 'started'.
 */
export async function runOnce<T extends object>(
  db: Db, clock: Clock, workspaceId: string, req: LedgerReq,
  fn: () => Promise<T>, reconcile: () => Promise<T | null>,
): Promise<T> {
  const now = clock.now();
  const decision = await db.tenant(workspaceId, async (tx) => {
    const row = await tx.one<Row>('SELECT workspace_id, status, response, started_at FROM actions WHERE idempotency_key=$1 FOR UPDATE', [req.key]);
    if (!row) {
      // A key owned by another workspace is invisible here; the insert then fails on the primary key.
      const ins = await tx.q(`INSERT INTO actions(idempotency_key, workspace_id, adapter, op, request, status, spend_minor, started_at)
        VALUES($1,$2,$3,$4,$5,'started',$6,$7) ON CONFLICT (idempotency_key) DO NOTHING RETURNING 1`,
        [req.key, workspaceId, req.adapter, req.op, req.request, req.spendMinor ?? 0, now]);
      if (!ins.length) throw new AppError('ledger_key_conflict', 'permanent');
      return { kind: 'execute' as const };
    }
    if (row.status === 'done') return { kind: 'done' as const, result: row.response as unknown as T };
    if (row.status === 'failed') {
      if (row.response?.cls === 'not_sent') {
        await tx.q(`UPDATE actions SET status='started', started_at=$2 WHERE idempotency_key=$1`, [req.key, now]);
        return { kind: 'execute' as const };
      }
      throw new AppError(row.response?.error ?? 'previously_rejected', 'definitive');
    }
    if (now.getTime() - new Date(row.started_at).getTime() < req.inFlightMs) throw new AppError('in_flight', 'transient');
    return { kind: 'reconcile' as const };
  });

  if (decision.kind === 'done') return decision.result;
  if (decision.kind === 'reconcile') {
    const found = await reconcile();
    if (!found) throw new AppError('needs_reconciliation', 'ambiguous', `unknown outcome for ${req.key}`);
    await finish(db, clock, workspaceId, req.key, 'done', found as Record<string, unknown>);
    return found;
  }
  try {
    const res = await fn();
    await finish(db, clock, workspaceId, req.key, 'done', res as Record<string, unknown>);
    return res;
  } catch (e) {
    const cls = errClass(e);
    if (cls === 'definitive' || cls === 'not_sent' || cls === 'permanent') {
      await finish(db, clock, workspaceId, req.key, 'failed', { error: (e as Error).message, cls });
    }
    throw e;
  }
}

async function finish(db: Db, clock: Clock, ws: string, key: string, status: 'done' | 'failed', response: Record<string, unknown>): Promise<void> {
  await db.tenant(ws, (tx) => tx.q(`UPDATE actions SET status=$2, response=$3, finished_at=$4 WHERE idempotency_key=$1`, [key, status, response, clock.now()]));
}
