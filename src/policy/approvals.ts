import type { Tx } from '../db/db';
import { newId, sha256 } from '../lib/ids';
import { AppError } from '../lib/errors';

/** Canonical JSON: keys sorted at every depth, undefined dropped, Dates and non-finite numbers encoded explicitly. */
export function canonical(v: unknown): string {
  if (v instanceof Date) return JSON.stringify('__date:' + v.toISOString());
  if (typeof v === 'number' && !Number.isFinite(v)) return JSON.stringify('__nonfinite:' + String(v));
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : canonical(x))).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
}
export const hashPayload = (p: unknown): string => sha256(canonical(p));

export interface Approval {
  id: string; workspace_id: string; task_id: string; kind: string; summary: string; payload_hash: string;
  amount_minor: string; status: string; expires_at: Date; decided_by: string | null;
}

export async function supersedePending(tx: Tx, taskId: string): Promise<number> {
  return (await tx.q(`UPDATE approvals SET status='superseded' WHERE task_id=$1 AND status='pending' RETURNING id`, [taskId])).length;
}

/** One live approval per task: any older pending card is superseded before the new one is created. */
export async function createApproval(tx: Tx, a: { workspaceId: string; taskId: string; kind: string; summary: string; payload: unknown; amountMinor?: number; requestedFrom: string | null; expiresAt: Date }): Promise<string> {
  await supersedePending(tx, a.taskId);
  const id = newId('apr');
  await tx.q(`INSERT INTO approvals(id, workspace_id, task_id, kind, summary, payload_hash, amount_minor, requested_from, expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, a.workspaceId, a.taskId, a.kind, a.summary.slice(0, 2000), hashPayload(a.payload), a.amountMinor ?? 0, a.requestedFrom, a.expiresAt]);
  await tx.q(`INSERT INTO audit(workspace_id, actor, event, detail) VALUES($1,'system','approval_requested',$2)`, [a.workspaceId, { id, taskId: a.taskId, kind: a.kind }]);
  return id;
}

export type DecideResult = { ok: true; approval: Approval } | { ok: false; reason: 'not_found' | 'not_owner' | 'expired' | 'handled' };

/** Owner-only, same workspace (enforced by RLS: another workspace's approval is invisible), pending, unexpired. */
export async function decide(tx: Tx, a: { approvalId: string; phone: string; role: string; decision: 'approved' | 'declined' | 'superseded'; now: Date }): Promise<DecideResult> {
  const row = await tx.one<Approval>('SELECT * FROM approvals WHERE id=$1 FOR UPDATE', [a.approvalId]);
  if (!row) return { ok: false, reason: 'not_found' };
  if (a.role !== 'owner') return { ok: false, reason: 'not_owner' };
  if (row.status !== 'pending') return { ok: false, reason: 'handled' };
  if (a.now.getTime() > new Date(row.expires_at).getTime()) {
    await tx.q(`UPDATE approvals SET status='expired' WHERE id=$1`, [row.id]);
    return { ok: false, reason: 'expired' };
  }
  await tx.q(`UPDATE approvals SET status=$2, decided_by=$3, decided_at=$4 WHERE id=$1`, [row.id, a.decision, a.phone, a.now]);
  await tx.q(`INSERT INTO audit(workspace_id, actor, event, detail) VALUES($1,$2,$3,$4)`, [row.workspace_id, a.phone, 'approval_' + a.decision, { id: row.id, taskId: row.task_id }]);
  return { ok: true, approval: { ...row, status: a.decision } };
}

/** Execution-time gate: the approval must be approved and its hash must match the payload about to be executed. */
export async function verifyApproval(tx: Tx, approvalId: string, payload: unknown): Promise<Approval> {
  const row = await tx.one<Approval>('SELECT * FROM approvals WHERE id=$1 FOR UPDATE', [approvalId]);
  if (!row || (row.status !== 'approved' && row.status !== 'used')) throw new AppError('approval_missing', 'permanent');
  if (row.payload_hash !== hashPayload(payload)) throw new AppError('approval_payload_changed', 'permanent');
  return row;
}

export async function markUsed(tx: Tx, approvalId: string): Promise<void> {
  await tx.q(`UPDATE approvals SET status='used' WHERE id=$1 AND status='approved'`, [approvalId]);
}
