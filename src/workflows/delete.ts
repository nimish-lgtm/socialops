import type { Workflow } from '../core/engine';
import { copy } from '../copy';
import { DAY } from '../lib/clock';
import { awaitAnswer, clearAwait } from './helpers';

/** Owner-only erase: typed confirmation, cooling period with cancel, then an irreversible erase job. */
export const deleteWorkflow: Workflow = {
  name: 'delete_data',
  initial: 'requested',
  states: {
    requested: {
      on: { reply: 'confirming', cancel: 'cancelled' },
      async enter(ctx) {
        await awaitAnswer(ctx.tx, ctx.task.requested_by!, ctx.task.id, 'reply');
        await ctx.send(ctx.task.requested_by!, { kind: 'text', body: copy.deleteAsk(ctx.deps.config.deleteCoolingDays) }, `delask:${ctx.task.id}`);
      },
    },
    confirming: {
      on: { yes: 'cooling', no: 'cancelled' },
      async enter(ctx) {
        await clearAwait(ctx.tx, ctx.task.id);
        ctx.emit(String(ctx.payload.text ?? '').trim() === 'DELETE' ? 'yes' : 'no');
      },
    },
    cooling: {
      on: { cancel: 'cancelled', erase_due: 'erasing' },
      async enter(ctx) {
        ctx.set({ eraseAt: new Date(ctx.now.getTime() + ctx.deps.config.deleteCoolingDays * DAY).toISOString() });
        await ctx.send(ctx.task.requested_by!, { kind: 'text', body: copy.deleteScheduled(ctx.deps.config.deleteCoolingDays) }, `delsched:${ctx.task.id}`);
      },
    },
    erasing: {
      terminal: true,
      async enter(ctx) {
        await ctx.enqueue('erase_workspace', { workspaceId: ctx.ws.id }, { dedupeKey: `erase:${ctx.ws.id}`, maxAttempts: 3 });
      },
    },
    cancelled: {
      terminal: true,
      async enter(ctx) {
        await clearAwait(ctx.tx, ctx.task.id);
        await ctx.send(ctx.task.requested_by!, { kind: 'text', body: ctx.event === 'no' ? copy.deleteNotConfirmed : copy.deleteCancelled }, `delcancel:${ctx.task.id}`);
      },
    },
  },
};

