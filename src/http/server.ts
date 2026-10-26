import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { Deps } from '../app/deps';
import { verifySignature } from '../security/crypto';
import { handleWebhook } from '../channel/ingress';
import { addMember, connectAccount, createWorkspace } from '../accounts/workspaces';
import { authorizeUrl, exchangeAndDiscover } from '../accounts/meta-oauth';
import { guardedFetch } from '../core/gateway';
import { copy } from '../copy';
import { DAY } from '../lib/clock';
import { owners, platformLabel } from '../workflows/helpers';
import { registerSim } from './sim';

declare module 'fastify' { interface FastifyRequest { rawBody?: Buffer } }

const html = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:40px auto;padding:0 16px;line-height:1.5}button{padding:10px 14px;margin:4px 0;width:100%;font-size:16px}</style></head><body>${body}</body></html>`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function buildServer(d: Deps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: d.config.mode === 'sim' ? 20 * 1024 * 1024 : 1024 * 1024 });

  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req: FastifyRequest, body: Buffer, done) => {
    req.rawBody = body;
    if (!body.length) return done(null, {});
    try { done(null, JSON.parse(body.toString('utf8'))); } catch { done(null, { __invalid: true }); }
  });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body: string, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body)));
  });

  app.get('/health', async () => ({ ok: true, mode: d.config.mode }));

  // Meta webhook subscription handshake.
  app.get('/webhook', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const ok = q['hub.mode'] === 'subscribe' && !!d.config.wa.verifyToken && q['hub.verify_token'] === d.config.wa.verifyToken;
    return ok ? reply.type('text/plain').send(q['hub.challenge'] ?? '') : reply.code(403).send();
  });

  app.post('/webhook', async (req, reply) => {
    if (!verifySignature(req.rawBody ?? Buffer.alloc(0), req.headers['x-hub-signature-256'], d.config.wa.appSecret)) return reply.code(401).send();
    const body = req.body as Record<string, unknown>;
    if (!body || body.__invalid) { d.log.warn('bad_payload'); return reply.send('ok'); }
    // Work done here is small (dedupe, routing, enqueue); slow work runs in jobs, so the ack stays fast.
    try { await handleWebhook(d, body); } catch (e) { d.log.error('webhook_error', { error: (e as Error).message }); }
    return reply.send('ok');
  });

  // Signed, expiring media link so a platform can fetch the file for publishing.
  app.get('/media', async (req, reply) => {
    const t = String((req.query as Record<string, string>).t ?? '');
    const link = await d.links.redeem(t, 'media', d.clock.now());
    if (!link) return reply.code(404).send();
    const file = d.storage.resolve(link.ref);
    const ext = path.extname(file).slice(1);
    return reply.type(ext === 'mp4' ? 'video/mp4' : ext === 'png' ? 'image/png' : 'image/jpeg').send(fs.createReadStream(file));
  });

  app.get('/export', async (req, reply) => {
    const t = String((req.query as Record<string, string>).t ?? '');
    const link = await d.links.redeem(t, 'export', d.clock.now());
    if (!link) return reply.code(410).type('text/html').send(html('Expired', '<p>Ye link expire ho gaya ya pehle use ho chuka hai.</p>'));
    return reply.type('application/gzip').header('content-disposition', 'attachment; filename="socialops-export.json.gz"').send(fs.createReadStream(d.storage.resolve(link.ref)));
  });

  // ---- account connection
  app.get('/connect/start', async (req, reply) => {
    const t = String((req.query as Record<string, string>).t ?? '');
    const link = await d.links.redeem(t, 'reconnect', d.clock.now());
    if (!link) return reply.code(410).type('text/html').send(html('Expired', '<p>Ye link expire ho gaya. WhatsApp par "connect" likh kar naya link lein.</p>'));
    const state = await d.db.tenant(link.workspaceId, (tx) => d.links.create(tx, { workspaceId: link.workspaceId, kind: 'reconnect', ref: 'state', expiresAt: new Date(d.clock.now().getTime() + 15 * 60_000) }));
    if (d.config.mode === 'live') return reply.redirect(authorizeUrl(d, state));
    return reply.type('text/html').send(html('Connect account', `<h2>Account jodein (test provider)</h2>
<p>Ye ${esc(d.config.mode)} mode hai: koi real account nahi juda jayega.</p>
<form method="post" action="/connect/fake"><input type="hidden" name="state" value="${esc(state)}">
<p><label>Naam/handle <input name="label" value="@demo_shop"></label></p>
<button name="kind" value="ig_pro">Instagram Professional</button>
<button name="kind" value="fb_page">Facebook Page</button>
<button name="kind" value="ig_personal">Instagram personal</button>
<button name="kind" value="fb_profile">Facebook personal profile</button></form>`));
  });

  app.post('/connect/fake', async (req, reply) => {
    if (d.config.mode === 'live') return reply.code(404).send();
    const b = req.body as Record<string, string>;
    const link = await d.links.redeem(String(b.state ?? ''), 'reconnect', d.clock.now());
    if (!link || link.ref !== 'state') return reply.code(410).type('text/html').send(html('Expired', '<p>Session expire ho gaya. Dobara "connect" likhein.</p>'));
    const kinds: Record<string, [string, string, string]> = { ig_pro: ['instagram', 'account', 'professional'], fb_page: ['facebook', 'page', 'page'], ig_personal: ['instagram', 'account', 'personal'], fb_profile: ['facebook', 'profile', 'personal'] };
    const k = kinds[String(b.kind)];
    if (!k) return reply.code(400).send();
    const label = String(b.label ?? '').slice(0, 60) || 'demo';
    await finishConnect(d, link.workspaceId, [{ platform: k[0], surface: k[1], accountType: k[2], externalId: `fake_${k[0]}_${label.replace(/\W/g, '')}`, label, token: 'fake-token' }]);
    return reply.type('text/html').send(html('Connected', '<h2>Jud gaya ✅</h2><p>Ab WhatsApp par wapas jaayein.</p>'));
  });

  app.get('/connect/meta/callback', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const link = await d.links.redeem(String(q.state ?? ''), 'reconnect', d.clock.now());
    if (!link || link.ref !== 'state' || !q.code) return reply.code(410).type('text/html').send(html('Expired', '<p>Session expire ho gaya. Dobara "connect" likhein.</p>'));
    try {
      const found = await exchangeAndDiscover(d, q.code, guardedFetch(['graph.facebook.com']));
      if (!found.length) return reply.type('text/html').send(html('Nothing found', '<p>Koi Facebook Page nahi mila. Page ka admin account se login karein.</p>'));
      await finishConnect(d, link.workspaceId, found);
      return reply.type('text/html').send(html('Connected', `<h2>Jud gaya ✅</h2><p>${found.map((f) => esc(f.label)).join(', ')}</p>`));
    } catch (e) {
      d.log.warn('meta_connect_failed', { error: (e as Error).message });
      return reply.code(502).type('text/html').send(html('Error', '<p>Connect nahi ho paya. Thodi der baad dobara try karein.</p>'));
    }
  });

  // ---- operator API (never approves on an owner's behalf)
  const opAuth = (req: FastifyRequest): boolean => {
    const h = String(req.headers.authorization ?? '');
    const want = Buffer.from('Bearer ' + d.config.operatorToken);
    const got = Buffer.from(h);
    return !!d.config.operatorToken && got.length === want.length && timingSafeEqual(got, want);
  };
  app.register(async (ops) => {
    ops.addHook('onRequest', async (req, reply) => { if (!opAuth(req)) return reply.code(401).send({ error: 'unauthorized' }); });
    const audit = (ws: string | null, event: string, detail: Record<string, unknown>) =>
      d.db.system((tx) => tx.q(`INSERT INTO audit(workspace_id, actor, event, detail) VALUES($1,'operator',$2,$3)`, [ws, event, detail]));

    ops.post('/ops/workspaces', async (req, reply) => {
      const b = req.body as { name?: string; kind?: string; ownerPhone?: string; aiDailyBudgetInr?: number };
      if (!b?.name || !b.ownerPhone || !['personal', 'creator', 'business'].includes(String(b.kind))) return reply.code(400).send({ error: 'name, kind, ownerPhone required' });
      try {
        const id = await createWorkspace(d.db, { name: b.name, kind: b.kind as 'business', ownerPhone: b.ownerPhone, aiDailyBudgetMinor: b.aiDailyBudgetInr != null ? Math.round(b.aiDailyBudgetInr * 100) : null });
        return { id };
      } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
    });
    ops.post('/ops/workspaces/:id/members', async (req, reply) => {
      const b = req.body as { phone?: string; role?: string };
      if (!b?.phone || !['owner', 'editor', 'viewer'].includes(String(b.role))) return reply.code(400).send({ error: 'phone, role required' });
      try { await addMember(d.db, (req.params as { id: string }).id, b.phone, b.role as 'editor'); return { ok: true }; }
      catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
    });
    ops.post('/ops/workspaces/:id/:action', async (req, reply) => {
      const { id, action } = req.params as { id: string; action: string };
      if (action !== 'pause' && action !== 'resume') return reply.code(404).send();
      const r = await d.db.system((tx) => tx.q(`UPDATE workspaces SET status=$2 WHERE id=$1 AND status IN ('active','paused') RETURNING id`, [id, action === 'pause' ? 'paused' : 'active']));
      if (!r.length) return reply.code(404).send();
      await audit(id, 'operator_' + action, { reason: (req.body as { reason?: string })?.reason ?? null });
      return { id, status: action === 'pause' ? 'paused' : 'active' };
    });
    ops.get('/ops/tasks', async (req) => {
      const q = req.query as { state?: string };
      return d.db.system((tx) => tx.q(`SELECT id, workspace_id, workflow, state, data->>'escalation' AS reason, updated_at FROM tasks WHERE state=$1 ORDER BY updated_at LIMIT 100`, [q.state ?? 'needs_human']));
    });
    ops.post('/ops/tasks/:id/resolve', async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = req.body as { action?: string; note?: string };
      if (!['retry', 'cancel'].includes(String(b?.action))) return reply.code(400).send({ error: 'action must be retry (new owner approval) or cancel' });
      const t = await d.db.system((tx) => tx.one<{ workspace_id: string }>('SELECT workspace_id FROM tasks WHERE id=$1', [id]));
      if (!t) return reply.code(404).send();
      const r = await d.engine.dispatch(t.workspace_id, id, String(b.action), {});
      await audit(t.workspace_id, 'operator_resolve', { task: id, action: b.action, note: b.note ?? null });
      return r.ok ? r : reply.code(409).send(r);
    });
    ops.get('/ops/jobs/dead', async () => d.db.system((tx) => tx.q(`SELECT id, workspace_id, kind, attempts, last_error FROM jobs WHERE status='dead' ORDER BY created_at DESC LIMIT 100`)));
    ops.post('/ops/jobs/:id/replay', async (req, reply) => {
      const { id } = req.params as { id: string };
      const r = await d.db.system((tx) => tx.q(`UPDATE jobs SET status='queued', attempts=0, run_at=$2, last_error=NULL WHERE id=$1 AND status='dead' RETURNING workspace_id`, [id, d.clock.now()]));
      if (!r.length) return reply.code(409).send({ error: 'not a dead job' });
      await audit((r[0] as { workspace_id: string | null }).workspace_id, 'operator_replay', { job: id });
      return { id, status: 'queued' };
    });
    ops.get('/ops/workspaces/:id/usage', async (req) => {
      const { id } = req.params as { id: string };
      return d.db.system((tx) => tx.one(`SELECT COALESCE(SUM(cost_minor) FILTER (WHERE priced),0)::bigint AS priced_paise, COUNT(*) FILTER (WHERE NOT priced) AS unpriced_events, COUNT(*) FILTER (WHERE measured) AS measured_events, COUNT(*) AS events FROM usage_events WHERE workspace_id=$1`, [id]));
    });
  });

  if (d.config.mode === 'sim' || d.config.mode === 'mock') registerSim(app, d);
  return app;
}

async function finishConnect(d: Deps, ws: string, accounts: Array<{ platform: string; surface: string; accountType: string; externalId: string; label: string; token: string }>): Promise<void> {
  await d.db.tenant(ws, async (tx) => {
    const lines: string[] = [];
    for (const a of accounts) {
      const r = await connectAccount(tx, { workspaceId: ws, ...a });
      await d.credentials.store(tx, { workspaceId: ws, accountId: r.id, provider: a.platform, token: a.token, expiresAt: new Date(d.clock.now().getTime() + 60 * DAY) });
      lines.push(copy.connected(platformLabel({ platform: a.platform, surface: a.surface, label: a.label }), r.route));
    }
    // Posts that were waiting only because no account was connected can now be routed.
    const held = await tx.q<{ id: string }>(`SELECT id FROM tasks WHERE workflow='post' AND state='blocked_route'`);
    for (const t of held) await d.engine.dispatchIn(tx, t.id, 'retry', {});
    for (const o of await owners(tx, ws)) await d.messenger.queue(tx, { workspaceId: ws, to: o, msg: { kind: 'text', body: lines.join('\n') }, key: `connected:${ws}:${d.clock.now().getTime()}:${o}` });
  });
}
