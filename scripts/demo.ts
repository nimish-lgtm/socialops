// Scripted conversation against fakes and a real local Postgres. Prints what each phone sees.
import { loadConfig, loadEnvFile } from '../src/config';
import { buildDeps } from '../src/app/build';
import { buildServer } from '../src/http/server';
import { ensureRoles, migrate } from '../src/db/migrate';
import { silentLogger } from '../src/lib/log';
import { FakeWhatsApp, bodyOf } from '../src/adapters/fake-whatsapp';
import { SIM_PHONES } from '../src/http/sim';

loadEnvFile();
const config = loadConfig({ ...process.env, MODE: 'sim' });
await ensureRoles(config.databaseUrl, config.dbRolePassword);
await migrate(config.databaseUrl);
const d = buildDeps(config, { log: silentLogger });
const app = buildServer(d);
await app.ready();
const wa = d.wa as FakeWhatsApp;
const api = async (p: string, body: unknown) => (await app.inject({ method: 'POST', url: '/sim/api/' + p, payload: body as object })).json();
const show = (from: number) => { for (const s of wa.sent.slice(from)) console.log(`  BOT -> ${s.to}: ${bodyOf(s.msg).replace(/\n/g, '\n      ')}${s.msg.kind === 'buttons' ? `\n      [${s.msg.buttons.map((b) => b.title).join(' | ')}]` : ''}`); };
const step = async (label: string, from: string, body: Record<string, unknown>) => {
  console.log(`\n${label}\n  ${from === SIM_PHONES.owner ? 'OWNER' : from === SIM_PHONES.editor ? 'EDITOR' : 'USER'}: ${body.text ?? body.buttonTitle ?? '[media] ' + ((body.media as { caption?: string })?.caption ?? '')}`);
  const n = wa.sent.length;
  await api('send', { from, ...body });
  show(n);
};
const button = (prefix: string) => { for (const s of [...wa.sent].reverse()) if (s.msg.kind === 'buttons') { const b = s.msg.buttons.find((x) => x.id.startsWith(prefix)); if (b) return b; } throw new Error('no button ' + prefix); };

await api('setup', { kind: 'business', account: 'ig_pro', onboarded: true });
// A real 1x1 PNG so the ffprobe quality check passes.
const video = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
await step('1. Editor sends a photo', SIM_PHONES.editor, { media: { base64: video, mime: 'image/jpeg', caption: 'Diwali special laddoo 20% off 31 Oct tak' } });
const c = button('c:');
await step('2. Editor answers the consent question', SIM_PHONES.editor, { buttonId: c.id, buttonTitle: c.title });
console.log('\n   (the owner has not written in 24h, so WhatsApp only allows templates; the card is held)');
await step('3. Owner writes; the held approval card is delivered', SIM_PHONES.owner, { text: 'status' });
const a = button('a:');
await step('4. Owner approves', SIM_PHONES.owner, { buttonId: a.id, buttonTitle: 'Approve' });
await step('5. Owner asks for a report', SIM_PHONES.owner, { text: 'report' });
await step('6. A stranger writes', SIM_PHONES.stranger, { text: 'hello' });
await app.close();
await d.db.close();
