import pg from 'pg';

export interface Tx {
  q<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
}

const wrap = (c: pg.PoolClient): Tx => ({
  q: async <T>(sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows as T[],
  one: async <T>(sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0] as T | undefined,
});

/**
 * Two pools: `app` is subject to row-level security and every transaction is pinned to one workspace;
 * `sys` bypasses RLS and is used only for ingress identity, the job queue, the scheduler and erasure.
 */
export class Db {
  readonly app: pg.Pool;
  readonly sys: pg.Pool;
  constructor(appUrl: string, sysUrl: string) {
    this.app = new pg.Pool({ connectionString: appUrl, max: 10 });
    this.sys = new pg.Pool({ connectionString: sysUrl, max: 5 });
  }

  async tenant<T>(workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (!workspaceId) throw new Error('tenant_required');
    const c = await this.app.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
      const r = await fn(wrap(c));
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  async system<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const c = await this.sys.connect();
    try {
      await c.query('BEGIN');
      const r = await fn(wrap(c));
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  async close(): Promise<void> {
    await Promise.all([this.app.end(), this.sys.end()]);
  }
}

export const roleUrl = (adminUrl: string, role: string, password: string): string => {
  const u = new URL(adminUrl);
  u.username = role;
  u.password = password;
  return u.toString();
};
