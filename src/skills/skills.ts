import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Deps } from '../app/deps';
import { admit, costMinor, estimateTokens, recordUsage } from '../core/cost';
import { canonical } from '../policy/approvals';
import { sha256 } from '../lib/ids';

export const CORE_PROMPT = fs.readFileSync(path.join(import.meta.dirname, 'prompts/core.md'), 'utf8');
export const PROMPT_VERSION = CORE_PROMPT.match(/v(\d+\.\d+\.\d+)/)?.[1] ?? '0.0.0';

export const IntentOut = z.object({
  intent: z.enum(['new_post', 'report', 'status', 'help', 'connect', 'other']).catch('other'),
  topic: z.string().max(500).nullable().catch(null),
  needs_clarification: z.string().max(300).nullable().catch(null),
  contains_secret: z.boolean().catch(false),
  reply: z.string().max(1200).nullable().catch(null).optional().transform((v) => v ?? null),
});
export type Intent = z.infer<typeof IntentOut>;
export interface ChatTurn { role: 'user' | 'assistant'; text: string }

export const CaptionOut = z.object({
  caption: z.string().min(1).max(1000),
  hashtags: z.array(z.string().max(40)).max(8).catch([]),
  claims: z.array(z.object({ text: z.string().max(200), type: z.string().max(20) })).max(20).catch([]),
  missing_facts: z.array(z.string().max(200)).max(10).catch([]),
  people_question_needed: z.boolean().catch(false),
  banned_claim_hits: z.array(z.string().max(200)).max(10).catch([]),
});
export type Caption = z.infer<typeof CaptionOut>;

export type SkillResult<T> = { ok: true; value: T } | { ok: false; reason: 'denied' | 'invalid' | 'error'; detail?: string };

const extractJson = (s: string): unknown => {
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
};

/** Every model call: cache, budget admission, gateway, usage row per attempt, schema validation, one retry. */
export class Skills {
  private cache = new Map<string, { at: number; value: unknown }>();
  constructor(private deps: Deps) {}

  async run<T>(workspaceId: string, skill: string, input: Record<string, unknown>, schema: z.ZodType<T>, tier: 'small' | 'large' = 'small'): Promise<SkillResult<T>> {
    const d = this.deps;
    const user = JSON.stringify({ skill, ...input });
    const cacheKey = sha256(workspaceId + '|' + PROMPT_VERSION + '|' + canonical({ skill, input }));
    const hit = this.cache.get(cacheKey);
    if (hit && d.clock.now().getTime() - hit.at < 3600_000) return { ok: true, value: hit.value as T };
    const fake = d.llm.kind === 'fake';
    const model = fake ? 'fake' : tier === 'small' ? d.config.llm.small : d.config.llm.large;
    const maxTokens = skill === 'caption' ? 700 : 500;
    for (let attempt = 0; attempt < 2; attempt++) {
      const now = d.clock.now();
      const est = costMinor(model, estimateTokens(CORE_PROMPT + user), maxTokens);
      const adm = await d.db.tenant(workspaceId, async (tx) => {
        const ws = await tx.one<{ ai_daily_cap_minor: string | null }>('SELECT ai_daily_cap_minor FROM workspaces WHERE id=$1', [workspaceId]);
        const cap = ws?.ai_daily_cap_minor != null ? Number(ws.ai_daily_cap_minor) : d.config.aiDailyBudgetMinor;
        const r = await admit(tx, { fakeModel: fake, capMinor: cap, estimateMinor: est, now });
        if (!r.ok) await tx.q(`INSERT INTO audit(workspace_id, actor, event, detail) VALUES($1,'system','ai_denied',$2)`, [workspaceId, { skill, reason: r.reason }]);
        return r;
      });
      if (!adm.ok) return { ok: false, reason: 'denied', detail: adm.reason };
      let res;
      try {
        res = await d.gateway.call('skills', 'llm.complete', { workspaceId }, () => d.llm.complete({ model, system: CORE_PROMPT, user, maxTokens }));
      } catch (e) {
        // A failed call may still be billed: record the estimate so it counts toward the cap, but flag it unpriced.
        await d.db.tenant(workspaceId, (tx) => recordUsage(tx, { workspaceId, kind: 'llm_error', item: `${skill}:${model}`, inTok: estimateTokens(CORE_PROMPT + user), outTok: 0, costMinor: est, measured: false, unknownOutcome: true, now }));
        return { ok: false, reason: 'error', detail: (e as Error).message };
      }
      await d.db.tenant(workspaceId, (tx) => recordUsage(tx, { workspaceId, kind: 'llm', item: `${skill}:${model}`, inTok: res.inputTokens, outTok: res.outputTokens, costMinor: costMinor(model, res.inputTokens, res.outputTokens), measured: res.measured, now }));
      const parsed = schema.safeParse(extractJson(res.text));
      if (parsed.success) {
        this.cache.set(cacheKey, { at: now.getTime(), value: parsed.data });
        return { ok: true, value: parsed.data };
      }
    }
    return { ok: false, reason: 'invalid' };
  }

  intent(workspaceId: string, message: string, kind: string, history: ChatTurn[] = [], profile: Record<string, unknown> = {}) {
    return this.run(workspaceId, 'intent', { message: message.slice(0, 1000), workspace_kind: kind, history, workspace_context: profile }, IntentOut);
  }

  caption(workspaceId: string, input: { topic: string; profile: Record<string, unknown>; kind: string; untrusted?: string[] }) {
    return this.run(workspaceId, 'caption', {
      topic: input.topic.slice(0, 1000),
      workspace_kind: input.kind,
      workspace_context: input.profile,
      ...(input.untrusted?.length ? { untrusted: input.untrusted.map((t) => `<untrusted_data>${t.replace(/</g, '&lt;')}</untrusted_data>`) } : {}),
    }, CaptionOut);
  }
}

const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december';
const CLAIM_PATTERNS: RegExp[] = [
  /(?:₹|rs\.?|inr)\s?\d[\d,]*(?:\.\d+)?/gi,
  /\d[\d,]*\s?(?:rupees?|rupay|rupaye|\/-)/gi,
  /\d{1,3}\s?%\s?(?:off|discount|chhoot)?/gi,
  new RegExp(`\\b\\d{1,2}\\s?(?:${MONTHS})\\b`, 'gi'),
  new RegExp(`\\b(?:${MONTHS})\\s?\\d{1,2}\\b`, 'gi'),
  /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g,
  /\b(?:guarantee[d]?|cure|100%|free|muft|best in|no\.? ?1|sabse sasta)\b/gi,
  /\+?\d[\d\s-]{8,}\d/g,
];

/** Deterministic claim detection for the approval card. Does not trust the model to list its own claims. */
export function detectClaims(text: string): string[] {
  const out = new Set<string>();
  for (const p of CLAIM_PATTERNS) for (const m of text.matchAll(p)) out.add(m[0].trim());
  return [...out].slice(0, 6);
}

export function bannedHits(text: string, banned: string[]): string[] {
  const t = text.toLowerCase();
  return banned.map((b) => b.trim()).filter((b) => b.length > 1 && t.includes(b.toLowerCase()));
}
