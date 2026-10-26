import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createDatabase, dropDatabase, withDbName } from '../src/db/migrate';
import { Db, roleUrl } from '../src/db/db';
import { loadConfig, type Config } from '../src/config';
import { buildDeps } from '../src/app/build';
import { buildServer } from '../src/http/server';
import { ManualClock } from '../src/lib/clock';
import { silentLogger } from '../src/lib/log';
import { FakeWhatsApp, bodyOf } from '../src/adapters/fake-whatsapp';
import { FakeSocial } from '../src/adapters/fake-social';
import { FakeLlm } from '../src/adapters/llm';
import { FakeInspector } from '../src/adapters/storage';
import { signBody } from '../src/security/crypto';
import { addMember, connectAccount, createWorkspace } from '../src/accounts/workspaces';
import { newId } from '../src/lib/ids';
import { DAY } from '../src/lib/clock';
import type { OutMessage } from '../src/ports';
import type { LlmPort } from '../src/ports';
import { ADMIN_URL, TEMPLATE } from './global-setup';

export const P = { owner: '919000000001', editor: '919000000002', viewer: '919000000003', stranger: '919999999999', owner2: '918000000001' };

export interface HarnessOpts {
  kind?: 'personal' | 'creator' | 'business';
  account?: 'ig_pro' | 'ig_personal' | 'fb_page' | 'none';
  onboarded?: boolean;
  env?: Record<string, string>;
  llm?: LlmPort;
  secondWorkspace?: boolean;
}

export type Harness = Awaited<ReturnType<typeof harness>>;

export async function harness(o: HarnessOpts = {}) {
  const dbName = 'socialops_t_' + newId('x').slice(2, 14);
  await createDatabase(ADMIN_URL, dbName, TEMPLATE);
  const url = withDbName(ADMIN_URL, dbName);
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'socialops-'));
  const config: Config = loadConfig({ MODE: 'mock', DATABASE_URL: url, STORAGE_DIR: storageDir, PUBLIC_BASE_URL: 'http://test.local', ...o.env });
  const clock = new ManualClock();
  const db = new Db(roleUrl(url, 'socialops_app', 'dev'), roleUrl(url, 'socialops_system', 'dev'));
  const wa = new FakeWhatsApp();
  const social = new FakeSocial();
  const llm = o.llm ?? new FakeLlm();
  const inspector = new FakeInspector();
  const d = buildDeps(config, { clock, log: silentLogger, wa, social, llm, inspector, db });
  const app = buildServer(d);
  await app.ready();

  const ws = await createWorkspace(db, { name: 'Test Shop', kind: o.kind ?? 'business', ownerPhone: P.owner });
  await addMember(db, ws, P.editor, 'editor');
  await addMember(db, ws, P.viewer, 'viewer');
  let accountId: string | null = null;
  await db.tenant(ws, async (tx) => {
    if (o.onboarded !== false) {
      await tx.q(`UPDATE workspaces SET onboarded=true WHERE id=$1`, [ws]);
      await tx.q(`INSERT INTO profiles(workspace_id, answers, step, completed_at) VALUES($1,$2,6,now())`, [ws, { business: 'Mithai shop', banned: 'guaranteed', language: 'Hinglish' }]);
    }
    const a = o.account ?? 'ig_pro';
    if (a !== 'none') {
      const spec = a === 'ig_pro' ? ['instagram', 'account', 'professional'] : a === 'ig_personal' ? ['instagram', 'account', 'personal'] : ['facebook', 'page', 'page'];
      const r = await connectAccount(tx, { workspaceId: ws, platform: spec[0]!, surface: spec[1]!, accountType: spec[2]!, externalId: 'ext_' + a, label: '@shop' });
      accountId = r.id;
      await d.credentials.store(tx, { workspaceId: ws, accountId: r.id, provider: spec[0]!, token: 'tok', expiresAt: new Date(clock.now().getTime() + 60 * DAY) });
    }
  });
  let ws2: string | null = null;
  if (o.secondWorkspace) ws2 = await createWorkspace(db, { name: 'Other Shop', kind: 'business', ownerPhone: P.owner2 });

  let n = 0;
  const post = async (message: Record<string, unknown>, pnid = config.wa.phoneNumberId) => {
    const payload = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: pnid }, messages: [message] } }] }] });
    const res = await app.inject({ method: 'POST', url: '/webhook', payload, headers: { 'content-type': 'application/json', 'x-hub-signature-256': signBody(payload, config.wa.appSecret) } });
    await d.queue.drain();
    return res;
  };
  const wamid = () => `wamid.t${++n}`;

  const h = {
    d, app, db, clock, wa, social, llm, inspector, config, ws, ws2, accountId, P,
    say: (from: string, text: string, id = wamid()) => post({ id, from, type: 'text', text: { body: text } }),
    tap: (from: string, buttonId: string, id = wamid()) => post({ id, from, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: buttonId, title: buttonId } } }),
    media: (from: string, o2: { mime?: string; caption?: string; bytes?: Buffer } = {}) => {
      const mime = o2.mime ?? 'video/mp4';
      const mediaId = wa.addMedia(o2.bytes ?? Buffer.from('fake-media-' + n), mime);
      const type = mime.startsWith('video/') ? 'video' : mime.startsWith('image/') ? 'image' : 'document';
      return post({ id: wamid(), from, type, [type]: { id: mediaId, mime_type: mime, caption: o2.caption } });
    },
    post,
    drain: () => d.queue.drain(),
    /** Let time pass, run due jobs and the scheduler. */
    advance: async (ms: number) => { clock.advance(ms); await d.queue.drain(); },
    msgs: (phone: string): OutMessage[] => wa.to(phone),
    last: (phone: string): string => bodyOf(wa.last(phone)),
    lastMsg: (phone: string) => wa.last(phone),
    texts: (phone: string): string[] => wa.to(phone).map(bodyOf),
    buttons: (phone: string): string[] => { const m = wa.last(phone); return m?.kind === 'buttons' ? m.buttons.map((b) => b.id) : []; },
    findButton: (phone: string, prefix: string): string => {
      for (const m of [...wa.to(phone)].reverse()) if (m.kind === 'buttons') { const b = m.buttons.find((x) => x.id.startsWith(prefix)); if (b) return b.id; }
      throw new Error(`no button ${prefix} for ${phone}`);
    },
    sys: <T = any>(sql: string, params: unknown[] = []) => db.system((tx) => tx.q<T>(sql, params)),
    task: async (workflow = 'post') => (await db.system((tx) => tx.q<any>(`SELECT * FROM tasks WHERE workspace_id=$1 AND workflow=$2 ORDER BY created_at DESC LIMIT 1`, [ws, workflow])))[0],
    approvals: () => db.system((tx) => tx.q<any>(`SELECT * FROM approvals WHERE workspace_id=$1 ORDER BY created_at`, [ws])),
    /** Media -> topic -> consent (if asked) -> approval card. Returns the approve button id. */
    toApproval: async (from = P.owner, caption = 'Diwali sale 20% off 31 Oct tak') => {
      await h.media(from, { caption });
      const t = await h.task();
      if (t.state === 'need_consent') await h.tap(from, `c:${t.id}:n`);
      return h.findButton(P.owner, 'a:');
    },
    close: async () => {
      await app.close();
      await db.close();
      await dropDatabase(ADMIN_URL, dbName);
      fs.rmSync(storageDir, { recursive: true, force: true });
    },
  };
  return h;
}
