import type { Workflow } from '../core/engine';
import { copy, ONBOARDING_QUESTIONS } from '../copy';
import { newId } from '../lib/ids';
import { awaitAnswer, clearAwait } from './helpers';

const MEMORY_KIND: Record<string, string> = { business: 'business', offer: 'offer', audience: 'audience', tone: 'tone', banned: 'banned_claim', language: 'language' };

/** Six questions, one per message, resumable: each answer is stored before the next question is asked. */
export const onboardingWorkflow: Workflow = {
  name: 'onboarding',
  initial: 'asking',
  states: {
    asking: {
      on: { answer: 'asking', finish: 'done', cancel: 'cancelled' },
      async enter(ctx) {
        const answers = { ...(ctx.task.data.answers ?? {}) };
        let step = ctx.task.data.step ?? 0;
        if (ctx.event === 'answer') {
          const q = ONBOARDING_QUESTIONS[step];
          if (q) answers[q.key] = String(ctx.payload.text ?? '').trim().slice(0, 500);
          step += 1;
          await ctx.tx.q(`INSERT INTO profiles(workspace_id, answers, step) VALUES($1,$2,$3) ON CONFLICT (workspace_id) DO UPDATE SET answers=excluded.answers, step=excluded.step`, [ctx.ws.id, answers, step]);
        }
        ctx.set({ answers, step });
        const next = ONBOARDING_QUESTIONS[step];
        if (!next) return ctx.emit('finish');
        const to = ctx.task.requested_by!;
        await awaitAnswer(ctx.tx, to, ctx.task.id, 'answer');
        await ctx.send(to, { kind: 'text', body: next.ask }, `onb:${ctx.task.id}:${step}`);
      },
    },
    done: {
      terminal: true,
      async enter(ctx) {
        await clearAwait(ctx.tx, ctx.task.id);
        const answers = ctx.task.data.answers as Record<string, string>;
        await ctx.tx.q(`UPDATE profiles SET completed_at=$2 WHERE workspace_id=$1`, [ctx.ws.id, ctx.now]);
        await ctx.tx.q(`UPDATE workspaces SET onboarded=true WHERE id=$1`, [ctx.ws.id]);
        for (const [k, v] of Object.entries(answers)) {
          if (!v || /^(kuch nahi|nahi|none|no)$/i.test(v)) continue;
          await ctx.tx.q(`INSERT INTO memory_items(id, workspace_id, kind, body, source, created_at) VALUES($1,$2,$3,$4,'owner_message',$5)`, [newId('mem'), ctx.ws.id, MEMORY_KIND[k] ?? 'fact', v, ctx.now]);
        }
        await ctx.send(ctx.task.requested_by!, { kind: 'text', body: copy.onboardingDone }, `onb_done:${ctx.task.id}`);
      },
    },
    cancelled: { terminal: true, async enter(ctx) { await clearAwait(ctx.tx, ctx.task.id); } },
  },
};
