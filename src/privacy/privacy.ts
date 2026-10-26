import type { Tx } from '../db/db';

/** Tables never exported: secrets and operational internals. */
export const NOT_EXPORTED = new Set(['credentials', 'jobs', 'links']);

export async function workspaceTables(tx: Tx): Promise<string[]> {
  return (await tx.q<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='workspace_id' ORDER BY table_name`,
  )).map((r) => r.table_name);
}

/** Export everything the workspace owns except credentials. Runs under RLS, so other workspaces cannot leak in. */
export async function exportWorkspace(tx: Tx, workspaceId: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown[]> = {};
  out.workspaces = await tx.q('SELECT * FROM workspaces WHERE id=$1', [workspaceId]);
  for (const t of await workspaceTables(tx)) {
    if (NOT_EXPORTED.has(t)) continue;
    out[t] = await tx.q(`SELECT * FROM ${t} WHERE workspace_id=$1`, [workspaceId]);
  }
  return { exported_at: new Date().toISOString(), workspace_id: workspaceId, excluded: [...NOT_EXPORTED], tables: out };
}
