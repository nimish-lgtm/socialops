import { configProblems, configWarnings, loadConfig, loadEnvFile } from './config';
import { buildDeps } from './app/build';
import { buildServer } from './http/server';
import { enqueue } from './core/queue';
import { migrate, ensureRoles } from './db/migrate';

loadEnvFile();
const config = loadConfig();
const problems = configProblems(config);
if (problems.length) {
  console.error(`MODE=${config.mode} cannot start:\n- ` + problems.join('\n- '));
  process.exit(1);
}
for (const w of configWarnings(config)) console.warn('WARN ' + w);
if (config.mode !== 'live') {
  await ensureRoles(config.databaseUrl, config.dbRolePassword);
  await migrate(config.databaseUrl);
}
const d = buildDeps(config);
const app = buildServer(d);
d.queue.start();
// Scheduler tick once a minute; the dedupe key makes extra ticks from other workers harmless.
setInterval(() => {
  const minute = d.clock.now().toISOString().slice(0, 16);
  d.db.system((tx) => enqueue(tx, d.clock, 'tick', {}, { dedupeKey: `tick:${minute}` })).catch((e) => d.log.error('tick_enqueue_failed', { error: String(e) }));
}, 60_000);
// Dual-stack so "localhost" works on Windows (::1); fall back to IPv4 where IPv6 is unavailable.
try {
  await app.listen({ port: config.port, host: '::' });
} catch (e) {
  if ((e as { code?: string }).code !== 'EAFNOSUPPORT') throw e;
  await app.listen({ port: config.port, host: '0.0.0.0' });
}
d.log.info('listening', { port: config.port, mode: config.mode, chat: config.mode === 'web' ? `${config.publicBaseUrl}/` : undefined });

const shutdown = async () => { d.queue.stop(); await app.close(); await d.db.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
