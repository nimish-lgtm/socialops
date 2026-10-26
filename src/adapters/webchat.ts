import type { Db } from '../db/db';
import { AppError } from '../lib/errors';
import { newId } from '../lib/ids';
import type { OutMessage, StoragePort, WhatsAppPort } from '../ports';

/**
 * The browser chat channel: same port as WhatsApp, so routing, approvals and the outbox are identical.
 * Messages are stored per session phone id; media uploads go to workspace-independent storage until claimed.
 */
export class WebChat implements WhatsAppPort {
  readonly kind = 'web' as const;
  constructor(private db: Db, private storage: StoragePort) {}

  async send(to: string, msg: OutMessage): Promise<{ waId: string }> {
    const id = newId('webmsg');
    await this.db.system(async (tx) => {
      const m = await tx.one<{ workspace_id: string }>('SELECT workspace_id FROM members WHERE phone=$1', [to]);
      await tx.q(`INSERT INTO webchat_messages(phone, workspace_id, dir, body) VALUES($1,$2,'out',$3)`, [to, m?.workspace_id ?? null, { id, ...msg }]);
    });
    return { waId: id };
  }

  async recordInbound(phone: string, body: Record<string, unknown>): Promise<void> {
    await this.db.system(async (tx) => {
      const m = await tx.one<{ workspace_id: string }>('SELECT workspace_id FROM members WHERE phone=$1', [phone]);
      await tx.q(`INSERT INTO webchat_messages(phone, workspace_id, dir, body) VALUES($1,$2,'in',$3)`, [phone, m?.workspace_id ?? null, body]);
    });
  }

  async history(phone: string, afterId = 0): Promise<Array<{ id: string; dir: string; body: Record<string, unknown>; at: Date }>> {
    return this.db.system((tx) => tx.q(`SELECT id::text, dir, body, at FROM webchat_messages WHERE phone=$1 AND id > $2 ORDER BY id LIMIT 200`, [phone, afterId]));
  }

  /** Media id is "web|<storage ref>|<mime>", produced by the upload endpoint. */
  async downloadMedia(mediaId: string): Promise<{ data: Buffer; mime: string }> {
    const [, ref, mime] = mediaId.split('|');
    if (!mediaId.startsWith('web|') || !ref) throw new AppError('media_not_found', 'definitive');
    return { data: await this.storage.get(ref), mime: mime ?? 'application/octet-stream' };
  }
}
