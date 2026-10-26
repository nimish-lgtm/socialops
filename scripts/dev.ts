// One-command start of the real web chat (MODE=web) on Windows, macOS or Linux.
// Uses DATABASE_URL if a Postgres answers there; otherwise starts a built-in Postgres stored in ./data/pg.
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { configProblems, loadConfig, loadEnvFile } from '../src/config';
import { createDatabase, dropDatabase, ensureRoles, migrate } from '../src/db/migrate';

process.env.MODE ??= 'web';
// Server secrets are generated once into .env; the Claude key and budget must come from the user.
const envText = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '';
const gen: Record<string, string> = { CREDENTIAL_KEY: randomBytes(32).toString('hex'), LINK_SECRET: randomBytes(24).toString('hex'), OPERATOR_TOKEN: randomBytes(24).toString('hex') };
const missing = Object.keys(gen).filter((k) => !new RegExp(`^\\s*${k}\\s*=\\s*\\S`, 'm').test(envText) && !process.env[k]);
if (missing.length) {
  fs.appendFileSync('.env', (envText && !envText.endsWith('\n') ? '\n' : '') + missing.map((k) => `${k}=${gen[k]}`).join('\n') + '\n');
  console.log('Generated ' + missing.join(', ') + ' into .env (keep that file private).');
}
loadEnvFile();
{
  const p = configProblems(loadConfig());
  if (p.length) { console.error('Cannot start:\n- ' + p.join('\n- ') + '\nAdd these to .env and run npm run dev again.'); process.exit(1); }
}
const EMBEDDED_PORT = 54329;

async function reachable(url: string): Promise<boolean> {
  const u = new URL(url);
  u.pathname = '/postgres';
  const c = new pg.Client({ connectionString: u.toString(), connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}

let cfg = loadConfig();
let usingEmbedded = false;
if (!(await reachable(cfg.databaseUrl))) {
  usingEmbedded = true;
  console.log('No Postgres at DATABASE_URL; starting the built-in one (first start takes ~20 s)...');
  const dir = path.resolve(process.env.EMBEDDED_PG_DIR ?? 'data/pg');
  // UTF8 explicitly: on Windows initdb otherwise picks WIN1252, which cannot store emoji or Devanagari.
  const make = () => new EmbeddedPostgres({ databaseDir: dir, user: 'socialops_owner', password: 'dev', port: EMBEDDED_PORT, persistent: true, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {}, onError: () => {} });
  const embeddedUrl = `postgres://socialops_owner:dev@localhost:${EMBEDDED_PORT}/postgres`;
  // A built-in Postgres left running by an earlier session (common on Windows after Ctrl+C) is reused.
  if (!(await reachable(embeddedUrl))) {
    const db = make();
    if (!fs.existsSync(path.join(dir, 'PG_VERSION'))) await db.initialise();
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
  if (!usingEmbedded) {
    console.error(`Database ${dbName} uses ${dbEnc}, which cannot store emoji or Hindi text. Drop it and run npm run dev again (it is recreated as UTF8).`);
    process.exit(1);
  }
  // Only the app database is recreated (as UTF8); cluster files are never deleted, so Windows file locks do not matter.
  console.log(`Local database used ${dbEnc}; recreating it as UTF8 (its data is reset)...`);
  await dropDatabase(cfg.databaseUrl, dbName);
  await createDatabase(cfg.databaseUrl, dbName);
}
await migrate(cfg.databaseUrl);
console.log(`Database ready. Open http://127.0.0.1:${cfg.port}/ when you see "listening".`);
await import('../src/main');
