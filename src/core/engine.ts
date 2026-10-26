import type { Tx } from '../db/db';
import type { Deps } from '../app/deps';
import { newId } from '../lib/ids';
import { AppError } from '../lib/errors';
import type { OutMessage } from '../ports';
import { enqueue, type EnqueueOpts } from './queue';

export interface TaskRow { id: string; workspace_id: string; workflow: string; state: string; data: Record<string, any>; version: number; requested_by: string | null }
export interface WorkspaceRow { id: string; name: string; kind: string; status: string; tz: string; ai_daily_cap_minor: string | null; onboarded: boolean }

export interface Ctx {
  tx: Tx;
  deps: Deps;
  now: Date;
  task: TaskRow;
  ws: WorkspaceRow;
  event: string;
  payload: Record<string, any>;
  set(patch: Record<string, unknown>): void;
  emit(event: string, payload?: Record<string, unknown>): void;
  send(to: string, msg: OutMessage, key: string): Promise<void>;
  enqueue(kind: string, payload: Record<string, unknown>, opts?: EnqueueOpts): Promise<void>;
  audit(event: string, detail?: Record<string, unknown>): Promise<void>;
}

export interface StateDef {
  on?: Record<string, string>;
  terminal?: boolean;
  /** True when entering this state causes an external write; such states must be guarded by an approval. */
  externalWrite?: boolean;
  guard?: 'approval';
  enter?(ctx: Ctx): Promise<void>;
  exit?(ctx: Ctx, nextState: string): Promise<void>;
}
export interface Workflow { name: string; initial: string; states: Record<string, StateDef> }

/** Structural checks: declared targets, reachability, no dead ends, terminals without exits, guarded external writes. */
export function validateWorkflow(w: Workflow): string[] {
  const errs: string[] = [];
  const S = w.states;
  if (!S[w.initial]) errs.push(`${w.name}: initial ${w.initial} missing`);
  for (const [name, s] of Object.entries(S)) {
    const outs = Object.values(s.on ?? {});
    for (const t of outs) if (!S[t]) errs.push(`${w.name}: ${name} -> unknown ${t}`);
    if (s.terminal && outs.length) errs.push(`${w.name}: terminal ${name} has exits`);
    if (!s.terminal && !outs.length) errs.push(`${w.name}: dead end ${name}`);
    if (s.externalWrite && s.guard !== 'approval') errs.push(`${w.name}: ${name} writes externally without approval guard`);
  }
  const seen = new Set([w.initial]);
  const q = [w.initial];
  while (q.length) for (const t of Object.values(S[q.shift()!]?.on ?? {})) if (!seen.has(t)) { seen.add(t); q.push(t); }
  for (const name of Object.keys(S)) if (!seen.has(name)) errs.push(`${w.name}: unreachable ${name}`);
  if (!Object.entries(S).some(([n, s]) => s.terminal && seen.has(n))) errs.push(`${w.name}: no reachable terminal`);
  return errs;
}

export type DispatchResult = { ok: true; state: string } | { ok: false; reason: 'illegal_event' | 'not_found'; state?: string };

/** Runs workflows defined as data. Each dispatch is one transaction with the task row locked. */
export class Engine {
  private workflows = new Map<string, Workflow>();
  constructor(private deps: Deps, workflows: Workflow[]) {
    for (const w of workflows) {
      const errs = validateWorkflow(w);
      if (errs.length) throw new Error('invalid workflow: ' + errs.join('; '));
      this.workflows.set(w.name, w);
    }
  }

  workflow(name: string): Workflow {
    const w = this.workflows.get(name);
    if (!w) throw new AppError('unknown_workflow', 'permanent', name);
    return w;
  }

  async start(tx: Tx, workspaceId: string, workflow: string, data: Record<string, unknown>, requestedBy: string | null): Promise<string> {
    const w = this.workflow(workflow);
    const id = newId('task');
    await tx.q(`INSERT INTO tasks(id, workspace_id, workflow, state, data, requested_by, created_at, updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7)`,
      [id, workspaceId, workflow, w.initial, data, requestedBy, this.deps.clock.now()]);
    await this.transition(tx, id, null, {});
    return id;
  }

  /** Dispatch in a new transaction. */
  async dispatch(workspaceId: string, taskId: string, event: string, payload: Record<string, unknown> = {}): Promise<DispatchResult> {
    return this.deps.db.tenant(workspaceId, (tx) => this.dispatchIn(tx, taskId, event, payload));
  }

  /** Dispatch inside the caller's transaction (e.g. together with an approval decision). */
  async dispatchIn(tx: Tx, taskId: string, event: string, payload: Record<string, unknown> = {}): Promise<DispatchResult> {
    return this.transition(tx, taskId, event, payload);
  }

  private async transition(tx: Tx, taskId: string, firstEvent: string | null, firstPayload: Record<string, unknown>): Promise<DispatchResult> {
    const task = await tx.one<TaskRow>('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [taskId]);
    if (!task) return { ok: false, reason: 'not_found' };
    const ws = (await tx.one<WorkspaceRow>('SELECT * FROM workspaces WHERE id=$1', [task.workspace_id]))!;
    const w = this.workflow(task.workflow);
    let pending: { event: string; payload: Record<string, unknown> } | null = firstEvent ? { event: firstEvent, payload: firstPayload } : null;
    let enterOnly = firstEvent === null;
    for (let hop = 0; hop < 25; hop++) {
      const now = this.deps.clock.now();
      let target = task.state;
      let event = '__start';
      let payload: Record<string, any> = {};
      if (!enterOnly) {
        if (!pending) break;
        event = pending.event;
        payload = pending.payload;
        const next = w.states[task.state]?.on?.[event];
        if (!next) {
          if (hop === 0) {
            await this.audit(tx, task, 'transition_rejected', { state: task.state, event });
            return { ok: false, reason: 'illegal_event', state: task.state };
          }
          throw new Error(`workflow ${w.name}: event ${event} not allowed in ${task.state}`);
        }
        target = next;
      }
      pending = null;
      const ctx = this.ctx(tx, task, ws, event, payload, now, (e, p) => { pending = { event: e, payload: p ?? {} }; });
      if (!enterOnly) {
        await w.states[task.state]?.exit?.(ctx, target);
        await this.audit(tx, task, 'transition', { from: task.state, to: target, event });
        task.state = target;
      }
      enterOnly = false;
      await w.states[target]?.enter?.(ctx);
      task.version += 1;
      await tx.q(`UPDATE tasks SET state=$2, data=$3, version=$4, updated_at=$5 WHERE id=$1`, [task.id, task.state, task.data, task.version, now]);
      if (!pending) break;
    }
    return { ok: true, state: task.state };
  }

  private ctx(tx: Tx, task: TaskRow, ws: WorkspaceRow, event: string, payload: Record<string, any>, now: Date, emit: (e: string, p?: Record<string, unknown>) => void): Ctx {
    const deps = this.deps;
    return {
      tx, deps, now, task, ws, event, payload,
      set: (patch) => { task.data = { ...task.data, ...patch }; },
      emit,
      send: (to, msg, key) => deps.messenger.queue(tx, { workspaceId: ws.id, to, msg, key }),
      enqueue: (kind, p, opts) => enqueue(tx, deps.clock, kind, p, { workspaceId: ws.id, ...opts }),
      audit: (e, d) => this.audit(tx, task, e, d ?? {}),
    };
  }

  private async audit(tx: Tx, task: TaskRow, event: string, detail: Record<string, unknown>): Promise<void> {
    await tx.q(`INSERT INTO audit(workspace_id, actor, event, detail, at) VALUES($1,'system',$2,$3,$4)`,
      [task.workspace_id, event, { task: task.id, workflow: task.workflow, ...detail }, this.deps.clock.now()]);
  }
}
