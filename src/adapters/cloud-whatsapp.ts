import { AppError } from '../lib/errors';
import type { OutMessage, WhatsAppPort } from '../ports';

/**
 * WhatsApp Cloud API client. Request shapes follow Meta's public docs as read for docs/FACTS.md;
 * verify against developers.facebook.com before relying on it (live check L2-L4).
 */
export class CloudWhatsApp implements WhatsAppPort {
  readonly kind = 'live' as const;
  constructor(private cfg: { version: string; phoneNumberId: string; token: string }, private f: typeof fetch) {}

  private get base(): string { return `https://graph.facebook.com/${this.cfg.version}`; }

  async send(to: string, msg: OutMessage): Promise<{ waId: string }> {
    const body =
      msg.kind === 'text' ? { type: 'text', text: { body: msg.body.slice(0, 4096) } }
      : msg.kind === 'buttons' ? { type: 'interactive', interactive: { type: 'button', body: { text: msg.body.slice(0, 1024) }, action: { buttons: msg.buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id.slice(0, 256), title: b.title.slice(0, 20) } })) } } }
      : { type: 'template', template: { name: msg.name, language: { code: msg.lang }, components: [{ type: 'body', parameters: msg.vars.map((v) => ({ type: 'text', text: v })) }] } };
    let r: Response;
    try {
      r = await this.f(`${this.base}/${this.cfg.phoneNumberId}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${this.cfg.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', to, ...body }) });
    } catch (e) {
      throw new AppError('wa_network', isConnectError(e) ? 'not_sent' : 'ambiguous', (e as Error).message);
    }
    const j = (await r.json().catch(() => ({}))) as { messages?: Array<{ id: string }>; error?: { message?: string } };
    if (!r.ok) throw new AppError(`wa_send_${r.status}`, r.status >= 400 && r.status < 500 && r.status !== 429 ? 'definitive' : 'ambiguous', j.error?.message);
    const id = j.messages?.[0]?.id;
    if (!id) throw new AppError('wa_no_message_id', 'ambiguous');
    return { waId: id };
  }

  async downloadMedia(mediaId: string): Promise<{ data: Buffer; mime: string }> {
    const auth = { Authorization: `Bearer ${this.cfg.token}` };
    const metaRes = await this.f(`${this.base}/${mediaId}`, { headers: auth });
    if (!metaRes.ok) throw new AppError(`wa_media_meta_${metaRes.status}`, metaRes.status < 500 ? 'definitive' : 'transient');
    const meta = (await metaRes.json()) as { url?: string; mime_type?: string };
    if (!meta.url) throw new AppError('wa_media_no_url', 'definitive');
    const bin = await this.f(meta.url, { headers: auth });
    if (!bin.ok) throw new AppError(`wa_media_${bin.status}`, bin.status < 500 ? 'definitive' : 'transient');
    return { data: Buffer.from(await bin.arrayBuffer()), mime: meta.mime_type ?? 'application/octet-stream' };
  }
}

export function isConnectError(e: unknown): boolean {
  const code = (e as { cause?: { code?: string } })?.cause?.code;
  return code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN';
}
