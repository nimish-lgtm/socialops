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

async function isUtf8(url: string): Promise<boolean> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try { return (await c.query('SHOW server_encoding')).rows[0].server_encoding === 'UTF8'; } finally { await c.end(); }
}

let cfg = loadConfig();
if (!(await reachable(cfg.databaseUrl))) {
  console.log('No Postgres at DATABASE_URL; starting the built-in one (first start takes ~20 s)...');
  const dir = path.resolve(process.env.EMBEDDED_PG_DIR ?? 'data/pg');
  // UTF8 explicitly: on Windows initdb otherwise picks WIN1252, which cannot store emoji or Devanagari.
  const make = () => new EmbeddedPostgres({ databaseDir: dir, user: 'socialops_owner', password: 'dev', port: EMBEDDED_PORT, persistent: true, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {}, onError: () => {} });
  let db = make();
  if (!fs.existsSync(path.join(dir, 'PG_VERSION'))) await db.initialise();
  await db.start();
  if (!(await isUtf8(`postgres://socialops_owner:dev@localhost:${EMBEDDED_PORT}/postgres`))) {
    console.log('Built-in database was created with a non-UTF8 encoding; recreating it (demo data is reset)...');
    await db.stop();
    fs.rmSync(dir, { recursive: true, force: true });
    db = make();
    await db.initialise();
    await db.start();
  }
  process.env.DATABASE_URL = `postgres://socialops_owner:dev@localhost:${EMBEDDED_PORT}/socialops_dev`;
  cfg = loadConfig();
}
await ensureRoles(cfg.databaseUrl, cfg.dbRolePassword);
const dbName = new URL(cfg.databaseUrl).pathname.slice(1);
await createDatabase(cfg.databaseUrl, dbName);
const check = new pg.Client({ connectionString: cfg.databaseUrl });
await check.connect();
const dbEnc = (await check.query('SELECT pg_encoding_to_char(encoding) e FROM pg_database WHERE datname = current_database()')).rows[0].e;
await check.end();
if (dbEnc !== 'UTF8') {
  console.error(`Database ${dbName} uses ${dbEnc}, which cannot store emoji or Hindi text. Drop it and run npm run dev again (it will be recreated as UTF8).`);
  process.exit(1);
}
await migrate(cfg.databaseUrl);
console.log(`Database ready. Open http://127.0.0.1:${cfg.port}/sim when you see "listening".`);
await import('../src/main');
