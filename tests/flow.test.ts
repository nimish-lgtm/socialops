import { afterEach, describe, expect, it } from 'vitest';
import { harness, P, type Harness } from './harness';
import { HOUR, DAY } from '../src/lib/clock';

let h: Harness;
afterEach(async () => { await h?.close(); });

describe('post flow (route E)', () => {
  it('T-POST-01 media -> caption -> consent -> approval -> publish once -> verified live link', async () => {
    h = await harness();
    await h.media(P.owner, { caption: 'Diwali sale 20% off 31 Oct tak' });
    const t = await h.task();
    expect(t.state).toBe('need_consent');
    expect(h.last(P.owner)).toMatch(/koi aur insaan/);
    await h.tap(P.owner, `c:${t.id}:n`);
    expect(h.last(P.owner)).toMatch(/publish karni hai/);
    expect(h.last(P.owner)).toMatch(/⚠ Check karein: .*20% off/);
    expect(h.social.publishCalls).toBe(0);
    const approve = h.findButton(P.owner, 'a:');
    await h.tap(P.owner, approve);
    expect(h.social.posts.size).toBe(1);
    expect((await h.task()).state).toBe('done');
    expect(h.last(P.owner)).toMatch(/Live ho gaya ✅\nhttps:\/\/social\.example/);
    const posts = await h.sys(`SELECT status, verified_at FROM posts`);
    expect(posts).toHaveLength(1);
    expect(posts[0].status).toBe('live');
    expect(posts[0].verified_at).not.toBeNull();
  });

  it('T-POST-02 media without caption asks the topic first', async () => {
    h = await harness();
    await h.media(P.owner);
    expect((await h.task()).state).toBe('need_topic');
    expect(h.last(P.owner)).toMatch(/kis baare mein/);
    await h.say(P.owner, 'Naye laddoo aa gaye');
    expect((await h.task()).state).toBe('need_consent');
    expect((await h.task()).data.caption).toMatch(/Naye laddoo/);
  });

  it('T-POST-03 assisted route for a personal Instagram account: never reported live or verified', async () => {
    h = await harness({ kind: 'personal', account: 'ig_personal' });
    await h.media(P.owner, { caption: 'Goa trip' });
    const t = await h.task();
    await h.tap(P.owner, `c:${t.id}:n`);
    expect((await h.task()).state).toBe('awaiting_user_post');
    expect(h.last(P.owner)).toMatch(/aap khud post karenge/);
    await h.tap(P.owner, `u:${t.id}:d`);
    const p = (await h.sys(`SELECT status, verified_at, url FROM posts`))[0];
    expect(p).toMatchObject({ status: 'user_confirmed', verified_at: null, url: null });
    expect(h.social.publishCalls).toBe(0);
    expect(h.last(P.owner)).toMatch(/verify nahi kiya/);
  });
});
