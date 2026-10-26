import type { Workflow } from '../core/engine';
import { copy } from '../copy';
import { newId } from '../lib/ids';
import { awaitAnswer, clearAwait } from './helpers';

const MEMORY_KIND: Record<string, string> = { business: 'business', offer: 'offer', audience: 'audience', tone: 'tone', banned: 'banned_claim', language: 'language', about: 'fact', goal: 'fact', niche: 'fact' };

/**
 * Onboarding as a conversation. Each owner answer goes to an onboard_turn job (Claude when configured,
 * else the fixed question list), which comes back as a "turn": the reply to send and the profile so far.
 */
export const onboardingWorkflow: Workflow = {
  name: 'onboarding',
  initial: 'thinking',
  states: {
    thinking: {
      on: { turn: 'asking', cancel: 'cancelled' },
      async enter(ctx) {
        const n = (ctx.task.data.turns ?? 0) + 1;
        const history = [...(ctx.task.data.history ?? [])];
        if (ctx.event === 'answer') history.push({ role: 'user', text: String(ctx.payload.text ?? '').trim().slice(0, 500) });
        ctx.set({ turns: n, history: history.slice(-20) });
        await ctx.enqueue('onboard_turn', { taskId: ctx.task.id }, { dedupeKey: `onb:${ctx.task.id}:${n}`, maxAttempts: 3 });
      },
    },
    asking: {
      on: { answer: 'thinking', finish: 'done', cancel: 'cancelled' },
      async enter(ctx) {
        const p = ctx.payload as { reply: string; profile: Record<string, string>; done: boolean; setKind?: string | null };
        const answers = { ...(ctx.task.data.answers ?? {}), ...p.profile };
        ctx.set({ answers, history: p.reply ? [...(ctx.task.data.history ?? []), { role: 'assistant', text: p.reply.slice(0, 500) }].slice(-20) : ctx.task.data.history });
        if (p.setKind && ['personal', 'creator', 'business'].includes(p.setKind) && p.setKind !== ctx.ws.kind) {
          await ctx.tx.q(`UPDATE workspaces SET kind=$2 WHERE id=$1`, [ctx.ws.id, p.setKind]);
          await ctx.audit('workspace_kind_changed', { from: ctx.ws.kind, to: p.setKind, by: 'owner_in_onboarding' });
          ctx.ws.kind = p.setKind;
        }
        await ctx.tx.q(`INSERT INTO profiles(workspace_id, answers, step) VALUES($1,$2,$3) ON CONFLICT (workspace_id) DO UPDATE SET answers=excluded.answers, step=excluded.step`, [ctx.ws.id, answers, Object.keys(answers).length]);
        const to = ctx.task.requested_by!;
        if (p.reply) await ctx.send(to, { kind: 'text', body: p.reply }, `onb:${ctx.task.id}:${ctx.task.data.turns}`);
        if (p.done) { ctx.set({ farewellSent: !!p.reply }); return ctx.emit('finish'); }
        await awaitAnswer(ctx.tx, to, ctx.task.id, 'answer');
      },
    },
    done: {
      terminal: true,
      async enter(ctx) {
        await clearAwait(ctx.tx, ctx.task.id);
        const answers = (ctx.task.data.answers ?? {}) as Record<string, string>;
        await ctx.tx.q(`UPDATE profiles SET completed_at=$2 WHERE workspace_id=$1`, [ctx.ws.id, ctx.now]);
        await ctx.tx.q(`UPDATE workspaces SET onboarded=true WHERE id=$1`, [ctx.ws.id]);
        for (const [k, v] of Object.entries(answers)) {
          if (!v || /^(kuch nahi|nahi|none|no)$/i.test(v)) continue;
          await ctx.tx.q(`INSERT INTO memory_items(id, workspace_id, kind, body, source, created_at) VALUES($1,$2,$3,$4,'owner_message',$5)`, [newId('mem'), ctx.ws.id, MEMORY_KIND[k] ?? 'fact', v, ctx.now]);
        }
        if (!ctx.task.data.farewellSent) await ctx.send(ctx.task.requested_by!, { kind: 'text', body: copy.onboardingDone }, `onb_done:${ctx.task.id}`);
      },
    },
    cancelled: { terminal: true, async enter(ctx) { await clearAwait(ctx.tx, ctx.task.id); } },
  },
};
