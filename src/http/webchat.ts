import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Deps } from '../app/deps';
import { WebChat } from '../adapters/webchat';
import { receive, type InMsg } from '../channel/ingress';
import { newId } from '../lib/ids';

const COOKIE = 'so_sid';
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

/**
 * Browser chat for real users (MODE=web): each browser gets a signed session id that acts as its phone number.
 * A first message from a new session signs it up; everything after that is the same pipeline as WhatsApp.
 */
export function registerWebChat(app: FastifyInstance, d: Deps): void {
  if (!(d.wa instanceof WebChat)) return;
  const chat = d.wa;
  const page = fs.readFileSync(path.resolve(import.meta.dirname, '../../web/index.html'), 'utf8');
  const sign = (id: string) => createHmac('sha256', d.config.linkSecret).update('sid:' + id).digest('hex').slice(0, 32);
  const secure = d.config.publicBaseUrl.startsWith('https://');

  const session = (req: FastifyRequest, reply: FastifyReply): string => {
    const raw = (req.headers.cookie ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1) ?? '';
    const [id, mac] = decodeURIComponent(raw).split('.');
    if (id && mac && /^[0-9a-f]{16}$/.test(id) && mac.length === 32 && timingSafeEqual(Buffer.from(mac), Buffer.from(sign(id)))) return 'w' + id;
    const fresh = randomBytes(8).toString('hex');
    reply.header('set-cookie', `${COOKIE}=${fresh}.${sign(fresh)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure ? '; Secure' : ''}`);
    return 'w' + fresh;
  };

  app.get('/', async (_req, reply) => reply.type('text/html').send(page));

  app.post('/chat/send', async (req, reply) => {
    const phone = session(req, reply);
    const b = (req.body ?? {}) as { text?: string; buttonId?: string; buttonTitle?: string; media?: { base64?: string; mime?: string; caption?: string } };
    const wamid = newId('web');
    let msg: InMsg;
    if (b.media?.base64) {
      const data = Buffer.from(b.media.base64, 'base64');
      const mime = String(b.media.mime ?? '');
      if (data.length > MAX_MEDIA_BYTES) return reply.code(413).send({ error: 'File 16 MB se badi hai' });
      if (!/^(image|video)\//.test(mime)) return reply.code(415).send({ error: 'Sirf photo ya video' });
      const stored = await d.storage.put('_uploads', data, mime);
      const caption = b.media.caption?.slice(0, 1000);
      msg = { wamid, from: phone, pnid: null, type: 'media', mediaId: `web|${stored.ref}|${mime}`, mime, caption };
      await chat.recordInbound(phone, { kind: 'media', mime, caption: caption ?? null });
    } else if (b.buttonId) {
      msg = { wamid, from: phone, pnid: null, type: 'button', buttonId: String(b.buttonId).slice(0, 256) };
      await chat.recordInbound(phone, { kind: 'tap', title: String(b.buttonTitle ?? '').slice(0, 40) });
    } else {
      const text = String(b.text ?? '').trim().slice(0, 4096);
      if (!text) return reply.code(400).send({ error: 'empty' });
      msg = { wamid, from: phone, pnid: null, type: 'text', text };
      await chat.recordInbound(phone, { kind: 'text', body: text });
    }
    await receive(d, msg);
    return { ok: true };
  });

  app.get('/chat/messages', async (req, reply) => {
    const phone = session(req, reply);
    const after = Number((req.query as { after?: string }).after ?? 0) || 0;
    return { messages: await chat.history(phone, after) };
  });

  /** Start over as a brand-new user (a new session id). The old workspace stays until its owner deletes it. */
  app.post('/chat/new', async (_req, reply) => {
    reply.header('set-cookie', `${COOKIE}=; Path=/; Max-Age=0`);
    return { ok: true };
  });
}
