import type { Deps } from '../app/deps';
import type { Tx } from '../db/db';
import type { TaskRow, WorkspaceRow } from '../core/engine';
import type { OutMessage } from '../ports';
import { enqueue } from '../core/queue';
import { decide } from '../policy/approvals';
import { copy } from '../copy';
import { HOUR } from '../lib/clock';
import { CONSENT_EVENTS } from '../workflows/helpers';
import { renderCard } from '../workflows/post';
import { connectedAccountsInfo } from '../jobs/handlers';
import type { ChatTurn } from '../skills/skills';

const HISTORY_TURNS = 8;
import type { InMsg } from './ingress';

export interface Member { phone: string; workspace_id: string; role: string }

const ACTIVE_POST_STATES = ['received', 'waiting_reshoot', 'qc_passed', 'need_topic', 'drafting', 'need_caption', 'need_consent', 'blocked_consent', 'routing', 'awaiting_approval', 'awaiting_user_post', 'blocked_route'];

/** Exact commands handled by rules: no model call, no cost. */
const COMMANDS: Record<string, string> = {
  help: 'help', menu: 'help', madad: 'help',
  hi: 'greet', hii: 'greet', hello: 'greet', helo: 'greet', hey: 'greet', namaste: 'greet', namaskar: 'greet', 'good morning': 'greet',
  report: 'report', result: 'report', views: 'report',
  status: 'status',
  connect: 'connect', 'account jodo': 'connect',
  pause: 'pause', resume: 'resume',
  forget: 'forget', export: 'export', delete: 'delete', 'delete data': 'delete', 'delete my data': 'delete',
  start: 'start', 'new post': 'new_post', post: 'new_post', video: 'new_post',
  cancel: 'cancel', 'cancel delete': 'cancel_delete',
};

const looksLikeSecret = (t: string): boolean =>
  /\b(otp|password|passcode|cvv|pin)\b/i.test(t) && /\d{4,}/.test(t) || /\b(?:\d[ -]?){13,19}\b/.test(t);

export async function route(d: Deps, member: Member, m: InMsg): Promise<void> {
  try {
    await routeIn(d, member, m);
  } catch (e) {
    // A rolled-back decision still gets an honest reply, sent in its own transaction.
    const body = (e as { reply?: string }).reply;
    if (!body) throw e;
    await d.db.tenant(member.workspace_id, (tx) => d.messenger.queue(tx, { workspaceId: member.workspace_id, to: member.phone, msg: { kind: 'text', body }, key: `r:${m.wamid}:err` }));
  }
}

async function routeIn(d: Deps, member: Member, m: InMsg): Promise<void> {
  const ws = member.workspace_id;
  await d.db.tenant(ws, async (tx) => {
    const reply = (msg: OutMessage | string, suffix = '') =>
      d.messenger.queue(tx, { workspaceId: ws, to: member.phone, msg: typeof msg === 'string' ? { kind: 'text', body: msg } : msg, key: `r:${m.wamid}${suffix}` });
    const w = (await tx.one<WorkspaceRow>('SELECT * FROM workspaces WHERE id=$1', [ws]))!;
    const text = (m.text ?? '').trim();
    const cmd = COMMANDS[text.toLowerCase().replace(/\s+/g, ' ')];

    if (w.status !== 'active') {
      if (cmd === 'resume' && member.role === 'owner' && w.status === 'paused') return setStatus(d, tx, w, member, 'active', reply);
      if (cmd === 'cancel_delete' && member.role === 'owner') return cancelDelete(d, tx, member, reply);
      return d.messenger.queue(tx, { workspaceId: ws, to: member.phone, msg: { kind: 'text', body: copy.paused }, key: `paused:${member.phone}:${d.clock.now().toISOString().slice(0, 10)}` });
    }
    if (member.role === 'owner') await resendHeldCards(d, tx, w, member);
    if (m.type === 'button') return onButton(d, tx, member, m.buttonId!, reply);
    if (m.type === 'media') return onMedia(d, tx, member, m, reply);
    if (m.type === 'other') return reply(copy.notUnderstood);
    if (looksLikeSecret(text)) return reply(copy.secretWarning);

    // A Facebook/Instagram link: never scraped; the owner gets a one-tap official connect link instead.
    const pageLink = text.match(/https?:\/\/(?:www\.|m\.|web\.)?(?:facebook\.com|fb\.com|fb\.me|instagram\.com)\/\S*/i);
    if (pageLink) {
      if (member.role !== 'owner') return reply(copy.pageLinkNotOwner);
      const token = await d.links.create(tx, { workspaceId: ws, kind: 'reconnect', ref: 'connect', expiresAt: new Date(d.clock.now().getTime() + HOUR) });
      return reply(copy.pageLinkSeen(d.links.url('/connect/start', token)));
    }

    // Escape words always work, even while the bot is waiting for an answer.
    if (cmd === 'help') return reply(copy.help);
    if (cmd === 'cancel') return cancelAwaited(d, tx, member, reply);
    if (cmd === 'cancel_delete') return cancelDelete(d, tx, member, reply);

    const conv = await tx.one<{ state: string; context: { taskId?: string; event?: string } }>('SELECT state, context FROM conversations WHERE phone=$1', [member.phone]);
    // While an answer is expected, typed text is that answer (e.g. "DELETE" confirms deletion), except escape words above.
    if (conv?.state === 'awaiting' && conv.context.taskId && conv.context.event && cmd !== 'status' && cmd !== 'start') {
      const ev = conv.context.event;
      const payload = ev === 'caption' ? { caption: text, by: member.phone } : { text, by: member.phone };
      if (!text) return reply(ev === 'caption' ? copy.askCaption : copy.notUnderstood);
      const r = await d.engine.dispatchIn(tx, conv.context.taskId, ev, payload);
      if (r.ok) return;
      await tx.q(`UPDATE conversations SET state='idle', context='{}' WHERE phone=$1`, [member.phone]);
    }

    if (!w.onboarded && member.role === 'owner' && (!cmd || cmd === 'greet')) return startOnboarding(d, tx, w, member, reply);
    if (cmd) return command(d, tx, w, member, cmd, reply);

    const history = (await tx.one<{ history: ChatTurn[] }>('SELECT history FROM conversations WHERE phone=$1', [member.phone]))?.history ?? [];
    const profile = (await tx.one<{ answers: Record<string, unknown> }>('SELECT answers FROM profiles WHERE workspace_id=$1', [ws]))?.answers ?? {};
    const r = await d.skills.intent(ws, text, w.kind, history, profile, await connectedAccountsInfo(d, ws));
    if (!r.ok) return reply(r.reason === 'denied' ? copy.aiLimited : copy.notUnderstood);
    if (r.value.contains_secret) return reply(copy.secretWarning);
    const map: Record<string, string> = { new_post: 'new_post', report: 'report', status: 'status', help: 'help', connect: 'connect' };
    const c = map[r.value.intent];
    const said = r.value.reply ?? (c ? null : r.value.needs_clarification);
    // Keep a short rolling history so the next turn has context; message text stays out of logs and inbound rows.
    if (said) await tx.q('UPDATE conversations SET history=$2 WHERE phone=$1', [member.phone, JSON.stringify([...history, { role: 'user', text: text.slice(0, 500) }, { role: 'assistant', text: said.slice(0, 500) }].slice(-HISTORY_TURNS))]); // pg sends JS arrays as SQL arrays, so stringify
    if (c) {
      if (said) await reply(said, ':chat');
      return command(d, tx, w, member, c, reply);
    }
    if (said) return reply(said);
    return reply(d.llm.kind === 'fake' ? copy.demoMode : copy.notUnderstood);
  });
}

/**
 * An approval card sent while the owner's 24h window was closed is blocked, not lost:
 * the next time the owner writes, every pending card that never went out is sent again.
 */
async function resendHeldCards(d: Deps, tx: Tx, w: WorkspaceRow, member: Member): Promise<void> {
  const held = await tx.q<{ id: string; task_id: string; summary: string }>(
    `SELECT a.id, a.task_id, a.summary FROM approvals a WHERE a.status='pending' AND a.requested_from=$1 AND a.expires_at > $2
       AND NOT EXISTS (SELECT 1 FROM outbound_messages o WHERE o.dedupe_key IN ('card:' || a.id, 'card:' || a.id || ':held'))`,
    [member.phone, d.clock.now()]);
  for (const a of held) {
    const t = await tx.one<TaskRow>('SELECT * FROM tasks WHERE id=$1', [a.task_id]);
    if (!t || t.state !== 'awaiting_approval') continue;
    await d.messenger.queue(tx, { workspaceId: w.id, to: member.phone, msg: await renderCard(tx, w, t.data, a.id, a.summary), key: `card:${a.id}:held` });
  }
}

type Reply = (msg: OutMessage | string, suffix?: string) => Promise<void>;

async function command(d: Deps, tx: Tx, w: WorkspaceRow, member: Member, cmd: string, reply: Reply): Promise<void> {
  const owner = member.role === 'owner';
  if (member.role === 'viewer' && !['report', 'status', 'help'].includes(cmd)) return reply(copy.viewerOnly);
  switch (cmd) {
    case 'help': return reply(copy.help);
    case 'greet': return reply(copy.greet);
    case 'new_post': return reply(copy.newPost);
    case 'report':
      return enqueue(tx, d.clock, 'report', { phone: member.phone }, { workspaceId: w.id });
    case 'status': {
      const s = await tx.one<{ accounts: string; pending: string; posts7d: string }>(`SELECT
        (SELECT COUNT(*) FROM accounts WHERE status='connected') accounts,
        (SELECT COUNT(*) FROM tasks WHERE workflow='post' AND state = ANY($1)) pending,
        (SELECT COUNT(*) FROM posts WHERE created_at > $2) posts7d`, [ACTIVE_POST_STATES, new Date(d.clock.now().getTime() - 7 * 24 * HOUR)]);
      return reply(copy.status({ active: w.status === 'active', accounts: Number(s?.accounts), pending: Number(s?.pending), posts7d: Number(s?.posts7d) }));
    }
    case 'connect': {
      if (!owner) return reply(copy.ownerOnly);
      const token = await d.links.create(tx, { workspaceId: w.id, kind: 'reconnect', ref: 'connect', expiresAt: new Date(d.clock.now().getTime() + HOUR) });
      return reply(copy.connectLink(d.links.url('/connect/start', token)));
    }
    case 'pause': return owner ? setStatus(d, tx, w, member, 'paused', reply) : reply(copy.ownerOnly);
    case 'resume': return owner ? reply(copy.resumedOk) : reply(copy.ownerOnly);
    case 'start': return owner ? startOnboarding(d, tx, w, member, reply) : reply(copy.ownerOnly);
    case 'forget': return owner ? reply({ kind: 'buttons', body: copy.forgetAsk, buttons: copy.forgetButtons }) : reply(copy.ownerOnly);
    case 'export':
      if (!owner) return reply(copy.ownerOnly);
      await enqueue(tx, d.clock, 'export', { phone: member.phone }, { workspaceId: w.id, dedupeKey: `export:${w.id}:${d.clock.now().toISOString().slice(0, 13)}` });
      return;
    case 'delete': {
      if (!owner) return reply(copy.ownerOnly);
      const open = await tx.one(`SELECT id FROM tasks WHERE workflow='delete_data' AND state IN ('requested','cooling')`);
      if (open) return reply(copy.alreadyHandled);
      await d.engine.start(tx, w.id, 'delete_data', {}, member.phone);
      return;
    }
    default: return reply(copy.notUnderstood);
  }
}

async function setStatus(d: Deps, tx: Tx, w: WorkspaceRow, member: Member, status: 'active' | 'paused', reply: Reply): Promise<void> {
  await tx.q('UPDATE workspaces SET status=$2 WHERE id=$1', [w.id, status]);
  await tx.q(`INSERT INTO audit(workspace_id, actor, event, detail) VALUES($1,$2,$3,'{}')`, [w.id, member.phone, status === 'paused' ? 'workspace_paused' : 'workspace_resumed']);
  if (status === 'active') {
    // Posts held only because the workspace was paused get re-routed now.
    const held = await tx.q<{ id: string }>(`SELECT id FROM tasks WHERE workflow='post' AND state='blocked_route' AND data->>'blockReason' = $1`, [copy.paused]);
    for (const t of held) await d.engine.dispatchIn(tx, t.id, 'retry', {});
  }
  return reply(status === 'paused' ? copy.pausedOk : copy.resumedOk);
}

async function startOnboarding(d: Deps, tx: Tx, w: WorkspaceRow, member: Member, reply: Reply): Promise<void> {
  const open = await tx.one<{ id: string }>(`SELECT id FROM tasks WHERE workflow='onboarding' AND state IN ('asking','thinking') ORDER BY created_at DESC LIMIT 1`);
  if (open) {
    await tx.q(`UPDATE conversations SET state='awaiting', context=$2 WHERE phone=$1`, [member.phone, { taskId: open.id, event: 'answer' }]);
    return reply('Chaliye wahin se jaari rakhte hain. Pichhla sawaal dobara dekhein aur jawab bhejein.');
  }
  await d.engine.start(tx, w.id, 'onboarding', { answers: {}, step: 0, history: [] }, member.phone);
}

async function onMedia(d: Deps, tx: Tx, member: Member, m: InMsg, reply: Reply): Promise<void> {
  if (member.role === 'viewer') return reply(copy.noUpload);
  await tx.q(`UPDATE conversations SET state='idle', context='{}' WHERE phone=$1`, [member.phone]);
  await d.engine.start(tx, member.workspace_id, 'post', { mediaId: m.mediaId, mime: m.mime ?? '', topic: m.caption?.trim() || null }, member.phone);
}

async function cancelAwaited(d: Deps, tx: Tx, member: Member, reply: Reply): Promise<void> {
  const conv = await tx.one<{ state: string; context: { taskId?: string } }>('SELECT state, context FROM conversations WHERE phone=$1', [member.phone]);
  const taskId = conv?.state === 'awaiting' ? conv.context.taskId : undefined;
  const t = taskId ? await tx.one<{ id: string }>('SELECT id FROM tasks WHERE id=$1', [taskId])
    : await tx.one<{ id: string }>(`SELECT id FROM tasks WHERE workflow='post' AND requested_by=$1 AND state = ANY($2) ORDER BY updated_at DESC LIMIT 1`, [member.phone, ACTIVE_POST_STATES]);
  if (!t) return reply(copy.nothingToCancel);
  const r = await d.engine.dispatchIn(tx, t.id, 'cancel', { by: member.phone });
  if (!r.ok) return reply(copy.alreadyHandled);
}

async function cancelDelete(d: Deps, tx: Tx, member: Member, reply: Reply): Promise<void> {
  if (member.role !== 'owner') return reply(copy.ownerOnly);
  const t = await tx.one<{ id: string }>(`SELECT id FROM tasks WHERE workflow='delete_data' AND state IN ('requested','cooling')`);
  if (!t) return reply(copy.nothingToCancel);
  await d.engine.dispatchIn(tx, t.id, 'cancel', { by: member.phone });
}

async function onButton(d: Deps, tx: Tx, member: Member, id: string, reply: Reply): Promise<void> {
  const [tag, ref, act] = id.split(':');
  if (tag === 'a' && ref && act) {
    const decision = act === 'y' ? 'approved' : act === 'n' ? 'declined' : act === 'e' ? 'superseded' : null;
    if (!decision) return reply(copy.notUnderstood);
    const r = await decide(tx, { approvalId: ref, phone: member.phone, role: member.role, decision, now: d.clock.now() });
    if (!r.ok) {
      if (r.reason === 'expired') {
        const a = await tx.one<{ task_id: string }>('SELECT task_id FROM approvals WHERE id=$1', [ref]);
        if (a) await d.engine.dispatchIn(tx, a.task_id, 'expire', { by: member.phone });
        return;
      }
      return reply(r.reason === 'not_found' ? copy.notYourWorkspace : r.reason === 'not_owner' ? copy.approvalOwnerOnly : copy.alreadyHandled);
    }
    const ev = decision === 'approved' ? 'approve' : decision === 'declined' ? 'reject' : 'edit';
    const res = await d.engine.dispatchIn(tx, r.approval.task_id, ev, { by: member.phone });
    if (!res.ok) throw Object.assign(new Error('stale_approval'), { reply: copy.alreadyHandled });
    return;
  }
  if (tag === 'c' && ref && act) {
    if (member.role === 'viewer') return reply(copy.viewerOnly);
    const answer = ({ n: 'none', y: 'others_ok', m: 'minors_or_unsure' } as Record<string, string>)[act];
    const t = await tx.one<TaskRow>('SELECT * FROM tasks WHERE id=$1', [ref]);
    if (!t || !answer || !(CONSENT_EVENTS as readonly string[]).includes(answer)) return reply(copy.notYourWorkspace);
    if (t.state === 'need_consent') { await d.engine.dispatchIn(tx, t.id, answer, { by: member.phone }); return; }
    if (t.state === 'awaiting_approval' || t.state === 'blocked_consent') {
      if (t.data.consent === answer) return reply(copy.consentAlready);
      await d.engine.dispatchIn(tx, t.id, 'consent_update', { answer, by: member.phone });
      return;
    }
    return reply(copy.alreadyHandled);
  }
  if (tag === 'u' && ref && act) {
    if (member.role === 'viewer') return reply(copy.viewerOnly);
    const t = await tx.one<TaskRow>('SELECT * FROM tasks WHERE id=$1', [ref]);
    if (!t) return reply(copy.notYourWorkspace);
    const r = await d.engine.dispatchIn(tx, t.id, act === 'd' ? 'confirmed' : 'cancel', { by: member.phone });
    if (!r.ok) return reply(copy.alreadyHandled);
    return;
  }
  if (tag === 'f') {
    if (member.role !== 'owner') return reply(copy.ownerOnly);
    if (ref !== 'y') return reply('Theek hai, kuch nahi hataya.');
    await tx.q(`UPDATE memory_items SET body='', deleted_at=$1 WHERE deleted_at IS NULL`, [d.clock.now()]);
    await tx.q(`UPDATE profiles SET answers='{}', step=0, completed_at=NULL`);
    await tx.q(`UPDATE conversations SET history='[]' WHERE workspace_id=$1`, [member.workspace_id]);
    await tx.q(`UPDATE workspaces SET onboarded=false WHERE id=$1`, [member.workspace_id]);
    await tx.q(`INSERT INTO audit(workspace_id, actor, event, detail) VALUES($1,$2,'memory_forgotten','{}')`, [member.workspace_id, member.phone]);
    return reply(copy.forgotten);
  }
  return reply(copy.notUnderstood);
}
