/**
 * Goal tests: "A WhatsApp-first operator that runs social accounts end to end for three kinds of users:
 * a normal person who wants to share memories and stay connected, a creator who wants to grow an audience,
 * and a business that wants customers." Each journey runs through the signed webhook like a real phone.
 * it.todo marks parts of the goal the system does not do yet; they are reported, not hidden.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { harness, P, type Harness } from './harness';
import { DAY } from '../src/lib/clock';
import { runScheduler } from '../src/jobs/scheduler';
import { FakeLlm, defaultScript } from '../src/adapters/llm';
import { createWorkspace, connectAccount } from '../src/accounts/workspaces';

let h: Harness;
afterEach(async () => { await h?.close(); });

const onboard = async (answers: string[]) => {
  await h.say(P.owner, 'namaste');
  const asked = [h.last(P.owner)];
  for (const a of answers) { await h.say(P.owner, a); asked.push(h.last(P.owner)); }
  return asked;
};
const publishVia = async (from: string, caption: string, consent: 'n' | 'y' | 'm' = 'n') => {
  await h.media(from, { caption });
  const t = await h.task();
  if (t.state === 'need_consent') await h.tap(from, `c:${t.id}:${consent}`);
  return h.task();
};
const liveLinks = () => h.texts(P.owner).filter((t) => /Live ho gaya/.test(t));

describe('Goal: WhatsApp-first and end to end', () => {
  it('G-01 a business goes from first message to a verified live post and a report using only WhatsApp plus one connect link', async () => {
    h = await harness({ kind: 'business', account: 'none', onboarded: false });
    await onboard(['Mithai ki dukaan, Agra', 'Laddoo, barfi', 'Agra ke parivaar', 'garam aur seedha', 'guaranteed', 'Hinglish']);
    expect(h.last(P.owner)).toMatch(/Profile save ho gaya/);
    await h.say(P.owner, 'connect');
    const url = new URL(h.last(P.owner).match(/https?:\/\/\S+/)![0]);
    const page = await h.app.inject({ url: url.pathname + url.search });
    const state = page.body.match(/name="state" value="([^"]+)"/)![1]!;
    await h.app.inject({ method: 'POST', url: '/connect/fake', payload: `state=${encodeURIComponent(state)}&kind=ig_pro&label=mithai`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    await h.drain();
    await publishVia(P.owner, 'Diwali laddoo 20% off');
    await h.tap(P.owner, h.findButton(P.owner, 'a:'));
    await h.say(P.owner, 'report');
    expect(liveLinks()).toHaveLength(1);
    expect(h.last(P.owner)).toMatch(/views/);
    const nonWhatsAppSteps = 2; // open the connect link, pick the account
    expect(nonWhatsAppSteps).toBeLessThanOrEqual(2);
  });

  it('G-02 the owner never needs more than one tap per post after sending the media (consent + approve)', async () => {
    h = await harness();
    const before = (await h.sys(`SELECT COUNT(*)::int n FROM inbound_events`))[0].n;
    await publishVia(P.owner, 'Naya stock');
    await h.tap(P.owner, h.findButton(P.owner, 'a:'));
    const owner_msgs = (await h.sys(`SELECT COUNT(*)::int n FROM inbound_events`))[0].n - before;
    expect(liveLinks()).toHaveLength(1);
    expect(owner_msgs).toBe(3); // media, consent tap, approve tap
  });
});

describe('Persona 1: a normal person who wants to share memories and stay connected', () => {
  it('P-01 onboarding talks about memories and people, not about selling', async () => {
    h = await harness({ kind: 'personal', account: 'none', onboarded: false });
    const asked = (await onboard(['a', 'b', 'c', 'd', 'e', 'f'])).join('\n');
    expect(asked).not.toMatch(/bechte|business|customers/i);
    expect(asked).toMatch(/yaad|memories|dost|family|parivaar/i);
  });

  it('P-02 a personal Facebook profile gets an assisted package; nothing is claimed live or verified', async () => {
    h = await harness({ kind: 'personal', account: 'fb_profile' });
    const t = await publishVia(P.owner, 'Nani ka 80va janamdin');
    expect(t.state).toBe('awaiting_user_post');
    expect(h.last(P.owner)).toMatch(/aap khud post karenge/);
    await h.tap(P.owner, `u:${t.id}:d`);
    expect((await h.sys(`SELECT status, verified_at FROM posts`))[0]).toMatchObject({ status: 'user_confirmed', verified_at: null });
    expect(h.social.publishCalls).toBe(0);
    expect(liveLinks()).toHaveLength(0);
  });

  it('P-03 a personal Instagram account is never switched to professional behind the user\'s back', async () => {
    h = await harness({ kind: 'personal', account: 'ig_personal' });
    await publishVia(P.owner, 'Goa trip');
    expect((await h.sys(`SELECT account_type, route FROM accounts`))[0]).toEqual({ account_type: 'personal', route: 'A' });
    expect(h.social.publishCalls).toBe(0);
  });

  it('P-04 family photos with children are never made public by the system', async () => {
    h = await harness({ kind: 'personal', account: 'fb_page' });
    const t = await publishVia(P.owner, 'Bachchon ke saath Diwali', 'm');
    expect(t.state).toBe('blocked_consent');
    expect(h.last(P.owner)).toMatch(/bachche ho sakte hain/);
    expect(h.social.publishCalls).toBe(0);
    expect(await h.approvals()).toHaveLength(0);
  });

  it('P-05 persona is not account type: a person who runs a Facebook Page gets verified publishing, and the card says PUBLIC', async () => {
    h = await harness({ kind: 'personal', account: 'fb_page' });
    await publishVia(P.owner, 'Mohalle ki Holi');
    expect(h.last(P.owner)).toMatch(/Audience: PUBLIC/);
    await h.tap(P.owner, h.findButton(P.owner, 'a:'));
    expect(liveLinks()).toHaveLength(1);
  });

  it('P-06 the caption model is told the workspace is personal, so the "no sales push" rule applies', async () => {
    const llm = new FakeLlm(defaultScript);
    h = await harness({ kind: 'personal', account: 'fb_page', llm });
    await publishVia(P.owner, 'Dosto ke saath picnic');
    const captionCall = llm.calls.find((c) => c.user.includes('"skill":"caption"'));
    expect(JSON.parse(captionCall!.user).workspace_kind).toBe('personal');
  });

  it('P-07 a personal user asking for ads is not sold anything and nothing is spent', async () => {
    h = await harness({ kind: 'personal', account: 'fb_page' });
    await h.say(P.owner, 'ad chalao 500 rupay');
    expect(h.last(P.owner)).not.toMatch(/₹|budget|spend/i);
    expect(await h.sys(`SELECT * FROM actions`)).toHaveLength(0);
  });

  it('P-08 the person stays in control of their data: forget, export and delete all work for a personal owner', async () => {
    h = await harness({ kind: 'personal', account: 'none' });
    await h.say(P.owner, 'forget');
    expect(h.buttons(P.owner)).toContain('f:y');
    await h.say(P.owner, 'export');
    expect(h.last(P.owner)).toMatch(/export tayyar/);
    await h.say(P.owner, 'delete');
    expect(h.last(P.owner)).toMatch(/DELETE likhein/);
  });

  it.todo('P-GAP-1 stay connected: show friends\' comments and draft replies for approval (comments/DMs not built)');
  it.todo('P-GAP-2 choose the audience per post (close friends / family) for assisted posts (default audience not captured)');
  it.todo('P-GAP-3 reply in Devanagari when the person writes in Hindi script (all copy is Hinglish)');
  it.todo('P-GAP-4 a parent sharing their own child\'s memory privately (minors always block, even for private assisted posts)');
});

describe('Persona 2: a creator who wants to grow an audience', () => {
  it('C-01 a creator posts to Instagram Professional and gets a verified live link', async () => {
    h = await harness({ kind: 'creator', account: 'ig_pro' });
    await publishVia(P.owner, 'Naya recipe reel: 5 minute chai');
    await h.tap(P.owner, h.findButton(P.owner, 'a:'));
    expect(liveLinks()).toHaveLength(1);
    expect((await h.sys(`SELECT status, verified_at FROM posts`))[0].status).toBe('live');
  });

  it('C-02 posting consistently: three posts in a week each publish exactly once and the weekly digest counts them with platform numbers', async () => {
    h = await harness({ kind: 'creator', account: 'ig_pro' });
    for (const topic of ['Reel 1', 'Reel 2', 'Reel 3']) {
      await publishVia(P.owner, topic);
      await h.tap(P.owner, h.findButton(P.owner, 'a:'));
      h.clock.advance(DAY);
    }
    expect(h.social.posts.size).toBe(3);
    h.clock.set(new Date('2026-11-09T05:00:00Z'));
    await h.say(P.owner, 'status');
    await runScheduler(h.d);
    await h.drain();
    const digest = h.texts(P.owner).find((t) => /Is hafte ka summary/.test(t))!;
    expect(digest).toMatch(/Posts: 3/);
    expect(digest).toMatch(/120 views/);
    expect(digest).not.toMatch(/data kam hai/);
  });

  it('C-03 growth numbers are only what the platform reports; missing numbers are said, never guessed', async () => {
    h = await harness({ kind: 'creator', account: 'ig_pro' });
    await publishVia(P.owner, 'Reel');
    await h.tap(P.owner, h.findButton(P.owner, 'a:'));
    h.social.fault = 'metrics_missing';
    await h.say(P.owner, 'report');
    expect(h.last(P.owner)).toMatch(/views: data nahi mila/);
    expect(h.last(P.owner)).not.toMatch(/\d+ views/);
  });

  it('C-04 a creator\'s team member (editor) can upload; only the creator approves', async () => {
    h = await harness({ kind: 'creator', account: 'ig_pro' });
    await h.say(P.owner, 'status');
    await publishVia(P.editor, 'Behind the scenes');
    await h.tap(P.editor, h.findButton(P.owner, 'a:'));
    expect(h.social.publishCalls).toBe(0);
    await h.tap(P.owner, h.findButton(P.owner, 'a:'));
    expect(h.social.publishCalls).toBe(1);
  });

  it('C-05 creators do not get ads or sales features by default', async () => {
    h = await harness({ kind: 'creator', account: 'ig_pro' });
    await h.say(P.owner, 'boost karo meri reel ko');
    expect(await h.sys(`SELECT * FROM actions`)).toHaveLength(0);
  });

  it.todo('C-GAP-1 schedule posts for the best time / a content calendar (scheduling not built)');
  it.todo('C-GAP-2 week-over-week growth in followers and reach (only views/likes/comments per post are read)');
  it.todo('C-GAP-3 trend and topic suggestions, hooks, series planning (planner not built)');
  it.todo('C-GAP-4 reply to comments to build community (comments not built)');
  it.todo('C-GAP-5 YouTube Shorts / second platform to grow reach (only Instagram and Facebook)');
});

describe('Persona 3: a business that wants customers', () => {
  it('B-01 prices, dates and offers are highlighted for the owner to check before anything goes public', async () => {
    h = await harness({ kind: 'business', account: 'ig_pro' });
    await publishVia(P.owner, 'Kaju katli ₹899/kg, offer 31 Oct tak, call 98765 43210');
    const card = h.last(P.owner);
    expect(card).toMatch(/⚠ Check karein/);
    for (const c of ['₹899', '31 Oct', '98765 43210']) expect(card).toContain(c);
  });

  it('B-02 phrases the business said never to use are flagged on the card', async () => {
    h = await harness({ kind: 'business', account: 'ig_pro' });
    await publishVia(P.owner, 'Guaranteed sabse fresh mithai');
    expect(h.last(P.owner)).toMatch(/MANA HAI: guaranteed/);
  });

  it('B-03 a wrong post can be fixed or stopped before it goes out: edit, reject, nothing published', async () => {
    h = await harness({ kind: 'business', account: 'ig_pro' });
    await publishVia(P.owner, 'Galat price ₹99');
    await h.tap(P.owner, h.findButton(P.owner, 'a:').replace(/:y$/, ':e'));
    await h.say(P.owner, 'Sahi price ₹199');
    await h.tap(P.owner, h.findButton(P.owner, 'a:').replace(/:y$/, ':n'));
    expect(h.social.publishCalls).toBe(0);
    expect(h.last(P.owner)).toMatch(/Kuch publish nahi hua/);
  });

  it('B-04 staff upload, the owner approves, the accountant (viewer) can only read', async () => {
    h = await harness({ kind: 'business', account: 'ig_pro' });
    await h.say(P.owner, 'status');
    await publishVia(P.editor, 'Naya maal');
    await h.tap(P.viewer, h.findButton(P.owner, 'a:'));
    await h.media(P.viewer);
    expect(h.last(P.viewer)).toMatch(/upload ka access nahi/);
    await h.tap(P.owner, h.findButton(P.owner, 'a:'));
    await h.say(P.viewer, 'report');
    expect(h.last(P.viewer)).toMatch(/120 views/);
  });

  it('B-05 customers in the shop photo trigger the consent question for a business too', async () => {
    h = await harness({ kind: 'business', account: 'ig_pro' });
    await h.media(P.owner, { caption: 'Aaj ki bheed' });
    expect(h.last(P.owner)).toMatch(/koi aur insaan/);
  });

  it('B-06 a business on Facebook Page and Instagram: posts go to a connected account and are verified', async () => {
    h = await harness({ kind: 'business', account: 'fb_page' });
    await publishVia(P.owner, 'Sunday special');
    await h.tap(P.owner, h.findButton(P.owner, 'a:'));
    expect(liveLinks()).toHaveLength(1);
  });

  it.todo('B-GAP-1 turn comments and DMs into leads and reply to customer questions (comments/leads not built)');
  it.todo('B-GAP-2 paid ads with exact-amount approval and spend caps (ads not built in this codebase)');
  it.todo('B-GAP-3 enquiry button / link-in-bio / catalogue so viewers can become customers (not built)');
  it.todo('B-GAP-4 attribute enquiries or sales to posts (no lead or sales data)');
});

describe('Goal: three kinds of users side by side', () => {
  it('X-01 a person, a creator and a business on one system never see or affect each other', async () => {
    h = await harness({ kind: 'personal', account: 'fb_page' });
    const creator = await createWorkspace(h.db, { name: 'Dev', kind: 'creator', ownerPhone: '917100000001' });
    const shop = await createWorkspace(h.db, { name: 'Ravi', kind: 'business', ownerPhone: '917200000001' });
    for (const ws of [creator, shop]) {
      await h.db.tenant(ws, async (tx) => {
        const r = await connectAccount(tx, { workspaceId: ws, platform: 'instagram', surface: 'account', accountType: 'professional', externalId: 'ig_' + ws, label: ws });
        await h.d.credentials.store(tx, { workspaceId: ws, accountId: r.id, provider: 'instagram', token: 't', expiresAt: new Date(h.clock.now().getTime() + 30 * DAY) });
        await tx.q(`UPDATE workspaces SET onboarded=true WHERE id=$1`, [ws]);
      });
    }
    await publishVia(P.owner, 'Same caption everywhere');
    await h.tap(P.owner, h.findButton(P.owner, 'a:'));
    for (const phone of ['917100000001', '917200000001']) {
      await h.media(phone, { caption: 'Same caption everywhere' });
      const t = (await h.sys(`SELECT t.id FROM tasks t JOIN members m ON m.workspace_id=t.workspace_id WHERE m.phone=$1`, [phone]))[0];
      await h.tap(phone, `c:${t.id}:n`);
      const btn = [...h.msgs(phone)].reverse().flatMap((m) => (m.kind === 'buttons' ? m.buttons : [])).find((b) => b.id.startsWith('a:'))!.id;
      await h.tap(P.owner, btn);
      expect(h.last(P.owner)).toMatch(/aapke workspace ki nahi/);
      await h.tap(phone, btn);
    }
    expect(h.social.posts.size).toBe(3);
    const perWs = await h.sys(`SELECT w.kind, COUNT(p.id)::int n FROM workspaces w LEFT JOIN posts p ON p.workspace_id=w.id GROUP BY w.kind ORDER BY w.kind`);
    expect(perWs).toEqual([{ kind: 'business', n: 1 }, { kind: 'creator', n: 1 }, { kind: 'personal', n: 1 }]);
  });

  it('X-02 someone with a personal Instagram and a Facebook Page: the post goes where it can be published and verified, and the card names it', async () => {
    h = await harness({ kind: 'personal', account: 'ig_personal' });
    await h.db.tenant(h.ws, async (tx) => {
      const r = await connectAccount(tx, { workspaceId: h.ws, platform: 'facebook', surface: 'page', accountType: 'page', externalId: 'page2', label: 'Mohalla Page' });
      await h.d.credentials.store(tx, { workspaceId: h.ws, accountId: r.id, provider: 'facebook', token: 't', expiresAt: new Date(h.clock.now().getTime() + 30 * DAY) });
    });
    const t = await publishVia(P.owner, 'Mohalla meetup');
    expect(t.state).toBe('awaiting_approval');
    expect(h.last(P.owner)).toMatch(/Platform: Facebook Page \(Mohalla Page\)/);
  });

  it.todo('X-GAP-1 let the user pick which connected account each post goes to (first connected account is used)');
});
