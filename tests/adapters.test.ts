import { describe, expect, it } from 'vitest';
import { CloudWhatsApp } from '../src/adapters/cloud-whatsapp';
import { MetaSocial } from '../src/adapters/meta-social';
import { guardedFetch } from '../src/core/gateway';
import { Gateway } from '../src/core/gateway';
import { silentLogger } from '../src/lib/log';

type Call = { url: string; init?: RequestInit };
const mockFetch = (responses: Array<{ status?: number; body: unknown }>, calls: Call[]) =>
  (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = responses.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

describe('live adapters against a mocked network (shapes only; not proof of platform behaviour)', () => {
  it('T-ADP-01 WhatsApp buttons: max 3, titles cut to 20 chars, bearer auth, message id returned', async () => {
    const calls: Call[] = [];
    const wa = new CloudWhatsApp({ version: 'v20.0', phoneNumberId: 'PN', token: 'TKN' }, mockFetch([{ body: { messages: [{ id: 'wamid.1' }] } }], calls));
    const r = await wa.send('919', { kind: 'buttons', body: 'Approve?', buttons: [1, 2, 3, 4].map((i) => ({ id: 'b' + i, title: 'A very long button title ' + i })) });
    expect(r.waId).toBe('wamid.1');
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v20.0/PN/messages');
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer TKN');
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.interactive.action.buttons).toHaveLength(3);
    expect(body.interactive.action.buttons[0].reply.title.length).toBeLessThanOrEqual(20);
  });

  it('T-ADP-02 WhatsApp errors are classified: 4xx definitive, 429/5xx ambiguous', async () => {
    const wa4 = new CloudWhatsApp({ version: 'v', phoneNumberId: 'P', token: 'T' }, mockFetch([{ status: 400, body: { error: { message: 'bad' } } }], []));
    await expect(wa4.send('1', { kind: 'text', body: 'x' })).rejects.toMatchObject({ cls: 'definitive' });
    const wa5 = new CloudWhatsApp({ version: 'v', phoneNumberId: 'P', token: 'T' }, mockFetch([{ status: 503, body: {} }], []));
    await expect(wa5.send('1', { kind: 'text', body: 'x' })).rejects.toMatchObject({ cls: 'ambiguous' });
    const wa429 = new CloudWhatsApp({ version: 'v', phoneNumberId: 'P', token: 'T' }, mockFetch([{ status: 429, body: {} }], []));
    await expect(wa429.send('1', { kind: 'text', body: 'x' })).rejects.toMatchObject({ cls: 'ambiguous' });
  });

  it('T-ADP-03 Instagram reel: container, wait until FINISHED, then publish; token in header, never in URL', async () => {
    const calls: Call[] = [];
    const meta = new MetaSocial({ version: 'v20.0', enabled: true, pollMs: 1 }, mockFetch([{ body: { id: 'C1' } }, { body: { status_code: 'IN_PROGRESS' } }, { body: { status_code: 'FINISHED' } }, { body: { id: 'M1' } }], calls));
    const acct = { id: 'a', platform: 'instagram', surface: 'account', accountType: 'professional', externalId: 'IG1' };
    const r = await meta.publish({ account: acct, media: { ref: 'r', mime: 'video/mp4', sha256: 's', publicUrl: 'https://x/m.mp4' }, caption: 'hi', token: 'SECRET' });
    expect(r.externalId).toBe('M1');
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/v20.0/IG1/media', '/v20.0/C1', '/v20.0/C1', '/v20.0/IG1/media_publish']);
    expect(calls.every((c) => !c.url.includes('SECRET'))).toBe(true);
  });

  it('T-ADP-04 Instagram container that never finishes is not published', async () => {
    const calls: Call[] = [];
    const meta = new MetaSocial({ version: 'v', enabled: true, pollMs: 1, maxPolls: 3 }, mockFetch([{ body: { id: 'C1' } }, ...Array(3).fill({ body: { status_code: 'IN_PROGRESS' } })], calls));
    const acct = { id: 'a', platform: 'instagram', surface: 'account', accountType: 'professional', externalId: 'IG1' };
    await expect(meta.publish({ account: acct, media: { ref: 'r', mime: 'video/mp4', sha256: 's', publicUrl: 'u' }, caption: 'c', token: 't' })).rejects.toMatchObject({ code: 'ig_container_not_ready' });
    expect(calls.some((c) => c.url.includes('media_publish'))).toBe(false);
  });

  it('T-ADP-05 Meta publishing is off unless explicitly enabled; personal accounts are never publishable', () => {
    const off = new MetaSocial({ version: 'v', enabled: false }, fetch);
    const on = new MetaSocial({ version: 'v', enabled: true }, fetch);
    const pro = { id: 'a', platform: 'instagram', surface: 'account', accountType: 'professional', externalId: '1' };
    expect(off.canPublish(pro)).toBe(false);
    expect(on.canPublish(pro)).toBe(true);
    expect(on.canPublish({ ...pro, accountType: 'personal' })).toBe(false);
  });

  it('T-ADP-06 egress guard allows only https to listed hosts', async () => {
    const f = guardedFetch(['graph.facebook.com'], (async () => new Response('{}')) as unknown as typeof fetch);
    await expect(f('https://graph.facebook.com/x')).resolves.toBeTruthy();
    await expect(f('http://graph.facebook.com/x')).rejects.toMatchObject({ code: 'egress_denied' });
    await expect(f('https://evil.example/x')).rejects.toMatchObject({ code: 'egress_denied' });
  });

  it('T-ADP-07 gateway enforces role allow-lists and approval ids; receipts bind tool, args and result', async () => {
    const g = new Gateway(silentLogger);
    expect(() => g.authorize('skills', 'social.publish', 'apr')).toThrow(/may not call/);
    const code = (() => { try { g.authorize('publisher', 'social.publish'); return 'none'; } catch (e) { return (e as { code: string }).code; } })();
    expect(code).toBe('approval_required');
    expect(() => g.authorize('publisher', 'social.publish', 'apr')).not.toThrow();
    const r = g.receipt('social.publish', { k: 1 }, { id: 'p' });
    expect(g.verifyReceipt(r, 'social.publish', { k: 1 }, { id: 'p' })).toBe(true);
    expect(g.verifyReceipt(r, 'social.publish', { k: 1 }, { id: 'q' })).toBe(false);
  });
});
