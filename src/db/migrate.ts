import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../migrations');
export const APP_ROLES = ['socialops_app', 'socialops_system'] as const;

/** Create the two runtime roles if missing. Needs a superuser or CREATEROLE connection. */
export async function ensureRoles(adminUrl: string, password: string): Promise<void> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    for (const role of APP_ROLES) {
      const exists = await c.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]);
      const bypass = role === 'socialops_system' ? 'BYPASSRLS' : 'NOBYPASSRLS';
      const pw = `'${password.replace(/'/g, "''")}'`;
      if (!exists.rowCount) await c.query(`CREATE ROLE ${role} LOGIN ${bypass} PASSWORD ${pw}`);
      else await c.query(`ALTER ROLE ${role} LOGIN ${bypass} PASSWORD ${pw}`);
    }
  } finally {
    await c.end();
  }
}

/** Apply numbered SQL files once each, in order, inside one transaction per file. */
export async function migrate(adminUrl: string): Promise<string[]> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  const applied: string[] = [];
  try {
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name as string));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      await c.query('BEGIN');
      try {
        await c.query(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
        await c.query('INSERT INTO schema_migrations(name) VALUES($1)', [f]);
        await c.query('COMMIT');
        applied.push(f);
      } catch (e) {
        await c.query('ROLLBACK');
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await c.end();
  }
  return applied;
}

export async function createDatabase(adminUrl: string, name: string, template?: string): Promise<void> {
  const u = new URL(adminUrl);
  u.pathname = '/postgres';
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  try {
    const exists = await c.query('SELECT 1 FROM pg_database WHERE datname=$1', [name]);
    if (!exists.rowCount) await c.query(`CREATE DATABASE "${name}"${template ? ` TEMPLATE "${template}"` : ''}`);
  } finally {
    await c.end();
  }
}

export async function dropDatabase(adminUrl: string, name: string): Promise<void> {
  const u = new URL(adminUrl);
  u.pathname = '/postgres';
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await c.end();
  }
}

export const withDbName = (url: string, name: string): string => {
  const u = new URL(url);
  u.pathname = '/' + name;
  return u.toString();
};
