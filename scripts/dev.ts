// One-command local start for the simulator, on Windows, macOS or Linux.
// Uses DATABASE_URL if a Postgres answers there; otherwise starts a built-in Postgres stored in ./data/pg.
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { loadConfig, loadEnvFile } from '../src/config';
import { createDatabase, ensureRoles, migrate } from '../src/db/migrate';

process.env.MODE ??= 'sim';
loadEnvFile();
const EMBEDDED_PORT = 54329;

async function reachable(url: string): Promise<boolean> {
  const u = new URL(url);
  u.pathname = '/postgres';
  const c = new pg.Client({ connectionString: u.toString(), connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}

let cfg = loadConfig();
if (!(await reachable(cfg.databaseUrl))) {
  console.log('No Postgres at DATABASE_URL; starting the built-in one (first start takes ~20 s)...');
  const dir = path.resolve(process.env.EMBEDDED_PG_DIR ?? 'data/pg');
  const db = new EmbeddedPostgres({ databaseDir: dir, user: 'socialops_owner', password: 'dev', port: EMBEDDED_PORT, persistent: true, onLog: () => {}, onError: () => {} });
  if (!fs.existsSync(path.join(dir, 'PG_VERSION'))) await db.initialise();
  await db.start();
  process.env.DATABASE_URL = `postgres://socialops_owner:dev@localhost:${EMBEDDED_PORT}/socialops_dev`;
  cfg = loadConfig();
}
await ensureRoles(cfg.databaseUrl, cfg.dbRolePassword);
await createDatabase(cfg.databaseUrl, new URL(cfg.databaseUrl).pathname.slice(1));
await migrate(cfg.databaseUrl);
console.log(`Database ready. Open http://localhost:${cfg.port}/sim when you see "listening".`);
await import('../src/main');
