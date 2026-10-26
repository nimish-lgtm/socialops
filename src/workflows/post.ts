import type { Workflow, Ctx } from '../core/engine';
import { copy } from '../copy';
import { capabilityFor } from '../accounts/matrix';
import { createApproval, supersedePending } from '../policy/approvals';
import { detectClaims, bannedHits } from '../skills/skills';
import { newId } from '../lib/ids';
import { HOUR } from '../lib/clock';
import { accountRef, awaitAnswer, clearAwait, CONSENT_EVENTS, fullCaption, owners, platformLabel, publishPayload, type AccountRow } from './helpers';

const notifyOwners = async (ctx: Ctx, key: string, body: string, alsoRequester = true) => {
  const to = new Set(await owners(ctx.tx, ctx.ws.id));
  if (alsoRequester && ctx.task.requested_by) to.add(ctx.task.requested_by);
  for (const p of to) await ctx.send(p, { kind: 'text', body }, `${key}:${p}`);
};
const toRequester = (ctx: Ctx, key: string, body: string) =>
  ctx.task.requested_by ? ctx.send(ctx.task.requested_by, { kind: 'text', body }, key) : Promise.resolve();

/**
 * Media -> QC -> topic -> caption -> consent -> route -> approval -> publish -> readback.
 * Every external write sits behind the approval guard; publish re-checks all gates at execution time.
 */
export const postWorkflow: Workflow = {
  name: 'post',
  initial: 'received',
  states: {
    received: {
      on: { qc_ok: 'qc_passed', qc_fail: 'waiting_reshoot', cancel: 'cancelled' },
      async enter(ctx) {
        await ctx.enqueue('ingest_media', { taskId: ctx.task.id }, { dedupeKey: `ingest:${ctx.task.id}`, maxAttempts: 4 });
        await toRequester(ctx, `recv:${ctx.task.id}`, copy.mediaReceived);
      },
    },
    waiting_reshoot: {
      on: { cancel: 'cancelled', expire: 'cancelled' },
      async enter(ctx) {
        await toRequester(ctx, `reshoot:${ctx.task.id}`, copy.reshoot(ctx.payload.problems ?? []));
      },
    },
    qc_passed: {
      on: { has_topic: 'drafting', no_topic: 'need_topic' },
      async enter(ctx) {
        ctx.set({ assetId: ctx.payload.assetId, assetSha: ctx.payload.sha256, mime: ctx.payload.mime });
        ctx.emit(ctx.task.data.topic ? 'has_topic' : 'no_topic');
      },
    },
    need_topic: {
      on: { topic: 'drafting', cancel: 'cancelled' },
      async enter(ctx) {
        if (ctx.task.requested_by) await awaitAnswer(ctx.tx, ctx.task.requested_by, ctx.task.id, 'topic');
        await toRequester(ctx, `topic:${ctx.task.id}`, copy.askTopic);
      },
    },
    drafting: {
      on: { drafted: 'need_consent', ai_unavailable: 'need_caption', draft_failed: 'need_caption', cancel: 'cancelled' },
      async enter(ctx) {
        if (ctx.payload.text) ctx.set({ topic: String(ctx.payload.text).slice(0, 500) });
        await clearAwait(ctx.tx, ctx.task.id);
        await ctx.enqueue('draft_caption', { taskId: ctx.task.id }, { dedupeKey: `draft:${ctx.task.id}`, maxAttempts: 3 });
      },
    },
    need_caption: {
      on: { caption: 'need_consent', cancel: 'cancelled' },
      async enter(ctx) {
        const n = (ctx.task.data.captionAsks ?? 0) + 1;
        ctx.set({ captionAsks: n });
        const body = ctx.event === 'ai_unavailable' || ctx.event === 'draft_failed' ? copy.aiCaptionUnavailable : copy.askCaption;
        const to = ctx.event === 'edit' && ctx.payload.by ? ctx.payload.by : ctx.task.requested_by;
        if (!to) return;
        await awaitAnswer(ctx.tx, to, ctx.task.id, 'caption');
        await ctx.send(to, { kind: 'text', body }, `capask:${ctx.task.id}:${n}`);
      },
    },
    need_consent: {
      on: { none: 'routing', others_ok: 'routing', minors_or_unsure: 'blocked_consent', cancel: 'cancelled' },
      async enter(ctx) {
        await supersedePending(ctx.tx, ctx.task.id);
        await clearAwait(ctx.tx, ctx.task.id);
        if (ctx.payload.caption !== undefined) {
          const caption = String(ctx.payload.caption).trim().slice(0, 2000);
          ctx.set({ caption, hashtags: Array.isArray(ctx.payload.hashtags) ? ctx.payload.hashtags.slice(0, 8) : [] });
        }
        const answer = ctx.payload.answer ?? (ctx.event === 'consent_update' ? null : ctx.task.data.consent);
        if (answer && (CONSENT_EVENTS as readonly string[]).includes(answer)) {
          ctx.emit(answer, { by: ctx.payload.by ?? ctx.task.data.consentBy ?? null });
          return;
        }
        if (ctx.task.requested_by) {
          const v = (ctx.task.data.consentAsks ?? 0) + 1;
          ctx.set({ consentAsks: v });
          await ctx.send(ctx.task.requested_by, { kind: 'buttons', body: copy.consentQuestion, buttons: copy.consentButtons(ctx.task.id) }, `consentq:${ctx.task.id}:${v}`);
        }
      },
      async exit(ctx) {
        if (!(CONSENT_EVENTS as readonly string[]).includes(ctx.event)) return;
        const by = ctx.payload.by ?? null;
        ctx.set({ consent: ctx.event, consentBy: by });
        if (by) await ctx.tx.q(`INSERT INTO consents(id, workspace_id, task_id, answer, by_phone, at) VALUES($1,$2,$3,$4,$5,$6)`, [newId('cons'), ctx.ws.id, ctx.task.id, ctx.event, by, ctx.now]);
      },
    },
    blocked_consent: {
      on: { consent_update: 'need_consent', cancel: 'cancelled' },
      async enter(ctx) {
        await notifyOwners(ctx, `consentblock:${ctx.task.id}:${ctx.task.version}`, copy.consentBlocked);
      },
    },
    routing: {
      on: { api: 'awaiting_approval', assisted: 'awaiting_user_post', unsupported: 'blocked_route' },
      async enter(ctx) {
        const accts = await ctx.tx.q<AccountRow>(`SELECT * FROM accounts WHERE workspace_id=$1 ORDER BY created_at`, [ctx.ws.id]);
        const acct = accts.find((a) => a.id === ctx.task.data.accountId) ?? accts.find((a) => a.status === 'connected') ?? accts[0];
        if (!acct) return ctx.emit('unsupported', { reason: copy.noAccount });
        const cap = capabilityFor(acct.platform, acct.surface, acct.account_type);
        ctx.set({ accountId: acct.id, platform: platformLabel(acct) });
        if (acct.status !== 'connected') return ctx.emit('unsupported', { reason: copy.notConnected });
        if (cap.route === 'E' && ctx.deps.social.canPublish(accountRef(acct))) { ctx.set({ route: 'E' }); return ctx.emit('api'); }
        if (cap.route === 'E') return ctx.emit('unsupported', { reason: copy.notConnected });
        if (cap.route === 'A') { ctx.set({ route: 'A' }); return ctx.emit('assisted'); }
        ctx.emit('unsupported', { reason: copy.unsupported });
      },
    },
    awaiting_approval: {
      guard: 'approval',
      on: { approve: 'publishing', edit: 'need_caption', reject: 'cancelled', expire: 'cancelled', consent_update: 'need_consent', cancel: 'cancelled' },
      async enter(ctx) {
        const d = ctx.task.data;
        const payload = publishPayload(d);
        const to = (await owners(ctx.tx, ctx.ws.id))[0] ?? null;
        const approvalId = await createApproval(ctx.tx, {
          workspaceId: ctx.ws.id, taskId: ctx.task.id, kind: 'publish', summary: payload.caption, payload,
          requestedFrom: to, expiresAt: new Date(ctx.now.getTime() + ctx.deps.config.approvalTtlHours * HOUR),
        });
        ctx.set({ approvalId });
        const banned = (await ctx.tx.one<{ answers: { banned?: string } }>('SELECT answers FROM profiles WHERE workspace_id=$1', [ctx.ws.id]))?.answers?.banned ?? '';
        const hits = bannedHits(payload.caption, banned.split(/[,\n]/));
        const flags = [...detectClaims(payload.caption), ...hits.map((h) => `MANA HAI: ${h}`)];
        if (to) await ctx.send(to, { kind: 'buttons', body: copy.approvalCard(payload.caption, d.platform ?? '', flags, ctx.ws.kind !== 'business'), buttons: copy.approvalButtons(approvalId) }, `card:${approvalId}`);
      },
      async exit(ctx, next) {
        if (next !== 'publishing') await supersedePending(ctx.tx, ctx.task.id);
      },
    },
    publishing: {
      externalWrite: true,
      guard: 'approval',
      on: { published: 'done', failed: 'failed', escalate: 'needs_human', blocked: 'blocked_route' },
      async enter(ctx) {
        await ctx.enqueue('publish', { taskId: ctx.task.id, approvalId: ctx.task.data.approvalId }, { dedupeKey: `publish:${ctx.task.data.approvalId}`, maxAttempts: 8 });
        if (ctx.payload.by) await ctx.send(ctx.payload.by, { kind: 'text', body: copy.approved }, `approved:${ctx.task.data.approvalId}`);
      },
    },
    awaiting_user_post: {
      on: { confirmed: 'done', cancel: 'cancelled', expire: 'cancelled' },
      async enter(ctx) {
        const to = ctx.task.requested_by;
        if (to) await ctx.send(to, { kind: 'buttons', body: copy.assisted(ctx.task.data.platform ?? '', fullCaption(ctx.task.data)), buttons: copy.assistedButtons(ctx.task.id) }, `assisted:${ctx.task.id}:${ctx.task.version}`);
      },
    },
    blocked_route: {
      on: { retry: 'routing', cancel: 'cancelled' },
      async enter(ctx) {
        ctx.set({ blockReason: ctx.payload.reason ?? null });
        await toRequester(ctx, `blocked:${ctx.task.id}:${ctx.task.version}`, copy.blockedRoute(ctx.payload.reason ?? copy.notConnected));
      },
    },
    needs_human: {
      on: { resolved_live: 'done', retry: 'awaiting_approval', cancel: 'cancelled' },
      async enter(ctx) {
        ctx.set({ escalation: ctx.payload.reason ?? 'unknown' });
        await ctx.audit('escalated', { reason: ctx.payload.reason ?? null });
        await notifyOwners(ctx, `stuck:${ctx.task.id}:${ctx.task.version}`, copy.stuck, false);
      },
    },
    failed: {
      terminal: true,
      async enter(ctx) {
        ctx.set({ failReason: ctx.payload.reason ?? null });
        await notifyOwners(ctx, `failed:${ctx.task.id}`, copy.publishFailed(ctx.payload.reason ?? 'unknown'));
      },
    },
    done: {
      terminal: true,
      async enter(ctx) {
        if (ctx.event === 'confirmed') {
          await ctx.tx.q(`INSERT INTO posts(id, workspace_id, task_id, account_id, platform, caption, status) VALUES($1,$2,$3,$4,$5,$6,'user_confirmed') ON CONFLICT DO NOTHING`,
            [newId('post'), ctx.ws.id, ctx.task.id, ctx.task.data.accountId ?? null, ctx.task.data.platform ?? 'unknown', fullCaption(ctx.task.data)]);
          if (ctx.payload.by) await ctx.send(ctx.payload.by, { kind: 'text', body: copy.assistedDone }, `assisted_done:${ctx.task.id}`);
          return;
        }
        ctx.set({ externalId: ctx.payload.externalId ?? null, url: ctx.payload.url ?? null });
        await notifyOwners(ctx, `live:${ctx.task.id}`, copy.live(ctx.payload.url ?? null));
      },
    },
    cancelled: {
      terminal: true,
      async enter(ctx) {
        await clearAwait(ctx.tx, ctx.task.id);
        const body = ctx.event === 'reject' ? copy.rejected : ctx.event === 'expire' ? copy.expired : copy.cancelled;
        const to = ctx.payload.by ?? ctx.task.requested_by;
        if (to) await ctx.send(to, { kind: 'text', body }, `cancel:${ctx.task.id}`);
      },
    },
  },
};
