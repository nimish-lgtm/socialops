import zlib from 'node:zlib';
import type { Deps } from '../app/deps';
import type { Job } from '../core/queue';
import type { TaskRow } from '../core/engine';
import { AppError, errClass } from '../lib/errors';
import { newId, sha256 } from '../lib/ids';
import { DAY, HOUR } from '../lib/clock';
import { runOnce } from '../core/ledger';
import { markUsed, verifyApproval } from '../policy/approvals';
import { copy } from '../copy';
import { accountRef, owners, platformLabel, publishPayload, type AccountRow } from '../workflows/helpers';
import { exportWorkspace } from '../privacy/privacy';
import { runScheduler } from './scheduler';

const loadTask = (d: Deps, ws: string, id: string) => d.db.tenant(ws, (tx) => tx.one<TaskRow>('SELECT * FROM tasks WHERE id=$1', [id]));

export function qcProblems(qc: { durationS: number | null; width: number | null; height: number | null; skipped?: boolean }, mime: string): string[] {
  const p: string[] = [];
  if (!mime.startsWith('video/') && !mime.startsWith('image/')) return ['sirf photo ya video chalega'];
  if (qc.skipped) return p;
  if (!qc.width || !qc.height) p.push('file padh nahi paya'); // ffprobe reports 0x0 for corrupt files
  if (mime.startsWith('video/') && qc.durationS !== null && qc.durationS < 3) p.push('video 3 second se chhota hai');
  if (mime.startsWith('video/') && qc.durationS !== null && qc.durationS > 900) p.push('video 15 minute se lamba hai');
  return p;
}

export async function reconnectNotice(d: Deps, ws: string, acct: AccountRow): Promise<void> {
  await d.db.tenant(ws, async (tx) => {
    await d.credentials.markExpired(tx, acct.id);
    const token = await d.links.create(tx, { workspaceId: ws, kind: 'reconnect', ref: acct.id, expiresAt: new Date(d.clock.now().getTime() + 24 * HOUR) });
    const url = d.links.url('/connect/start', token);
    for (const o of await owners(tx, ws)) await d.messenger.queue(tx, { workspaceId: ws, to: o, msg: { kind: 'text', body: copy.reconnect(platformLabel(acct), url) }, key: `reconnect:${acct.id}:${d.clock.now().toISOString().slice(0, 10)}:${o}` });
  });
}

export function registerJobs(d: Deps): void {
  const q = d.queue;

  q.on('send', { run: (job) => d.messenger.deliver(job), leaseMs: 30_000 });

  q.on('ingest_media', {
    leaseMs: 120_000,
    async run(job) {
      const ws = job.workspace_id!;
      const t = await loadTask(d, ws, String(job.payload.taskId));
      if (!t || t.state !== 'received') return;
      let media: { data: Buffer; mime: string };
      try {
        media = await d.gateway.call('ingest', 'wa.media', { workspaceId: ws }, () => d.wa.downloadMedia(t.data.mediaId));
      } catch (e) {
        if (errClass(e) === 'definitive') { await d.engine.dispatch(ws, t.id, 'qc_fail', { problems: ['file download nahi hui, dobara bhejein'] }); return; }
        throw e;
      }
      const mime = t.data.mime || media.mime;
      const stored = await d.storage.put(ws, media.data, mime);
      const qc = await d.inspector.inspect(d.storage.resolve(stored.ref), mime);
      const problems = qcProblems(qc, mime);
      if (qc.skipped) d.log.warn('media_qc_skipped', { reason: 'ffprobe not installed' });
      const assetId = newId('asset');
      await d.db.tenant(ws, async (tx) => {
        await tx.q(`INSERT INTO assets(id, workspace_id, kind, ref, sha256, mime, bytes, qc, created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [assetId, ws, mime.split('/')[0], stored.ref, stored.sha256, mime, stored.bytes, qc, d.clock.now()]);
        await d.engine.dispatchIn(tx, t.id, problems.length ? 'qc_fail' : 'qc_ok', problems.length ? { problems } : { assetId, sha256: stored.sha256, mime });
      });
    },
  });

  q.on('draft_caption', {
    leaseMs: 90_000,
    async run(job) {
      const ws = job.workspace_id!;
      const t = await loadTask(d, ws, String(job.payload.taskId));
      if (!t || t.state !== 'drafting') return;
      const ctx = await d.db.tenant(ws, async (tx) => ({
        profile: (await tx.one<{ answers: Record<string, unknown> }>('SELECT answers FROM profiles WHERE workspace_id=$1', [ws]))?.answers ?? {},
        kind: (await tx.one<{ kind: string }>('SELECT kind FROM workspaces WHERE id=$1', [ws]))!.kind,
      }));
      const r = await d.skills.caption(ws, { topic: String(t.data.topic ?? ''), profile: ctx.profile, kind: ctx.kind });
      if (r.ok) { await d.engine.dispatch(ws, t.id, 'drafted', { caption: r.value.caption, hashtags: r.value.hashtags }); return; }
      if (r.reason === 'denied') { await d.engine.dispatch(ws, t.id, 'ai_unavailable', { reason: r.detail }); return; }
      if (r.reason === 'invalid') { await d.engine.dispatch(ws, t.id, 'draft_failed', {}); return; }
      throw new AppError('llm_unavailable', 'transient', r.detail);
    },
    async onDead(job) {
      await d.engine.dispatch(job.workspace_id!, String(job.payload.taskId), 'draft_failed', {});
    },
  });

  q.on('publish', {
    leaseMs: 300_000,
    async run(job) { await publish(d, job); },
    async onDead(job, err) {
      await d.engine.dispatch(job.workspace_id!, String(job.payload.taskId), 'escalate', { reason: (err as Error).message });
    },
  });

  q.on('report', { leaseMs: 120_000, async run(job) { await report(d, job.workspace_id!, String(job.payload.phone), job.id); } });
  q.on('digest', { leaseMs: 120_000, async run(job) { await digest(d, job.workspace_id!); } });

  q.on('health', {
    leaseMs: 60_000,
    async run(job) {
      const ws = job.workspace_id!;
      const acct = await d.db.tenant(ws, (tx) => tx.one<AccountRow>('SELECT * FROM accounts WHERE id=$1', [String(job.payload.accountId)]));
      if (!acct || acct.status === 'disconnected') return;
      let token: string;
      try { token = await d.db.tenant(ws, (tx) => d.credentials.token(tx, acct.id, d.clock.now())); }
      catch { if (acct.route === 'E') await reconnectNotice(d, ws, acct); return; }
      const s = await d.gateway.call('health', 'social.check', { workspaceId: ws }, () => d.social.checkToken({ account: accountRef(acct), token }));
      if (s === 'expired') await reconnectNotice(d, ws, acct);
    },
  });

  q.on('export', {
    leaseMs: 300_000,
    async run(job) {
      const ws = job.workspace_id!;
      const data = await d.db.tenant(ws, (tx) => exportWorkspace(tx, ws));
      const gz = zlib.gzipSync(Buffer.from(JSON.stringify(data, null, 1)));
      const stored = await d.storage.put(ws, gz, 'application/gzip');
      await d.db.tenant(ws, async (tx) => {
        const token = await d.links.create(tx, { workspaceId: ws, kind: 'export', ref: stored.ref, expiresAt: new Date(d.clock.now().getTime() + 24 * HOUR) });
        await d.messenger.queue(tx, { workspaceId: ws, to: String(job.payload.phone), msg: { kind: 'text', body: copy.exportReady(d.links.url('/export', token)) }, key: `export:${job.id}` });
      });
    },
  });

  q.on('erase_workspace', {
    leaseMs: 300_000,
    async run(job) {
      const ws = String(job.payload.workspaceId);
      const phones = await d.db.system(async (tx) => {
        const ph = (await tx.q<{ phone: string }>(`SELECT phone FROM members WHERE workspace_id=$1 AND role='owner'`, [ws])).map((r) => r.phone);
        await tx.q(`UPDATE audit SET workspace_id=$2, detail='{}' WHERE workspace_id=$1`, [ws, 'erased:' + sha256(ws).slice(0, 12)]);
        await tx.q(`UPDATE conversations SET workspace_id=NULL, state='idle', context='{}', history='[]' WHERE workspace_id=$1`, [ws]);
        await tx.q(`DELETE FROM workspaces WHERE id=$1`, [ws]);
        for (const p of ph) await d.messenger.queue(tx, { workspaceId: null, to: p, msg: { kind: 'text', body: copy.deleted }, key: `erased:${ws}:${p}` });
        await tx.q(`INSERT INTO audit(workspace_id, actor, event, detail) VALUES(NULL,'system','workspace_erased','{}')`);
        return ph;
      });
      await d.storage.removeWorkspace(ws);
      d.log.info('workspace_erased', { owners: phones.length });
    },
  });

  q.on('tick', { leaseMs: 120_000, async run() { await runScheduler(d); } });
}

async function publish(d: Deps, job: Job): Promise<void> {
  const ws = job.workspace_id!;
  const taskId = String(job.payload.taskId);
  const approvalId = String(job.payload.approvalId);
  const now = d.clock.now();

  // Every gate is checked again at execution time, not trusted from when the card was sent.
  const gate = await d.db.tenant(ws, async (tx) => {
    const t = await tx.one<TaskRow>('SELECT * FROM tasks WHERE id=$1', [taskId]);
    if (!t || t.state !== 'publishing' || t.data.approvalId !== approvalId) return { kind: 'skip' as const };
    const w = await tx.one<{ status: string }>('SELECT status FROM workspaces WHERE id=$1', [ws]);
    if (w?.status !== 'active') return { kind: 'block' as const, reason: copy.paused };
    const acct = await tx.one<AccountRow>('SELECT * FROM accounts WHERE id=$1', [t.data.accountId]);
    if (!acct || acct.status !== 'connected' || !d.social.canPublish(accountRef(acct))) return { kind: 'block' as const, reason: copy.notConnected };
    if (t.data.consent !== 'none' && t.data.consent !== 'others_ok') return { kind: 'escalate' as const, reason: 'consent_not_ok' };
    const payload = publishPayload(t.data);
    try { await verifyApproval(tx, approvalId, payload); } catch (e) { return { kind: 'escalate' as const, reason: (e as AppError).code }; }
    let token: string;
    try { token = await d.credentials.token(tx, acct.id, now); } catch { return { kind: 'expired' as const, acct }; }
    const asset = await tx.one<{ ref: string; mime: string; sha256: string }>('SELECT ref, mime, sha256 FROM assets WHERE id=$1', [t.data.assetId]);
    if (!asset || asset.sha256 !== t.data.assetSha) return { kind: 'escalate' as const, reason: 'asset_mismatch' };
    const mediaToken = await d.links.create(tx, { workspaceId: ws, kind: 'media', ref: asset.ref, expiresAt: new Date(now.getTime() + 2 * HOUR), maxUses: 10 });
    return { kind: 'go' as const, t, acct, payload, token, media: { ref: asset.ref, mime: asset.mime, sha256: asset.sha256, publicUrl: d.links.url('/media', mediaToken) } };
  });
  if (gate.kind === 'skip') return;
  if (gate.kind === 'block') { await d.engine.dispatch(ws, taskId, 'blocked', { reason: gate.reason }); return; }
  if (gate.kind === 'escalate') { await d.engine.dispatch(ws, taskId, 'escalate', { reason: gate.reason }); return; }
  if (gate.kind === 'expired') { await reconnectNotice(d, ws, gate.acct); await d.engine.dispatch(ws, taskId, 'blocked', { reason: copy.notConnected }); return; }

  const { acct, payload, token, media } = gate;
  const ref = accountRef(acct);
  const key = `publish:${taskId}:${acct.id}:${approvalId}`;
  let res: { externalId: string; url: string | null };
  try {
    res = await runOnce(d.db, d.clock, ws, { key, adapter: 'social', op: 'publish', request: payload, inFlightMs: 150_000 },
      () => d.gateway.call('publisher', 'social.publish', { workspaceId: ws, approvalId }, () => d.social.publish({ account: ref, media, caption: payload.caption, idempotencyKey: key, token })),
      () => d.gateway.call('publisher', 'social.find', { workspaceId: ws }, () => d.social.findByKey({ account: ref, idempotencyKey: key, caption: payload.caption, token })));
  } catch (e) {
    const err = e as AppError;
    if (err.code === 'token_expired') { await reconnectNotice(d, ws, acct); await d.engine.dispatch(ws, taskId, 'blocked', { reason: copy.notConnected }); return; }
    if (err.cls === 'definitive') { await d.engine.dispatch(ws, taskId, 'failed', { reason: err.message }); return; }
    if (err.code === 'needs_reconciliation' || err.cls === 'permanent') { await d.engine.dispatch(ws, taskId, 'escalate', { reason: err.code }); return; }
    throw e;
  }
  if (!res.externalId) { await d.engine.dispatch(ws, taskId, 'escalate', { reason: 'no_post_id' }); return; }
  await d.db.tenant(ws, (tx) => markUsed(tx, approvalId));

  // "Live" only after the platform confirms the post exists with the approved caption.
  const rb = await d.gateway.call('publisher', 'social.readback', { workspaceId: ws }, () => d.social.readback({ account: ref, externalId: res.externalId, token }));
  if (!rb.live) throw new AppError('not_live_yet', 'transient');
  if (rb.caption !== null && rb.caption.trim() !== payload.caption.trim()) { await d.engine.dispatch(ws, taskId, 'escalate', { reason: 'readback_mismatch' }); return; }
  const url = rb.url ?? res.url;
  await d.db.tenant(ws, async (tx) => {
    await tx.q(`INSERT INTO posts(id, workspace_id, task_id, account_id, platform, external_id, url, caption, status, verified_at, created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'live',$9,$9) ON CONFLICT (task_id, account_id) DO NOTHING`,
      [newId('post'), ws, taskId, acct.id, platformLabel(acct), res.externalId, url, payload.caption, d.clock.now()]);
    await tx.q(`INSERT INTO audit(workspace_id, actor, event, detail) VALUES($1,'system','published',$2)`, [ws, { taskId, externalId: res.externalId, receipt: d.gateway.receipt('social.publish', { key }, res) }]);
    await d.engine.dispatchIn(tx, taskId, 'published', { externalId: res.externalId, url });
  });
}

async function metricsFor(d: Deps, ws: string, post: { id: string; external_id: string; account_id: string }): Promise<Record<string, number | null>> {
  const empty = { views: null, likes: null, comments: null };
  const acct = await d.db.tenant(ws, (tx) => tx.one<AccountRow>('SELECT * FROM accounts WHERE id=$1', [post.account_id]));
  if (!acct) return empty;
  let token: string;
  try { token = await d.db.tenant(ws, (tx) => d.credentials.token(tx, acct.id, d.clock.now())); } catch { return empty; }
  try {
    const m = await d.gateway.call('analyst', 'social.metrics', { workspaceId: ws }, () => d.social.metrics({ account: accountRef(acct), externalId: post.external_id, token }));
    await d.db.tenant(ws, (tx) => tx.q(`INSERT INTO metric_snapshots(id, workspace_id, post_id, metrics, source, captured_at) VALUES($1,$2,$3,$4,$5,$6)`, [newId('met'), ws, post.id, m, d.social.kind, d.clock.now()]));
    return m;
  } catch {
    return empty;
  }
}

async function report(d: Deps, ws: string, phone: string, jobId: string): Promise<void> {
  const posts = await d.db.tenant(ws, (tx) => tx.q<{ id: string; external_id: string; account_id: string; caption: string }>(`SELECT id, external_id, account_id, caption FROM posts WHERE status='live' ORDER BY created_at DESC LIMIT 3`));
  let body: string;
  if (!posts.length) body = copy.reportEmpty;
  else {
    const lines: string[] = [];
    for (const p of posts) lines.push(copy.reportLine(p.caption, await metricsFor(d, ws, p)));
    body = [copy.reportHeader, ...lines, copy.reportFooter].join('\n');
  }
  await d.db.tenant(ws, (tx) => d.messenger.queue(tx, { workspaceId: ws, to: phone, msg: { kind: 'text', body }, key: `report:${jobId}` }));
}

async function digest(d: Deps, ws: string): Promise<void> {
  const now = d.clock.now();
  const { thisWeek, prevWeek, live } = await d.db.tenant(ws, async (tx) => ({
    thisWeek: Number((await tx.one<{ n: string }>(`SELECT COUNT(*) n FROM posts WHERE created_at > $1`, [new Date(now.getTime() - 7 * DAY)]))?.n ?? 0),
    prevWeek: Number((await tx.one<{ n: string }>(`SELECT COUNT(*) n FROM posts WHERE created_at > $1 AND created_at <= $2`, [new Date(now.getTime() - 14 * DAY), new Date(now.getTime() - 7 * DAY)]))?.n ?? 0),
    live: await tx.q<{ id: string; external_id: string; account_id: string; caption: string }>(`SELECT id, external_id, account_id, caption FROM posts WHERE status='live' AND created_at > $1 ORDER BY created_at DESC LIMIT 5`, [new Date(now.getTime() - 7 * DAY)]),
  }));
  const lines: string[] = [];
  for (const p of live) lines.push(copy.reportLine(p.caption, await metricsFor(d, ws, p)));
  if (thisWeek < 3) lines.push(copy.thinData);
  await d.db.tenant(ws, async (tx) => {
    for (const o of await owners(tx, ws)) await d.messenger.queue(tx, { workspaceId: ws, to: o, msg: { kind: 'text', body: copy.digest({ posts: thisWeek, prev: prevWeek, lines }) }, key: `digest:${ws}:${now.toISOString().slice(0, 10)}:${o}` });
  });
}

