import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { harness, P, type Harness } from './harness';
import { DAY, HOUR } from '../src/lib/clock';
import { runScheduler } from '../src/jobs/scheduler';
import { workspaceTables } from '../src/privacy/privacy';
import { onboardingQuestions } from '../src/copy';

let h: Harness;
afterEach(async () => { await h?.close(); });

describe('onboarding and commands', () => {
  it('T-CMD-01 onboarding asks one question at a time, resumes, and stores answers as owner memory', async () => {
    h = await harness({ onboarded: false });
    await h.say(P.owner, 'namaste');
    expect(h.last(P.owner)).toMatch(/1\) Aapka kaam/);
    await h.say(P.owner, 'Mithai ki dukaan');
    await h.say(P.owner, 'help');
    expect(h.last(P.owner)).toMatch(/Main ye kar sakta hoon/);
    await h.say(P.owner, 'start');
    for (const a of ['Laddoo', 'Agra families', 'seedha', 'guaranteed', 'Hinglish']) await h.say(P.owner, a);
    expect(h.last(P.owner)).toMatch(/Profile save ho gaya/);
    const prof = (await h.sys(`SELECT answers FROM profiles WHERE workspace_id=$1`, [h.ws]))[0].answers;
    expect(Object.keys(prof)).toHaveLength(onboardingQuestions('business').length);
    expect(prof.business).toBe('Mithai ki dukaan');
    const mem = await h.sys(`SELECT kind, source FROM memory_items WHERE workspace_id=$1`, [h.ws]);
    expect(mem.length).toBe(6);
    expect(mem.every((m: any) => m.source === 'owner_message')).toBe(true);
  });

  it('T-CMD-02 report shows only platform numbers and says when data is missing', async () => {
    h = await harness();
    await h.say(P.owner, 'report');
    expect(h.last(P.owner)).toMatch(/koi post live nahi/);
    await h.tap(P.owner, await h.toApproval());
    await h.say(P.owner, 'report');
    expect(h.last(P.owner)).toMatch(/120 views, 14 likes, 3 comments/);
    h.social.fault = 'metrics_missing';
    await h.say(P.owner, 'report');
    expect(h.last(P.owner)).toMatch(/views: data nahi mila/);
    expect((await h.sys(`SELECT source FROM metric_snapshots`)).length).toBe(2);
  });

  it('T-CMD-03 viewers can read reports but cannot upload or run owner commands', async () => {
    h = await harness();
    await h.media(P.viewer);
    expect(h.last(P.viewer)).toMatch(/upload ka access nahi/);
    await h.say(P.viewer, 'pause');
    expect(h.last(P.viewer)).toMatch(/sirf dekhne/);
    await h.say(P.viewer, 'status');
    expect(h.last(P.viewer)).toMatch(/Status: chalu/);
    await h.say(P.editor, 'pause');
    expect(h.last(P.editor)).toMatch(/sirf owner/);
  });

  it('T-CMD-04 an editor can upload; the approval goes to the owner; both are told when live', async () => {
    h = await harness();
    await h.media(P.editor, { caption: 'Naya stock' });
    await h.tap(P.editor, `c:${(await h.task()).id}:n`);
    // The owner has not written in 24h, so the card is held; it goes out as soon as the owner writes.
    expect(h.msgs(P.owner)).toHaveLength(0);
    expect((await h.sys(`SELECT COUNT(*)::int n FROM outbound_messages WHERE status='blocked_window'`))[0].n).toBe(1);
    await h.say(P.owner, 'status');
    expect(h.texts(P.owner).join('\n')).toMatch(/publish karni hai/);
    await h.say(P.owner, 'status');
    expect(h.texts(P.owner).filter((t) => /publish karni hai/.test(t))).toHaveLength(1);
    await h.tap(P.owner, h.findButton(P.owner, 'a:'));
    expect(h.last(P.owner)).toMatch(/Live ho gaya/);
    expect(h.last(P.editor)).toMatch(/Live ho gaya/);
  });

  it('T-CMD-05 secrets typed in chat are refused and never stored', async () => {
    h = await harness();
    await h.say(P.owner, 'mera OTP 482913 hai');
    expect(h.last(P.owner)).toMatch(/OTP ya card number chat mein na bhejein/);
    expect(JSON.stringify(await h.sys('SELECT * FROM inbound_events'))).not.toContain('482913');
  });

  it('T-CMD-06 pause blocks everything except resume; resume restores', async () => {
    h = await harness();
    await h.say(P.owner, 'pause');
    expect(h.last(P.owner)).toMatch(/pause kar diya/);
    await h.media(P.owner, { caption: 'x' });
    expect(h.last(P.owner)).toMatch(/paused/);
    expect(await h.task()).toBeUndefined();
    await h.say(P.owner, 'resume');
    expect(h.last(P.owner)).toMatch(/phir se chalu/);
  });

  it('T-CMD-07 forget erases memory and profile after confirmation', async () => {
    h = await harness({ onboarded: false });
    await h.say(P.owner, 'hi');
    for (let i = 0; i < 6; i++) await h.say(P.owner, 'answer ' + i);
    await h.say(P.owner, 'forget');
    await h.tap(P.owner, 'f:y');
    expect(h.last(P.owner)).toMatch(/Sab hata diya/);
    expect((await h.sys(`SELECT COUNT(*)::int n FROM memory_items WHERE deleted_at IS NULL`))[0].n).toBe(0);
    expect((await h.sys(`SELECT onboarded FROM workspaces WHERE id=$1`, [h.ws]))[0].onboarded).toBe(false);
  });

  it('T-CMD-08 export produces a one-time link to a gzip of this workspace only, without credentials', async () => {
    h = await harness({ secondWorkspace: true });
    await h.say(P.owner, 'export');
    const url = new URL(h.last(P.owner).match(/https?:\/\/\S+/)![0]);
    const r = await h.app.inject({ url: url.pathname + url.search });
    expect(r.statusCode).toBe(200);
    const data = JSON.parse(zlib.gunzipSync(r.rawPayload).toString());
    expect(data.tables.credentials).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain(P.owner2);
    expect(JSON.stringify(data)).not.toContain('enc_blob');
    expect((await h.app.inject({ url: url.pathname + url.search })).statusCode).toBe(410);
  });

  it('F30 delete needs typed confirmation and can be cancelled during the cooling period', async () => {
    h = await harness();
    await h.say(P.owner, 'delete');
    await h.say(P.owner, 'haan');
    expect(h.last(P.owner)).toMatch(/confirm nahi hua/);
    await h.say(P.owner, 'delete');
    await h.say(P.owner, 'DELETE');
    expect(h.last(P.owner)).toMatch(/7 din baad/);
    h.clock.advance(3 * DAY);
    await h.say(P.owner, 'cancel delete');
    expect(h.last(P.owner)).toMatch(/Delete roka gaya/);
    h.clock.advance(10 * DAY);
    await runScheduler(h.d);
    await h.drain();
    expect(await h.sys(`SELECT id FROM workspaces WHERE id=$1`, [h.ws])).toHaveLength(1);
  });

  it('F31 erase removes every row of workspace A, leaves B intact, keeps only anonymised audit', async () => {
    h = await harness({ secondWorkspace: true });
    await h.tap(P.owner, await h.toApproval());
    await h.say(P.owner, 'delete');
    await h.say(P.owner, 'DELETE');
    h.clock.advance(8 * DAY);
    await h.say(P.owner, 'status');
    await runScheduler(h.d);
    await h.drain();
    const tables = await h.db.system((tx) => workspaceTables(tx));
    for (const t of tables) expect((await h.sys(`SELECT COUNT(*)::int n FROM ${t} WHERE workspace_id=$1`, [h.ws]))[0].n, t).toBe(0);
    expect(await h.sys(`SELECT id FROM workspaces WHERE id=$1`, [h.ws2])).toHaveLength(1);
    const anon = await h.sys(`SELECT detail FROM audit WHERE workspace_id LIKE 'erased:%'`);
    expect(anon.length).toBeGreaterThan(0);
    expect(anon.every((r: any) => JSON.stringify(r.detail) === '{}')).toBe(true);
    expect(h.last(P.owner)).toMatch(/data hata diya gaya/);
    await h.say(P.owner, 'hi');
    expect(h.last(P.owner)).toMatch(/juda nahi/);
  });
});

describe('scheduler', () => {
  it('T-SCH-01 weekly digest and daily health checks run once per period even if ticked twice', async () => {
    h = await harness();
    await h.tap(P.owner, await h.toApproval());
    h.clock.set(new Date('2026-11-09T05:00:00Z'));
    await h.say(P.owner, 'status');
    await runScheduler(h.d);
    await runScheduler(h.d);
    await h.drain();
    const digests = h.texts(P.owner).filter((t) => /Is hafte ka summary/.test(t));
    expect(digests).toHaveLength(1);
    expect(digests[0]).toMatch(/data kam hai/);
    expect((await h.sys(`SELECT COUNT(*)::int n FROM jobs WHERE kind='health'`))[0].n).toBe(1);
  });

  it('T-SCH-02 an expired token found by the health check sends one reconnect link', async () => {
    h = await harness();
    h.social.fault = 'token_expired';
    await h.say(P.owner, 'status');
    await runScheduler(h.d);
    await h.drain();
    expect(h.texts(P.owner).filter((t) => /connection expire/.test(t))).toHaveLength(1);
    expect((await h.sys(`SELECT status FROM accounts`))[0].status).toBe('unhealthy');
  });

  it('T-SCH-03 assisted packages left unanswered for a week expire', async () => {
    h = await harness({ account: 'ig_personal' });
    await h.media(P.owner, { caption: 'x' });
    await h.tap(P.owner, `c:${(await h.task()).id}:n`);
    h.clock.advance(8 * DAY);
    await runScheduler(h.d);
    expect((await h.task()).state).toBe('cancelled');
  });
});

describe('model use and cost', () => {
  it('T-COST-01 routine commands make zero model calls; free text uses one, and a repeat hits the cache', async () => {
    h = await harness();
    for (const t of ['help', 'report', 'status']) await h.say(P.owner, t);
    expect((h.llm as any).calls).toHaveLength(0);
    await h.say(P.owner, 'mera reel daal do please');
    await h.say(P.owner, 'mera reel daal do please');
    expect((h.llm as any).calls).toHaveLength(1);
    expect(h.last(P.owner)).toMatch(/Video ya photo yahin bhejein/);
  });

  it('F23 a real model with no AI budget is never called; the owner is told plainly', async () => {
    const calls: unknown[] = [];
    h = await harness({ llm: { kind: 'live', complete: async (r) => { calls.push(r); return { text: '{}', inputTokens: 1, outputTokens: 1, measured: true }; } } });
    await h.say(P.owner, 'kuch bhi likho');
    expect(calls).toHaveLength(0);
    expect(h.last(P.owner)).toMatch(/AI limit/);
    await h.media(P.owner, { caption: 'Naya stock' });
    expect((await h.task()).state).toBe('need_caption');
    expect((await h.sys(`SELECT COUNT(*)::int n FROM audit WHERE event='ai_denied'`))[0].n).toBe(2);
  });

  it('F24 the daily AI budget stops model calls once spent, and failed calls count toward it', async () => {
    let n = 0;
    h = await harness({ llm: { kind: 'live', complete: async () => { n++; throw new Error('provider down'); } } });
    await h.sys(`UPDATE workspaces SET ai_daily_cap_minor=1 WHERE id=$1`, [h.ws]);
    for (let i = 0; i < 5; i++) await h.say(P.owner, 'free text number ' + i);
    expect(n).toBeLessThanOrEqual(1);
    const rows = await h.sys(`SELECT kind, priced, measured FROM usage_events`);
    expect(rows.every((r: any) => r.kind === 'llm_error' && r.priced === false && r.measured === false)).toBe(true);
  });

  it('T-COST-02 live-model usage rows carry provider-reported tokens and an INR cost', async () => {
    h = await harness({ llm: { kind: 'live', complete: async () => ({ text: '{"intent":"help","topic":null,"needs_clarification":null,"contains_secret":false}', inputTokens: 1000, outputTokens: 50, measured: true }) } });
    await h.sys(`UPDATE workspaces SET ai_daily_cap_minor=5000 WHERE id=$1`, [h.ws]);
    await h.say(P.owner, 'aap kya kya karte ho');
    const u = (await h.sys(`SELECT * FROM usage_events`))[0];
    expect(u).toMatchObject({ kind: 'llm', input_tokens: 1000, output_tokens: 50, priced: true, measured: true });
    expect(Number(u.cost_minor)).toBeGreaterThan(0);
    expect(h.last(P.owner)).toMatch(/Main ye kar sakta hoon/);
  });
});

export { HOUR };

describe('greetings', () => {
  it('T-CMD-09 greetings get a welcome without any model call; a new owner starts onboarding', async () => {
    h = await harness();
    for (const g of ['Hi', 'helo', 'Namaste']) { await h.say(P.editor, g); expect(h.last(P.editor)).toMatch(/Namaste! 🙏 Photo ya video bhejiye/); }
    expect((h.llm as any).calls).toHaveLength(0);
    await h.close();
    h = await harness({ onboarded: false });
    await h.say(P.owner, 'hello');
    expect(h.last(P.owner)).toMatch(/1\) Aapka kaam/);
  });
});

describe('conversation', () => {
  const liveChat = (fn: (user: any) => Record<string, unknown>) => {
    const calls: any[] = [];
    return { calls, llm: { kind: 'live' as const, complete: async (r: any) => { const u = JSON.parse(r.user); calls.push(u); return { text: JSON.stringify(fn(u)), inputTokens: 300, outputTokens: 60, measured: true }; } } };
  };

  it('T-CHAT-01 with a real model, free text gets a natural reply and the next turn sees the history', async () => {
    const m = liveChat((u) => ({ intent: 'other', topic: null, needs_clarification: null, contains_secret: false, reply: u.history.length ? 'Haan, Diwali ke liye mithai thali wali reel badhiya rahegi. Video bhejiye!' : 'Namaste! Diwali ke liye 3 idea: 1) mithai banne ka process 2) gift box 3) customer ki muskaan. Kaunsa pasand aaya?' }));
    h = await harness({ llm: m.llm });
    await h.sys(`UPDATE workspaces SET ai_daily_cap_minor=5000 WHERE id=$1`, [h.ws]);
    await h.say(P.owner, 'diwali ke liye kya post karun?');
    expect(h.last(P.owner)).toMatch(/3 idea/);
    await h.say(P.owner, 'gift box wala achha laga');
    expect(h.last(P.owner)).toMatch(/Video bhejiye/);
    expect(m.calls[1].history).toEqual([{ role: 'user', text: 'diwali ke liye kya post karun?' }, { role: 'assistant', text: expect.stringMatching(/3 idea/) }]);
    expect(m.calls[1].workspace_context.business).toBe('Mithai shop');
  });

  it('T-CHAT-02 an action intent still runs the action, after the model\'s own reply', async () => {
    const m = liveChat(() => ({ intent: 'report', topic: null, needs_clarification: null, contains_secret: false, reply: 'Abhi dikhata hoon.' }));
    h = await harness({ llm: m.llm });
    await h.sys(`UPDATE workspaces SET ai_daily_cap_minor=5000 WHERE id=$1`, [h.ws]);
    await h.say(P.owner, 'mere posts kaise chal rahe hain yaar');
    const t = h.texts(P.owner);
    expect(t).toContain('Abhi dikhata hoon.');
    expect(t.join('\n')).toMatch(/koi post live nahi/);
  });

  it('T-CHAT-03 when the model cannot help, the bot says it did not understand', async () => {
    h = await harness();
    await h.say(P.owner, 'aaj mausam kaisa hai');
    expect(h.last(P.owner)).toMatch(/Samajh nahi aaya/);
  });

  it('T-CHAT-04 forget clears the chat history', async () => {
    const m = liveChat(() => ({ intent: 'other', topic: null, needs_clarification: null, contains_secret: false, reply: 'Theek hai!' }));
    h = await harness({ llm: m.llm });
    await h.sys(`UPDATE workspaces SET ai_daily_cap_minor=5000 WHERE id=$1`, [h.ws]);
    await h.say(P.owner, 'kuch baat karte hain');
    expect((await h.sys(`SELECT history FROM conversations WHERE phone=$1`, [P.owner]))[0].history).toHaveLength(2);
    await h.say(P.owner, 'forget');
    await h.tap(P.owner, 'f:y');
    expect((await h.sys(`SELECT history FROM conversations WHERE phone=$1`, [P.owner]))[0].history).toEqual([]);
  });
});
