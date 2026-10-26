import type { Deps } from '../app/deps';
import { hashPhone } from '../lib/ids';
import { copy } from '../copy';
import { route } from './router';

export interface InMsg {
  wamid: string;
  from: string;
  pnid: string | null;
  type: 'text' | 'button' | 'media' | 'other';
  text?: string;
  buttonId?: string;
  mediaId?: string;
  mime?: string;
  caption?: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Normalize a Cloud API webhook body. Unknown shapes are skipped; this never throws on hostile input. */
export function parseWebhook(body: unknown): { messages: InMsg[]; statuses: Array<{ id: string; status: string }> } {
  const messages: InMsg[] = [];
  const statuses: Array<{ id: string; status: string }> = [];
  const entries = (body as { entry?: unknown })?.entry;
  if (!Array.isArray(entries)) return { messages, statuses };
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const ch of changes) {
      const v = (ch as { value?: Record<string, unknown> })?.value ?? {};
      const pnid = str((v.metadata as Record<string, unknown> | undefined)?.phone_number_id) ?? null;
      for (const m of Array.isArray(v.messages) ? v.messages : []) {
        const id = str(m?.id), from = str(m?.from), type = str(m?.type);
        if (!id || !from || !/^\d{6,16}$/.test(from)) continue;
        const base = { wamid: id.slice(0, 200), from, pnid };
        if (type === 'text') messages.push({ ...base, type: 'text', text: str(m.text?.body)?.slice(0, 4096) ?? '' });
        else if (type === 'interactive' || type === 'button') {
          const r = m.interactive?.button_reply ?? m.interactive?.list_reply;
          const bid = str(r?.id) ?? str(m.button?.payload);
          if (bid) messages.push({ ...base, type: 'button', buttonId: bid.slice(0, 256) });
        } else if (type && ['image', 'video', 'audio', 'document'].includes(type)) {
          const media = m[type] ?? {};
          if (str(media.id)) messages.push({ ...base, type: 'media', mediaId: str(media.id), mime: str(media.mime_type) ?? '', caption: str(media.caption)?.slice(0, 1000) });
        } else messages.push({ ...base, type: 'other' });
      }
      for (const s of Array.isArray(v.statuses) ? v.statuses : []) if (str(s?.id) && str(s?.status)) statuses.push({ id: s.id, status: s.status });
    }
  }
  return { messages, statuses };
}

export async function handleWebhook(d: Deps, body: unknown): Promise<void> {
  const { messages, statuses } = parseWebhook(body);
  for (const s of statuses) await d.messenger.onStatus(s);
  for (const m of messages) {
    if (m.pnid !== d.config.wa.phoneNumberId) { d.log.warn('foreign_phone_number_id'); continue; }
    try { await receive(d, m); } catch (e) { d.log.error('inbound_error', { wamid: m.wamid, error: (e as Error).message }); }
  }
}

const RATE_LIMIT_PER_MIN = 30;

/** Dedupe, open the 24h window, resolve sender, rate limit, then hand to the router. */
export async function receive(d: Deps, m: InMsg): Promise<void> {
  const now = d.clock.now();
  const fromHash = hashPhone(m.from);
  const pre = await d.db.system(async (tx) => {
    const ins = await tx.q(`INSERT INTO inbound_events(wamid, from_hash, kind, received_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING 1`, [m.wamid, fromHash, m.type, now]);
    if (!ins.length) return { dup: true as const };
    await tx.q(`INSERT INTO conversations(phone, last_inbound_at) VALUES($1,$2) ON CONFLICT (phone) DO UPDATE SET last_inbound_at=excluded.last_inbound_at`, [m.from, now]);
    const member = await tx.one<{ phone: string; workspace_id: string; role: string }>('SELECT phone, workspace_id, role FROM members WHERE phone=$1', [m.from]);
    if (!member) {
      await d.messenger.queue(tx, { workspaceId: null, to: m.from, msg: { kind: 'text', body: copy.unknownSender }, key: `unknown:${fromHash}:${now.toISOString().slice(0, 10)}` });
      await tx.q(`INSERT INTO audit(workspace_id, actor, event, detail) VALUES(NULL,$1,'unknown_sender','{}')`, [fromHash]);
      return { unknown: true as const };
    }
    await tx.q('UPDATE inbound_events SET workspace_id=$2 WHERE wamid=$1', [m.wamid, member.workspace_id]);
    await tx.q('UPDATE conversations SET workspace_id=$2 WHERE phone=$1', [m.from, member.workspace_id]);
    const recent = await tx.one<{ n: string }>(`SELECT COUNT(*) n FROM inbound_events WHERE from_hash=$1 AND received_at > $2`, [fromHash, new Date(now.getTime() - 60_000)]);
    if (Number(recent?.n ?? 0) > RATE_LIMIT_PER_MIN) {
      await tx.q(`INSERT INTO audit(workspace_id, actor, event, detail) VALUES($1,$2,'rate_limited','{}')`, [member.workspace_id, fromHash]);
      return { limited: true as const };
    }
    return { member };
  });
  if (!('member' in pre) || !pre.member) return;
  await route(d, pre.member, m);
}
