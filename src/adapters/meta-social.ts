import { AppError } from '../lib/errors';
import type { AccountRef, MediaRef, PublishResult, SocialPort } from '../ports';
import { isConnectError } from './cloud-whatsapp';

/**
 * Instagram (professional) and Facebook Page publishing via the Graph API.
 * UNVERIFIED: endpoint shapes are from public docs and secondary sources; disabled unless META_PUBLISH_ENABLED=true
 * and only after live check L5 passes. Media must be reachable at a public HTTPS URL (signed /media link).
 */
export class MetaSocial implements SocialPort {
  readonly kind = 'live' as const;
  constructor(private cfg: { version: string; enabled: boolean; pollMs?: number; maxPolls?: number }, private f: typeof fetch) {}

  canPublish(a: AccountRef): boolean {
    return this.cfg.enabled && !!a.externalId && ((a.platform === 'instagram' && a.accountType === 'professional') || (a.platform === 'facebook' && a.surface === 'page'));
  }

  private async call(method: 'GET' | 'POST', path: string, params: Record<string, string>, token: string): Promise<any> {
    const url = new URL(`https://graph.facebook.com/${this.cfg.version}/${path}`);
    const body = new URLSearchParams(params);
    if (method === 'GET') for (const [k, v] of body) url.searchParams.set(k, v);
    let r: Response;
    try {
      // Token travels in the Authorization header, never in the URL, so it cannot leak into access logs.
      r = await this.f(url, { method, headers: { Authorization: `Bearer ${token}`, ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body: method === 'POST' ? body : undefined });
    } catch (e) {
      throw new AppError('meta_network', isConnectError(e) ? 'not_sent' : 'ambiguous', (e as Error).message);
    }
    const j = (await r.json().catch(() => ({}))) as { error?: { message?: string; code?: number } };
    if (!r.ok) {
      if (j.error?.code === 190) throw new AppError('token_expired', 'definitive');
      throw new AppError(`meta_${r.status}`, r.status >= 400 && r.status < 500 && r.status !== 429 ? 'definitive' : 'ambiguous', j.error?.message);
    }
    return j;
  }

  async publish(req: { account: AccountRef; media: MediaRef; caption: string; token: string }): Promise<PublishResult> {
    const a = req.account;
    if (!this.canPublish(a)) throw new AppError('capability_missing', 'permanent');
    const video = req.media.mime.startsWith('video/');
    if (a.platform === 'instagram') {
      const c = await this.call('POST', `${a.externalId}/media`, video ? { media_type: 'REELS', video_url: req.media.publicUrl, caption: req.caption } : { image_url: req.media.publicUrl, caption: req.caption }, req.token);
      if (video) await this.waitFinished(c.id, req.token);
      const p = await this.call('POST', `${a.externalId}/media_publish`, { creation_id: c.id }, req.token);
      return { externalId: String(p.id), url: null };
    }
    const p = video
      ? await this.call('POST', `${a.externalId}/videos`, { file_url: req.media.publicUrl, description: req.caption }, req.token)
      : await this.call('POST', `${a.externalId}/photos`, { url: req.media.publicUrl, caption: req.caption }, req.token);
    return { externalId: String(p.post_id ?? p.id), url: null };
  }

  private async waitFinished(containerId: string, token: string): Promise<void> {
    for (let i = 0; i < (this.cfg.maxPolls ?? 30); i++) {
      const s = await this.call('GET', containerId, { fields: 'status_code' }, token);
      if (s.status_code === 'FINISHED') return;
      if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new AppError(`ig_container_${s.status_code}`, 'definitive');
      await new Promise((r) => setTimeout(r, this.cfg.pollMs ?? 3000));
    }
    // Never publish a container that did not finish processing; nothing has been published yet, so this is safe to fail.
    throw new AppError('ig_container_not_ready', 'definitive');
  }

  /** No idempotency key exists on the platform: look for a recent post with the exact caption. */
  async findByKey(req: { account: AccountRef; caption: string; token: string }): Promise<PublishResult | null> {
    const a = req.account;
    const edge = a.platform === 'instagram' ? 'media' : 'posts';
    const fields = a.platform === 'instagram' ? 'id,caption,permalink' : 'id,message,permalink_url';
    const j = await this.call('GET', `${a.externalId}/${edge}`, { fields, limit: '10' }, req.token);
    for (const p of (j.data ?? []) as any[]) {
      if ((p.caption ?? p.message ?? '').trim() === req.caption.trim()) return { externalId: String(p.id), url: p.permalink ?? p.permalink_url ?? null };
    }
    return null;
  }

  async readback(req: { account: AccountRef; externalId: string; token: string }) {
    const ig = req.account.platform === 'instagram';
    const j = await this.call('GET', req.externalId, { fields: ig ? 'id,caption,permalink' : 'id,message,permalink_url' }, req.token);
    return { live: !!j.id, url: (j.permalink ?? j.permalink_url ?? null) as string | null, caption: (j.caption ?? j.message ?? null) as string | null };
  }

  async metrics(req: { account: AccountRef; externalId: string; token: string }) {
    if (req.account.platform !== 'instagram') return { views: null, likes: null, comments: null };
    const j = await this.call('GET', req.externalId, { fields: 'like_count,comments_count' }, req.token);
    return { views: null, likes: num(j.like_count), comments: num(j.comments_count) };
  }

  async checkToken(req: { account: AccountRef; token: string }): Promise<'ok' | 'expired'> {
    try {
      await this.call('GET', String(req.account.externalId), { fields: 'id' }, req.token);
      return 'ok';
    } catch (e) {
      if ((e as AppError).code === 'token_expired') return 'expired';
      throw e;
    }
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
