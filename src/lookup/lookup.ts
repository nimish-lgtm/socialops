import { AppError } from '../lib/errors';
import type { AccountInfo } from '../ports';

/**
 * Public profile lookups from a link, through official APIs only. Nothing is scraped.
 * UNVERIFIED field names and access rules: confirm on developers.facebook.com and developers.google.com.
 */
export type SocialLink =
  | { platform: 'instagram'; handle: string; url: string }
  | { platform: 'facebook'; handle: string; url: string }
  | { platform: 'facebook_share'; url: string }
  | { platform: 'youtube'; handle: string; url: string; kind: 'handle' | 'channel' }
  | { platform: 'unsupported'; name: string; url: string };

const RESERVED_IG = new Set(['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'tv']);
const RESERVED_FB = new Set(['profile.php', 'groups', 'events', 'watch', 'photo', 'photo.php', 'story.php', 'permalink.php', 'people', 'pages', 'login', 'marketplace', 'reel']);

export const LINK_PATTERN = /https?:\/\/[^\s<>"']+/i;

export function parseSocialLink(raw: string): SocialLink | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^(www\.|m\.|web\.|mobile\.)/, '');
  const parts = u.pathname.split('/').filter(Boolean);
  const url = u.toString();
  if (host === 'instagram.com' || host === 'instagr.am') {
    const h = parts[0];
    return h && !RESERVED_IG.has(h.toLowerCase()) && /^[A-Za-z0-9._]{1,30}$/.test(h) ? { platform: 'instagram', handle: h, url } : { platform: 'unsupported', name: 'Instagram post/reel link', url };
  }
  if (host === 'facebook.com' || host === 'fb.com' || host === 'fb.me') {
    if (parts[0] === 'share' || host === 'fb.me') return { platform: 'facebook_share', url };
    if (parts[0] === 'profile.php') return { platform: 'unsupported', name: 'Facebook personal profile', url };
    const h = parts[0] === 'pages' ? parts[parts.length - 1] : parts[0];
    return h && !RESERVED_FB.has(h.toLowerCase()) && /^[A-Za-z0-9.\-]{2,80}$/.test(h) ? { platform: 'facebook', handle: h, url } : { platform: 'unsupported', name: 'Facebook link', url };
  }
  if (host === 'youtube.com' || host === 'youtu.be') {
    if (parts[0]?.startsWith('@')) return { platform: 'youtube', handle: parts[0], url, kind: 'handle' };
    if (parts[0] === 'channel' && parts[1]) return { platform: 'youtube', handle: parts[1], url, kind: 'channel' };
    return { platform: 'unsupported', name: 'YouTube video link', url };
  }
  const names: Record<string, string> = { 'x.com': 'X (Twitter)', 'twitter.com': 'X (Twitter)', 'linkedin.com': 'LinkedIn', 'tiktok.com': 'TikTok', 'threads.net': 'Threads', 'snapchat.com': 'Snapchat', 'pinterest.com': 'Pinterest' };
  return { platform: 'unsupported', name: names[host] ?? host, url };
}

export interface LookupConfig { graphVersion: string; igUserId: string; igToken: string; appId: string; appSecret: string; youtubeKey: string }

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);

async function getJson(f: typeof fetch, url: URL, headers: Record<string, string> = {}): Promise<any> {
  let r: Response;
  try { r = await f(url, { headers }); } catch (e) { throw new AppError('lookup_network', 'transient', (e as Error).message); }
  const j = (await r.json().catch(() => ({}))) as any;
  if (!r.ok) throw new AppError(`lookup_${r.status}`, r.status === 429 || r.status >= 500 ? 'transient' : 'definitive', j?.error?.message ?? '');
  return j;
}

/** Instagram Business Discovery: reads another Business/Creator account by username using our own IG business account. */
export async function lookupInstagram(c: LookupConfig, f: typeof fetch, handle: string): Promise<AccountInfo> {
  if (!c.igUserId || !c.igToken) throw new AppError('lookup_not_configured', 'permanent');
  const u = new URL(`https://graph.facebook.com/${c.graphVersion}/${c.igUserId}`);
  u.searchParams.set('fields', `business_discovery.username(${handle}){username,name,biography,website,followers_count,follows_count,media_count,media.limit(5){caption,like_count,comments_count,permalink,timestamp}}`);
  let j: any;
  try { j = await getJson(f, u, { Authorization: `Bearer ${c.igToken}` }); }
  catch (e) { if ((e as AppError).cls === 'definitive') throw new AppError('lookup_not_public', 'definitive', 'not a public Business/Creator account, or not found'); throw e; }
  const b = j.business_discovery;
  if (!b) throw new AppError('lookup_not_public', 'definitive');
  return {
    name: b.name ?? null, username: b.username ?? handle, category: null, bio: b.biography ?? null, website: b.website ?? null,
    followers: num(b.followers_count), following: num(b.follows_count), postsCount: num(b.media_count),
    recent: ((b.media?.data ?? []) as any[]).map((p) => ({ caption: p.caption ?? null, likes: num(p.like_count), comments: num(p.comments_count), url: p.permalink ?? null, at: p.timestamp ?? null })),
    source: 'instagram_business_discovery',
  };
}

/** Facebook Page public metadata with the app token. Needs Meta's "Page Public Metadata Access" approval. */
export async function lookupFacebookPage(c: LookupConfig, f: typeof fetch, handle: string): Promise<AccountInfo> {
  if (!c.appId || !c.appSecret) throw new AppError('lookup_not_configured', 'permanent');
  const u = new URL(`https://graph.facebook.com/${c.graphVersion}/${encodeURIComponent(handle)}`);
  u.searchParams.set('fields', 'name,username,about,category,fan_count,followers_count,link,website');
  let j: any;
  try { j = await getJson(f, u, { Authorization: `Bearer ${c.appId}|${c.appSecret}` }); }
  catch (e) { if ((e as AppError).cls === 'definitive') throw new AppError('lookup_needs_approval', 'definitive', (e as Error).message); throw e; }
  return {
    name: j.name ?? null, username: j.username ?? handle, category: j.category ?? null, bio: j.about ?? null, website: j.website ?? j.link ?? null,
    followers: num(j.followers_count ?? j.fan_count), following: null, postsCount: null, recent: [], source: 'facebook_page_public',
  };
}

/** YouTube Data API v3 with an API key: channel stats plus the latest uploads with their stats. */
export async function lookupYouTube(c: LookupConfig, f: typeof fetch, handle: string, kind: 'handle' | 'channel'): Promise<AccountInfo> {
  if (!c.youtubeKey) throw new AppError('lookup_not_configured', 'permanent');
  const base = 'https://www.googleapis.com/youtube/v3';
  const u = new URL(`${base}/channels`);
  u.searchParams.set('part', 'snippet,statistics,contentDetails');
  u.searchParams.set(kind === 'handle' ? 'forHandle' : 'id', handle);
  u.searchParams.set('key', c.youtubeKey);
  const j = await getJson(f, u);
  const ch = j.items?.[0];
  if (!ch) throw new AppError('lookup_not_public', 'definitive', 'channel not found');
  const recent: AccountInfo['recent'] = [];
  const uploads = ch.contentDetails?.relatedPlaylists?.uploads;
  if (uploads) {
    const pl = new URL(`${base}/playlistItems`);
    pl.searchParams.set('part', 'contentDetails,snippet');
    pl.searchParams.set('playlistId', uploads);
    pl.searchParams.set('maxResults', '5');
    pl.searchParams.set('key', c.youtubeKey);
    const items = ((await getJson(f, pl)).items ?? []) as any[];
    const ids = items.map((i) => i.contentDetails?.videoId).filter(Boolean);
    const stats = new Map<string, any>();
    if (ids.length) {
      const v = new URL(`${base}/videos`);
      v.searchParams.set('part', 'statistics');
      v.searchParams.set('id', ids.join(','));
      v.searchParams.set('key', c.youtubeKey);
      for (const it of ((await getJson(f, v)).items ?? []) as any[]) stats.set(it.id, it.statistics);
    }
    for (const i of items) {
      const id = i.contentDetails?.videoId;
      const s = stats.get(id) ?? {};
      recent.push({ caption: i.snippet?.title ?? null, likes: num(s.likeCount), comments: num(s.commentCount), url: id ? `https://www.youtube.com/watch?v=${id}` : null, at: i.contentDetails?.videoPublishedAt ?? null });
    }
  }
  return {
    name: ch.snippet?.title ?? null, username: ch.snippet?.customUrl ?? handle, category: null, bio: ch.snippet?.description ?? null, website: null,
    followers: ch.statistics?.hiddenSubscriberCount ? null : num(ch.statistics?.subscriberCount), following: null, postsCount: num(ch.statistics?.videoCount),
    recent, source: 'youtube_data_api',
  };
}
