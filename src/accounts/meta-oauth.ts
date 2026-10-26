import type { Deps } from '../app/deps';
import { AppError } from '../lib/errors';

/**
 * Meta login for Facebook Pages and linked Instagram professional accounts.
 * UNVERIFIED: flow and fields follow public docs/secondary sources; confirm on developers.facebook.com (live check L5/L7).
 */
export const META_SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'instagram_basic', 'instagram_content_publish'];

export function authorizeUrl(d: Deps, state: string): string {
  const u = new URL(`https://www.facebook.com/${d.config.meta.version}/dialog/oauth`);
  u.searchParams.set('client_id', d.config.meta.appId);
  u.searchParams.set('redirect_uri', `${d.config.publicBaseUrl}/connect/meta/callback`);
  u.searchParams.set('state', state);
  u.searchParams.set('scope', META_SCOPES.join(','));
  return u.toString();
}

export interface DiscoveredAccount { platform: 'facebook' | 'instagram'; surface: 'page' | 'account'; accountType: 'page' | 'professional'; externalId: string; label: string; token: string }

export async function exchangeAndDiscover(d: Deps, code: string, f: typeof fetch): Promise<DiscoveredAccount[]> {
  const g = (p: string, q: Record<string, string>) => {
    const u = new URL(`https://graph.facebook.com/${d.config.meta.version}/${p}`);
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
    return u;
  };
  const get = async (u: URL, token?: string) => {
    const r = await f(u, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
    const j = (await r.json().catch(() => ({}))) as any;
    if (!r.ok) throw new AppError('meta_oauth_failed', 'definitive', j?.error?.message);
    return j;
  };
  const short = await get(g('oauth/access_token', { client_id: d.config.meta.appId, client_secret: d.config.meta.appSecret, redirect_uri: `${d.config.publicBaseUrl}/connect/meta/callback`, code }));
  const long = await get(g('oauth/access_token', { grant_type: 'fb_exchange_token', client_id: d.config.meta.appId, client_secret: d.config.meta.appSecret, fb_exchange_token: short.access_token }));
  const pages = await get(g('me/accounts', { fields: 'id,name,access_token,instagram_business_account{id,username}' }), long.access_token);
  const out: DiscoveredAccount[] = [];
  for (const p of pages.data ?? []) {
    out.push({ platform: 'facebook', surface: 'page', accountType: 'page', externalId: String(p.id), label: String(p.name ?? 'Page'), token: String(p.access_token) });
    const ig = p.instagram_business_account;
    if (ig?.id) out.push({ platform: 'instagram', surface: 'account', accountType: 'professional', externalId: String(ig.id), label: '@' + String(ig.username ?? ig.id), token: String(p.access_token) });
  }
  return out;
}
