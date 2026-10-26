import { afterEach, describe, expect, it } from 'vitest';
import { harness, P, type Harness } from './harness';
import { runOnce } from '../src/core/ledger';
import { AppError } from '../src/lib/errors';
import { exportWorkspace, NOT_EXPORTED, workspaceTables } from '../src/privacy/privacy';

let h: Harness;
afterEach(async () => { await h?.close(); });

describe('tenant isolation (RLS)', () => {
  it('F32 without a workspace set, the app role sees nothing and cannot write', async () => {
    h = await harness();
    const c = await h.db.app.connect();
    try {
      expect((await c.query('SELECT * FROM workspaces')).rowCount).toBe(0);
      expect((await c.query('SELECT * FROM members')).rowCount).toBe(0);
      await expect(c.query(`INSERT INTO tasks(id, workspace_id, workflow, state) VALUES('t','${h.ws}','post','received')`)).rejects.toThrow(/row-level security/);
    } finally { c.release(); }
  });

  it('T-DB-01 one workspace cannot read or write another workspace\'s rows', async () => {
    h = await harness({ secondWorkspace: true });
    await h.toApproval();
    const seen = await h.db.tenant(h.ws2!, async (tx) => ({
      tasks: await tx.q('SELECT * FROM tasks'), approvals: await tx.q('SELECT * FROM approvals'), members: await tx.q('SELECT * FROM members'),
    }));
    expect(seen.tasks).toHaveLength(0);
    expect(seen.approvals).toHaveLength(0);
    expect(seen.members.map((m: any) => m.phone)).toEqual([P.owner2]);
    await expect(h.db.tenant(h.ws2!, (tx) => tx.q(`UPDATE tasks SET state='done' RETURNING id`))).resolves.toEqual([]);
  });

  it('T-DB-02 coverage: every workspace table has forced RLS with a policy, and the audit log is append-only for the app', async () => {
    h = await harness();
    const tables = await h.db.system((tx) => workspaceTables(tx));
    expect(tables.length).toBeGreaterThanOrEqual(18);
    const rls = await h.sys(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1)`, [[...tables, 'workspaces']]);
    for (const r of rls) expect([r.relname, r.relrowsecurity, r.relforcerowsecurity]).toEqual([r.relname, true, true]);
    const pol = new Set((await h.sys(`SELECT tablename FROM pg_policies`)).map((r: any) => r.tablename));
    for (const t of [...tables, 'workspaces']) expect(pol.has(t), t).toBe(true);
    await expect(h.db.tenant(h.ws, (tx) => tx.q('DELETE FROM audit'))).rejects.toThrow(/permission denied/);
  });

  it('T-DB-03 export covers every workspace table except secrets and never includes another workspace', async () => {
    h = await harness({ secondWorkspace: true });
    await h.tap(P.owner, await h.toApproval());
    const e = (await h.db.tenant(h.ws, (tx) => exportWorkspace(tx, h.ws))) as any;
    const tables = await h.db.system((tx) => workspaceTables(tx));
    for (const t of tables) expect(t in e.tables || NOT_EXPORTED.has(t), t).toBe(true);
    expect(e.tables.credentials).toBeUndefined();
    expect(JSON.stringify(e)).not.toContain(P.owner2);
    expect(e.tables.posts).toHaveLength(1);
  });
});

describe('ledger', () => {
  const req = (key: string) => ({ key, adapter: 'x', op: 'o', request: {}, inFlightMs: 60_000 });

  it('T-DB-04 a done key never re-executes', async () => {
    h = await harness();
    let n = 0;
    const fn = async () => ({ n: ++n });
    await runOnce(h.db, h.clock, h.ws, req('k1'), fn, async () => null);
    const r = await runOnce(h.db, h.clock, h.ws, req('k1'), fn, async () => null);
    expect(n).toBe(1);
    expect(r).toEqual({ n: 1 });
  });

  it('T-DB-05 ambiguous outcome: in-flight retries wait, then reconcile or escalate; never a second call', async () => {
    h = await harness();
    let calls = 0;
    const boom = async () => { calls++; throw new AppError('timeout', 'ambiguous'); };
    await expect(runOnce(h.db, h.clock, h.ws, req('k2'), boom, async () => null)).rejects.toThrow('timeout');
    await expect(runOnce(h.db, h.clock, h.ws, req('k2'), boom, async () => null)).rejects.toMatchObject({ code: 'in_flight' });
    h.clock.advance(61_000);
    await expect(runOnce(h.db, h.clock, h.ws, req('k2'), boom, async () => null)).rejects.toMatchObject({ code: 'needs_reconciliation' });
    const found = await runOnce(h.db, h.clock, h.ws, req('k2'), boom, async () => ({ id: 'p1' }));
    expect(found).toEqual({ id: 'p1' });
    expect(calls).toBe(1);
  });

  it('T-DB-06 not-sent failures are retried; definitive rejections are not repeated', async () => {
    h = await harness();
    let calls = 0;
    await expect(runOnce(h.db, h.clock, h.ws, req('k3'), async () => { calls++; throw new AppError('refused', 'not_sent'); }, async () => null)).rejects.toThrow();
    await runOnce(h.db, h.clock, h.ws, req('k3'), async () => { calls++; return { ok: 1 }; }, async () => null);
    expect(calls).toBe(2);
    await expect(runOnce(h.db, h.clock, h.ws, req('k4'), async () => { calls++; throw new AppError('bad_media', 'definitive'); }, async () => null)).rejects.toThrow();
    await expect(runOnce(h.db, h.clock, h.ws, req('k4'), async () => { calls++; return { ok: 1 }; }, async () => null)).rejects.toMatchObject({ cls: 'definitive' });
    expect(calls).toBe(3);
  });

  it('T-DB-07 a ledger key owned by another workspace is refused', async () => {
    h = await harness({ secondWorkspace: true });
    await runOnce(h.db, h.clock, h.ws, req('shared'), async () => ({ a: 1 }), async () => null);
    await expect(runOnce(h.db, h.clock, h.ws2!, req('shared'), async () => ({ a: 2 }), async () => null)).rejects.toMatchObject({ code: 'ledger_key_conflict' });
  });

  it('T-DB-08 two concurrent runs of the same key execute the side effect once', async () => {
    h = await harness();
    let n = 0;
    const fn = async () => { n++; await new Promise((r) => setTimeout(r, 30)); return { id: 'p' }; };
    const results = await Promise.allSettled([runOnce(h.db, h.clock, h.ws, req('race'), fn, async () => null), runOnce(h.db, h.clock, h.ws, req('race'), fn, async () => null)]);
    expect(n).toBe(1);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});
