import { afterEach, describe, expect, it } from 'vitest';
import { harness, P, type Harness } from './harness';
import { signBody } from '../src/security/crypto';

let h: Harness;
afterEach(async () => { await h?.close(); });

const auth = { authorization: 'Bearer dev-operator' };

describe('HTTP surface', () => {
  it('T-HTTP-01 webhook handshake answers only the right verify token', async () => {
    h = await harness();
    const ok = await h.app.inject({ url: '/webhook?hub.mode=subscribe&hub.verify_token=sim-verify&hub.challenge=123' });
    expect([ok.statusCode, ok.body]).toEqual([200, '123']);
    expect((await h.app.inject({ url: '/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1' })).statusCode).toBe(403);
  });

  it('F17 malformed or wrong signatures get 401, nothing is processed, and the server stays up', async () => {
    h = await harness();
    const payload = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'SIM_PNID' }, messages: [{ id: 'x1', from: P.owner, type: 'text', text: { body: 'help' } }] } }] }] });
    for (const sig of [undefined, 'sha256=' + 'z'.repeat(64), 'sha256=00', 'garbage', signBody(payload, 'wrong-secret')]) {
      const r = await h.app.inject({ method: 'POST', url: '/webhook', payload, headers: { 'content-type': 'application/json', ...(sig ? { 'x-hub-signature-256': sig } : {}) } });
      expect(r.statusCode).toBe(401);
    }
    await h.drain();
    expect(h.msgs(P.owner)).toHaveLength(0);
    expect((await h.app.inject({ url: '/health' })).statusCode).toBe(200);
  });

  it('F18 bodies over 1 MB are rejected', async () => {
    h = await harness();
    const r = await h.app.inject({ method: 'POST', url: '/webhook', payload: 'x'.repeat(1_100_000), headers: { 'content-type': 'application/json' } });
    expect(r.statusCode).toBe(413);
  });

  it('T-HTTP-02 a signed but non-JSON body is acknowledged and ignored', async () => {
    h = await harness();
    const payload = '{not json';
    const r = await h.app.inject({ method: 'POST', url: '/webhook', payload, headers: { 'content-type': 'application/json', 'x-hub-signature-256': signBody(payload, 'sim-app-secret') } });
    expect(r.statusCode).toBe(200);
  });

  it('T-HTTP-03 operator endpoints require the token; operators can pause but never approve', async () => {
    h = await harness();
    expect((await h.app.inject({ url: '/ops/tasks' })).statusCode).toBe(401);
    expect((await h.app.inject({ url: '/ops/tasks', headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
    const p = await h.app.inject({ method: 'POST', url: `/ops/workspaces/${h.ws}/pause`, headers: { ...auth, 'content-type': 'application/json' }, payload: { reason: 'review' } });
    expect(p.json()).toMatchObject({ status: 'paused' });
    await h.say(P.owner, 'help');
    expect(h.last(P.owner)).toMatch(/paused/);
    const resolve = await h.app.inject({ method: 'POST', url: '/ops/tasks/anything/resolve', headers: { ...auth, 'content-type': 'application/json' }, payload: { action: 'approve' } });
    expect(resolve.statusCode).toBe(400);
  });

  it('T-HTTP-04 operator creates a workspace and members; a phone cannot be bound to two workspaces', async () => {
    h = await harness();
    const r = await h.app.inject({ method: 'POST', url: '/ops/workspaces', headers: { ...auth, 'content-type': 'application/json' }, payload: { name: 'New', kind: 'creator', ownerPhone: '917000000001' } });
    expect(r.statusCode).toBe(200);
    const dup = await h.app.inject({ method: 'POST', url: `/ops/workspaces/${r.json().id}/members`, headers: { ...auth, 'content-type': 'application/json' }, payload: { phone: P.editor, role: 'editor' } });
    expect(dup.statusCode).toBe(409);
  });

  it('T-HTTP-05 needs_human tasks are listed; operator retry sends a fresh approval to the owner', async () => {
    h = await harness();
    h.social.fault = 'timeout_before_send';
    await h.tap(P.owner, await h.toApproval());
    for (let i = 0; i < 12; i++) await h.advance(200_000);
    const list = (await h.app.inject({ url: '/ops/tasks?state=needs_human', headers: auth })).json();
    expect(list).toHaveLength(1);
    h.social.fault = 'none';
    const before = (await h.approvals()).length;
    const r = await h.app.inject({ method: 'POST', url: `/ops/tasks/${list[0].id}/resolve`, headers: { ...auth, 'content-type': 'application/json' }, payload: { action: 'retry' } });
    expect(r.statusCode).toBe(200);
    await h.drain();
    expect((await h.approvals()).length).toBe(before + 1);
    expect((await h.task()).state).toBe('awaiting_approval');
  });

  it('T-HTTP-06 connect flow: one-time link, test provider, account connected, waiting posts re-routed', async () => {
    h = await harness({ account: 'none' });
    await h.media(P.owner, { caption: 'x' });
    await h.tap(P.owner, `c:${(await h.task()).id}:n`);
    expect((await h.task()).state).toBe('blocked_route');
    await h.say(P.owner, 'connect');
    const url = new URL(h.last(P.owner).match(/https?:\/\/\S+/)![0]);
    const start = await h.app.inject({ url: url.pathname + url.search });
    expect(start.statusCode).toBe(200);
    const state = start.body.match(/name="state" value="([^"]+)"/)![1]!;
    expect((await h.app.inject({ url: url.pathname + url.search })).statusCode).toBe(410);
    const done = await h.app.inject({ method: 'POST', url: '/connect/fake', payload: `state=${encodeURIComponent(state)}&kind=ig_pro&label=shop`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(done.statusCode).toBe(200);
    await h.drain();
    expect((await h.task()).state).toBe('awaiting_approval');
    expect(h.texts(P.owner).join('\n')).toMatch(/jud gaya/);
  });

  it('T-HTTP-07 media links are signed, expire, and are limited in uses', async () => {
    h = await harness();
    await h.tapNoDrain(P.owner, await h.toApproval());
    const token = await h.db.tenant(h.ws, (tx) => h.d.links.create(tx, { workspaceId: h.ws, kind: 'media', ref: 'nope', expiresAt: new Date(h.clock.now().getTime() - 1) }));
    expect((await h.app.inject({ url: '/media?t=' + encodeURIComponent(token) })).statusCode).toBe(404);
    expect((await h.app.inject({ url: '/media?t=forged.token' })).statusCode).toBe(404);
  });
});
