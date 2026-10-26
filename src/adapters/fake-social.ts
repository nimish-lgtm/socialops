import { newId } from '../lib/ids';
import { AppError } from '../lib/errors';
import type { AccountRef, PublishResult, SocialPort } from '../ports';

export type SocialFault = 'none' | 'timeout_after_success' | 'timeout_before_send' | 'reject' | 'not_live' | 'metrics_missing' | 'token_expired';

interface FakePost { id: string; accountId: string; caption: string; url: string; live: boolean; key: string }

/** In-memory Instagram/Facebook with the failure modes the real platforms show. */
export class FakeSocial implements SocialPort {
  readonly kind = 'fake' as const;
  posts = new Map<string, FakePost>();
  publishCalls = 0;
  fault: SocialFault = 'none';
  disabled = new Set<string>();

  canPublish(account: AccountRef): boolean { return !this.disabled.has(account.id); }

  async publish(req: { account: AccountRef; caption: string; idempotencyKey: string }): Promise<PublishResult> {
    this.publishCalls++;
    if (this.fault === 'token_expired') throw new AppError('token_expired', 'definitive');
    if (this.fault === 'reject') throw new AppError('media_rejected', 'definitive', 'platform rejected media');
    if (this.fault === 'timeout_before_send') throw new AppError('timeout', 'ambiguous');
    const id = newId('igpost');
    const p = { id, accountId: req.account.id, caption: req.caption, url: `https://social.example/p/${id}`, live: this.fault !== 'not_live', key: req.idempotencyKey };
    this.posts.set(id, p);
    if (this.fault === 'timeout_after_success') throw new AppError('timeout', 'ambiguous');
    return { externalId: id, url: p.url };
  }

  async findByKey(req: { idempotencyKey: string }): Promise<PublishResult | null> {
    for (const p of this.posts.values()) if (p.key === req.idempotencyKey) return { externalId: p.id, url: p.url };
    return null;
  }

  async readback(req: { externalId: string }): Promise<{ live: boolean; url: string | null; caption: string | null }> {
    const p = this.posts.get(req.externalId);
    return { live: !!p?.live, url: p?.url ?? null, caption: p?.caption ?? null };
  }

  async metrics(req: { externalId: string }): Promise<Record<string, number | null>> {
    if (this.fault === 'metrics_missing') return { views: null, likes: null, comments: null };
    return this.posts.has(req.externalId) ? { views: 120, likes: 14, comments: 3 } : { views: null, likes: null, comments: null };
  }

  async checkToken(): Promise<'ok' | 'expired'> { return this.fault === 'token_expired' ? 'expired' : 'ok'; }
}
