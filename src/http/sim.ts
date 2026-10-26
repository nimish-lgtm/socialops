import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Deps } from '../app/deps';
import { FakeWhatsApp, type WaFault } from '../adapters/fake-whatsapp';
import { FakeSocial, type SocialFault } from '../adapters/fake-social';
import { FakeLlm } from '../adapters/llm';
import { signBody } from '../security/crypto';
import { addMember, connectAccount, createWorkspace } from '../accounts/workspaces';
import { runScheduler } from '../jobs/scheduler';
import { DAY } from '../lib/clock';
import { newId } from '../lib/ids';

export const SIM_PHONES = { owner: '919000000001', editor: '919000000002', viewer: '919000000003', stranger: '919999999999' };

/** Browser simulator: drives the real webhook path with signed payloads and shows internal state. Never in hybrid/live. */
export function registerSim(app: FastifyInstance, d: Deps): void {
  if (!(d.wa instanceof FakeWhatsApp) || !(d.social instanceof FakeSocial)) return;
  const wa = d.wa;
  const social = d.social;
  const inbound: Array<{ phone: string; text: string; at: number }> = [];
  const page = fs.readFileSync(path.resolve(import.meta.dirname, '../../sim/index.html'), 'utf8');

  app.get('/sim', async (_req, reply) => reply.type('text/html').send(page));

  app.post('/sim/api/setup', async (req) => {
    const b = (req.body ?? {}) as { kind?: 'personal' | 'creator' | 'business'; account?: 'ig_pro' | 'ig_personal' | 'none'; onboarded?: boolean };
    const existing = await d.db.system((tx) => tx.one<{ workspace_id: string }>('SELECT workspace_id FROM members WHERE phone=$1', [SIM_PHONES.owner]));
    if (existing) {
      await d.db.system((tx) => tx.q('DELETE FROM workspaces WHERE id=$1', [existing.workspace_id]));
      await d.db.system((tx) => tx.q('DELETE FROM conversations WHERE phone = ANY($1)', [Object.values(SIM_PHONES)]));
    }
    wa.sent.length = 0;
    inbound.length = 0;
    const ws = await createWorkspace(d.db, { name: 'Demo Mithai Shop', kind: b.kind ?? 'business', ownerPhone: SIM_PHONES.owner });
    await addMember(d.db, ws, SIM_PHONES.editor, 'editor');
    await addMember(d.db, ws, SIM_PHONES.viewer, 'viewer');
    await d.db.tenant(ws, async (tx) => {
      if (b.onboarded !== false) {
        await tx.q(`UPDATE workspaces SET onboarded=true WHERE id=$1`, [ws]);
        await tx.q(`INSERT INTO profiles(workspace_id, answers, step, completed_at) VALUES($1,$2,6,now())`, [ws, { business: 'Mithai ki dukaan, Agra', offer: 'Mithai aur namkeen', audience: 'Agra ke parivaar', tone: 'seedha aur garam', banned: 'guaranteed, sabse sasta', language: 'Hinglish' }]);
      }
      const acct = b.account ?? 'ig_pro';
      if (acct !== 'none') {
        const r = await connectAccount(tx, { workspaceId: ws, platform: 'instagram', surface: 'account', accountType: acct === 'ig_pro' ? 'professional' : 'personal', externalId: 'fake_ig_demo', label: '@demo_mithai' });
        await d.credentials.store(tx, { workspaceId: ws, accountId: r.id, provider: 'instagram', token: 'fake-token', expiresAt: new Date(d.clock.now().getTime() + 60 * DAY) });
      }
    });
    return { workspaceId: ws, phones: SIM_PHONES };
  });

  app.post('/sim/api/send', async (req, reply) => {
    const b = req.body as { from?: string; text?: string; buttonId?: string; buttonTitle?: string; media?: { base64: string; mime: string; caption?: string } };
    if (!b?.from) return reply.code(400).send({ error: 'from required' });
    const id = newId('wamid.sim');
    let message: Record<string, unknown>;
    if (b.media) {
      const mediaId = wa.addMedia(Buffer.from(b.media.base64, 'base64'), b.media.mime);
      const type = b.media.mime.startsWith('video/') ? 'video' : b.media.mime.startsWith('image/') ? 'image' : 'document';
      message = { id, from: b.from, type, [type]: { id: mediaId, mime_type: b.media.mime, caption: b.media.caption } };
      inbound.push({ phone: b.from, text: `[${type}]${b.media.caption ? ' ' + b.media.caption : ''}`, at: Date.now() });
    } else if (b.buttonId) {
      message = { id, from: b.from, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: b.buttonId, title: b.buttonTitle ?? b.buttonId } } };
      inbound.push({ phone: b.from, text: `[tap] ${b.buttonTitle ?? b.buttonId}`, at: Date.now() });
    } else {
      message = { id, from: b.from, type: 'text', text: { body: b.text ?? '' } };
      inbound.push({ phone: b.from, text: b.text ?? '', at: Date.now() });
    }
    const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { metadata: { phone_number_id: d.config.wa.phoneNumberId }, messages: [message] } }] }] });
    const res = await app.inject({ method: 'POST', url: '/webhook', payload, headers: { 'content-type': 'application/json', 'x-hub-signature-256': signBody(payload, d.config.wa.appSecret) } });
    await d.queue.drain();
    return { status: res.statusCode };
  });

  app.get('/sim/api/state', async (req) => {
    const phone = String((req.query as { phone?: string }).phone ?? SIM_PHONES.owner);
    const chat = [
      ...inbound.filter((m) => m.phone === phone).map((m) => ({ dir: 'in', text: m.text, at: m.at })),
      ...wa.sent.filter((s) => s.to === phone).map((s) => ({ dir: 'out', text: s.msg.kind === 'template' ? `[template ${s.msg.name}]` : s.msg.body, buttons: s.msg.kind === 'buttons' ? s.msg.buttons : [], at: s.at })),
    ].sort((a, b) => a.at - b.at);
    const ws = await d.db.system((tx) => tx.one<{ workspace_id: string }>('SELECT workspace_id FROM members WHERE phone=$1', [SIM_PHONES.owner]));
    if (!ws) return { chat, state: null };
    const state = await d.db.system(async (tx) => ({
      workspace: await tx.one('SELECT id, name, kind, status, onboarded FROM workspaces WHERE id=$1', [ws.workspace_id]),
      accounts: await tx.q('SELECT platform, surface, account_type, route, status, label FROM accounts WHERE workspace_id=$1', [ws.workspace_id]),
      tasks: await tx.q(`SELECT id, workflow, state, data->>'consent' consent, data->>'caption' caption, updated_at FROM tasks WHERE workspace_id=$1 ORDER BY updated_at DESC LIMIT 8`, [ws.workspace_id]),
      approvals: await tx.q('SELECT id, task_id, status, left(payload_hash,10) hash, expires_at FROM approvals WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 8', [ws.workspace_id]),
      ledger: await tx.q('SELECT idempotency_key, op, status, started_at FROM actions WHERE workspace_id=$1 ORDER BY started_at DESC LIMIT 8', [ws.workspace_id]),
      posts: await tx.q('SELECT platform, status, url, verified_at FROM posts WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 8', [ws.workspace_id]),
      jobs: await tx.q(`SELECT kind, status, attempts, last_error FROM jobs WHERE workspace_id=$1 AND status<>'done' ORDER BY created_at DESC LIMIT 8`, [ws.workspace_id]),
      audit: await tx.q('SELECT event, actor, detail, at FROM audit WHERE workspace_id=$1 ORDER BY id DESC LIMIT 15', [ws.workspace_id]),
      usage: await tx.one('SELECT COUNT(*) calls, COALESCE(SUM(cost_minor),0) paise FROM usage_events WHERE workspace_id=$1', [ws.workspace_id]),
    }));
    return { chat, state, faults: { wa: wa.fault, social: social.fault, llm: d.llm instanceof FakeLlm ? d.llm.fail : 'n/a' }, platformPosts: social.posts.size };
  });

  app.post('/sim/api/faults', async (req) => {
    const b = req.body as { wa?: WaFault; social?: SocialFault; llm?: 'none' | 'error' | 'junk' };
    if (b.wa) wa.fault = b.wa;
    if (b.social) social.fault = b.social;
    if (b.llm && d.llm instanceof FakeLlm) d.llm.fail = b.llm;
    return { ok: true };
  });

  app.post('/sim/api/tick', async () => {
    await runScheduler(d);
    await d.queue.drain();
    return { ok: true };
  });

  app.post('/sim/api/drain', async () => ({ ran: await d.queue.drain() }));
}
