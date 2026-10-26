import Anthropic from '@anthropic-ai/sdk';
import { AppError } from '../lib/errors';
import type { LlmPort, LlmRequest, LlmResult } from '../ports';

/** Scripted model for tests and sim: a function from request to text. Never "measured". */
export class FakeLlm implements LlmPort {
  readonly kind = 'fake' as const;
  calls: LlmRequest[] = [];
  fail: 'none' | 'error' | 'junk' = 'none';
  constructor(public script: (req: LlmRequest) => string = defaultScript) {}
  async complete(req: LlmRequest): Promise<LlmResult> {
    this.calls.push(req);
    if (this.fail === 'error') throw new AppError('llm_down', 'ambiguous');
    const text = this.fail === 'junk' ? 'not json at all' : this.script(req);
    return { text, inputTokens: Math.ceil((req.system.length + req.user.length) / 3), outputTokens: Math.ceil(text.length / 3), measured: false };
  }
}

/** Deterministic stand-in: keyword intent and a caption that only reuses the owner's words. */
export function defaultScript(req: LlmRequest): string {
  const input = JSON.parse(req.user) as { skill: string; message?: string; topic?: string };
  if (input.skill === 'intent') {
    const t = (input.message ?? '').toLowerCase();
    const intent = /report|views|result|kitna/.test(t) ? 'report' : /post|reel|daal|upload|photo|video/.test(t) ? 'new_post' : /ad\b|ads|promote|boost/.test(t) ? 'ad_request' : 'other';
    return JSON.stringify({ intent, topic: intent === 'new_post' ? input.message : null, needs_clarification: null, contains_secret: /otp|password|pin\b/.test(t) });
  }
  if (input.skill === 'caption') {
    const topic = (input.topic ?? '').trim();
    return JSON.stringify({ caption: `${topic} 👇\nAaiye, milte hain!`, hashtags: ['#local', '#india'], claims: [], missing_facts: [], people_question_needed: false, banned_claim_hits: [] });
  }
  return '{}';
}

export class AnthropicLlm implements LlmPort {
  readonly kind = 'live' as const;
  private client: Anthropic;
  constructor(apiKey: string, fetchImpl?: typeof fetch) {
    this.client = new Anthropic({ apiKey, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  }
  async complete(req: LlmRequest): Promise<LlmResult> {
    try {
      const r = await this.client.messages.create({
        model: req.model,
        max_tokens: req.maxTokens,
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: req.user }],
      });
      const text = r.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      return { text, inputTokens: r.usage.input_tokens + (r.usage.cache_read_input_tokens ?? 0) + (r.usage.cache_creation_input_tokens ?? 0), outputTokens: r.usage.output_tokens, measured: true };
    } catch (e) {
      const status = (e as { status?: number }).status;
      throw new AppError(`llm_${status ?? 'error'}`, status && status >= 400 && status < 500 && status !== 429 ? 'definitive' : 'ambiguous', (e as Error).message);
    }
  }
}
