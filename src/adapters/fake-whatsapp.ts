import { newId } from '../lib/ids';
import { AppError } from '../lib/errors';
import type { OutMessage, WhatsAppPort } from '../ports';

export type WaFault = 'none' | 'timeout' | 'reject' | 'not_sent';

/** In-memory WhatsApp: records every message, serves uploaded media, injects faults on demand. */
export class FakeWhatsApp implements WhatsAppPort {
  readonly kind = 'fake' as const;
  sent: Array<{ to: string; msg: OutMessage; waId: string; at: number }> = [];
  media = new Map<string, { data: Buffer; mime: string }>();
  fault: WaFault = 'none';
  attempts = 0;

  async send(to: string, msg: OutMessage): Promise<{ waId: string }> {
    this.attempts++;
    const f = this.fault;
    if (f === 'reject') throw new AppError('wa_send_400', 'definitive');
    if (f === 'not_sent') throw new AppError('wa_connect_refused', 'not_sent');
    const waId = newId('wamid');
    this.sent.push({ to, msg, waId, at: Date.now() });
    if (f === 'timeout') throw new AppError('timeout', 'ambiguous');
    return { waId };
  }

  async downloadMedia(mediaId: string): Promise<{ data: Buffer; mime: string }> {
    const m = this.media.get(mediaId);
    if (!m) throw new AppError('media_not_found', 'definitive');
    return m;
  }

  addMedia(data: Buffer, mime: string): string {
    const id = newId('media');
    this.media.set(id, { data, mime });
    return id;
  }

  to(phone: string): OutMessage[] { return this.sent.filter((s) => s.to === phone).map((s) => s.msg); }
  last(phone?: string): OutMessage | undefined { return (phone ? this.sent.filter((s) => s.to === phone) : this.sent).at(-1)?.msg; }
}

export const bodyOf = (m: OutMessage | undefined): string => (!m ? '' : m.kind === 'template' ? `[template ${m.name}]` : m.body);
