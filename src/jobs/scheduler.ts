import type { Deps } from '../app/deps';
import { enqueue } from '../core/queue';
import { DAY } from '../lib/clock';

const isoWeek = (d: Date): string => {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${Math.ceil(((t.getTime() - y.getTime()) / DAY + 1) / 7)}`;
};

/**
 * Idempotent periodic work. Each item uses a dedupe key per period, so running the tick twice
 * (or on two workers) never doubles a digest, health check or erase.
 */
export async function runScheduler(d: Deps): Promise<void> {
  const now = d.clock.now();

  const expired = await d.db.system((tx) => tx.q<{ workspace_id: string; task_id: string; id: string }>(
    `SELECT workspace_id, task_id, id FROM approvals WHERE status='pending' AND expires_at < $1 LIMIT 200`, [now]));
  for (const a of expired) {
    await d.db.tenant(a.workspace_id, async (tx) => {
      await tx.q(`UPDATE approvals SET status='expired' WHERE id=$1 AND status='pending'`, [a.id]);
      await d.engine.dispatchIn(tx, a.task_id, 'expire', {});
    });
  }

  const staleAssisted = await d.db.system((tx) => tx.q<{ workspace_id: string; id: string }>(
    `SELECT workspace_id, id FROM tasks WHERE workflow='post' AND state IN ('awaiting_user_post','waiting_reshoot') AND updated_at < $1 LIMIT 200`, [new Date(now.getTime() - 7 * DAY)]));
  for (const t of staleAssisted) await d.engine.dispatch(t.workspace_id, t.id, 'expire', {});

  const dueErase = await d.db.system((tx) => tx.q<{ workspace_id: string; id: string }>(
    `SELECT workspace_id, id FROM tasks WHERE workflow='delete_data' AND state='cooling' AND (data->>'eraseAt')::timestamptz <= $1`, [now]));
  for (const t of dueErase) await d.engine.dispatch(t.workspace_id, t.id, 'erase_due', {});

  const week = isoWeek(now);
  const istHour = (now.getUTCHours() + 5.5) % 24;
  const monday = new Date(now.getTime() + 5.5 * 3600_000).getUTCDay() === 1;
  await d.db.system(async (tx) => {
    const wss = await tx.q<{ id: string }>(`SELECT id FROM workspaces WHERE status='active' AND onboarded`);
    for (const w of wss) if (monday && istHour >= 9.5) await enqueue(tx, d.clock, 'digest', {}, { workspaceId: w.id, dedupeKey: `digest:${w.id}:${week}` });
    const accts = await tx.q<{ id: string; workspace_id: string }>(`SELECT a.id, a.workspace_id FROM accounts a JOIN workspaces w ON w.id=a.workspace_id WHERE a.status='connected' AND a.route='E' AND w.status='active'`);
    const day = now.toISOString().slice(0, 10);
    for (const a of accts) await enqueue(tx, d.clock, 'health', { accountId: a.id }, { workspaceId: a.workspace_id, dedupeKey: `health:${a.id}:${day}` });
    await tx.q(`DELETE FROM conversations WHERE workspace_id IS NULL AND last_inbound_at < $1`, [new Date(now.getTime() - 30 * DAY)]);
    await tx.q(`DELETE FROM links WHERE expires_at < $1`, [new Date(now.getTime() - DAY)]);
  });
}
