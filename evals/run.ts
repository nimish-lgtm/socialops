// Runs the intent and caption eval sets against the configured model and prints a pass rate per set.
// Usage: LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=... npm run eval   (fake model when LLM_PROVIDER=fake)
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, loadEnvFile } from '../src/config';
import { AnthropicLlm, FakeLlm } from '../src/adapters/llm';
import { CORE_PROMPT, CaptionOut, IntentOut, PROMPT_VERSION, bannedHits } from '../src/skills/skills';
import { costMinor } from '../src/core/cost';
import type { LlmPort } from '../src/ports';

loadEnvFile();
const cfg = loadConfig();
const llm: LlmPort = cfg.llm.provider === 'anthropic' ? new AnthropicLlm(cfg.llm.apiKey) : new FakeLlm();
const model = llm.kind === 'fake' ? 'fake' : cfg.llm.small;
const read = (f: string) => fs.readFileSync(path.join(import.meta.dirname, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const json = (s: string) => { try { return JSON.parse(s.match(/\{[\s\S]*\}/)?.[0] ?? 'null'); } catch { return null; } };
const numbers = (s: string) => s.match(/\d+/g) ?? [];
let tokensIn = 0, tokensOut = 0;

async function call(user: Record<string, unknown>) {
  const r = await llm.complete({ model, system: CORE_PROMPT, user: JSON.stringify(user), maxTokens: 700 });
  tokensIn += r.inputTokens; tokensOut += r.outputTokens;
  return json(r.text);
}

const results: Array<{ set: string; id: string; pass: boolean; why: string }> = [];

for (const c of read('intent.jsonl')) {
  const out = IntentOut.safeParse(await call({ skill: 'intent', message: c.message, workspace_kind: 'business' }));
  if (!out.success) { results.push({ set: 'intent', id: c.id, pass: false, why: 'invalid JSON' }); continue; }
  const okIntent = out.data.intent === c.expect;
  const okSecret = c.secret ? out.data.contains_secret : true;
  results.push({ set: 'intent', id: c.id, pass: okIntent && okSecret, why: okIntent ? (okSecret ? '' : 'secret not flagged') : `got ${out.data.intent}` });
}

for (const c of read('caption.jsonl')) {
  const out = CaptionOut.safeParse(await call({ skill: 'caption', topic: c.topic, workspace_kind: c.kind ?? 'business', workspace_context: c.profile }));
  if (!out.success) { results.push({ set: 'caption', id: c.id, pass: false, why: 'invalid JSON' }); continue; }
  const text = out.data.caption + ' ' + out.data.hashtags.join(' ');
  const allowed = new Set([...numbers(c.topic), ...numbers(JSON.stringify(c.profile))]);
  const invented = numbers(out.data.caption).filter((n) => !allowed.has(n));
  const banned = bannedHits(text, String(c.profile.banned ?? '').split(','));
  const missing = (c.must_include as string[]).filter((m) => !text.includes(m));
  const sales = c.no_sales && /\b(buy|order|discount|offer|sale|kharid|dm for price)\b/i.test(text);
  const script = c.lang === 'hi' ? /[ऀ-ॿ]/.test(out.data.caption) : true;
  const why = [invented.length && `invented numbers ${invented.join(',')}`, banned.length && `banned ${banned.join(',')}`, missing.length && `missing ${missing.join(',')}`, sales && 'sales push on personal', !script && 'wrong script'].filter(Boolean).join('; ');
  results.push({ set: 'caption', id: c.id, pass: !why, why });
}

for (const set of ['intent', 'caption']) {
  const r = results.filter((x) => x.set === set);
  const pass = r.filter((x) => x.pass).length;
  console.log(`\n${set}: ${pass}/${r.length} passed (${Math.round((pass / r.length) * 100)}%)`);
  for (const f of r.filter((x) => !x.pass)) console.log(`  FAIL ${f.id}: ${f.why}`);
}
const cost = costMinor(model, tokensIn, tokensOut);
console.log(`\nmodel=${model} prompt=v${PROMPT_VERSION} tokens in=${tokensIn} out=${tokensOut} cost=${cost == null ? 'unpriced' : '₹' + (cost / 100).toFixed(2)} (${llm.kind === 'fake' ? 'fake model: numbers are not meaningful' : 'provider-reported tokens'})`);
const failed = results.filter((x) => !x.pass).length;
process.exit(llm.kind === 'live' && failed / results.length > 0.1 ? 1 : 0);
