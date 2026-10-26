import type { Db, Tx } from '../db/db';
import type { Clock } from '../lib/clock';
import type { Logger } from '../lib/log';
import { AppError, errClass } from '../lib/errors';
import { newId } from '../lib/ids';

export interface Job { id: string; workspace_id: string | null; kind: string; payload: Record<string, unknown>; attempts: number; max_attempts: number }
export interface Handler { run(job: Job): Promise<void>; leaseMs?: number; onDead?(job: Job, err: unknown): Promise<void> }

export interface EnqueueOpts { workspaceId?: string | null; dedupeKey?: string; delayMs?: number; maxAttempts?: number }

/** Insert inside the caller's transaction so the job exists only if the business change commits. */
export async function enqueue(tx: Tx, clock: Clock, kind: string, payload: Record<string, unknown>, o: EnqueueOpts = {}): Promise<void> {
  await tx.q(
    `INSERT INTO jobs(id, workspace_id, kind, payload, dedupe_key, run_at, max_attempts)
     VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (dedupe_key) DO NOTHING`,
    [newId('job'), o.workspaceId ?? null, kind, payload, o.dedupeKey ?? null, new Date(clock.now().getTime() + (o.delayMs ?? 0)), o.maxAttempts ?? 5],
  );
}

/** Postgres queue: SKIP LOCKED claims, leases for crash recovery, exponential backoff, dead-letter. */
export class Queue {
  private handlers = new Map<string, Handler>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  constructor(private db: Db, private clock: Clock, private log: Logger) {}

  on(kind: string, h: Handler): void { this.handlers.set(kind, h); }

  async claim(): Promise<Job | null> {
    const now = this.clock.now();
    return this.db.system(async (tx) => {
      const j = await tx.one<Job & { kind: string }>(
        `SELECT * FROM jobs WHERE (status='queued' AND run_at <= $1) OR (status='running' AND lease_until < $1)
         ORDER BY run_at, created_at LIMIT 1 FOR UPDATE SKIP LOCKED`, [now]);
      if (!j) return null;
      const lease = this.handlers.get(j.kind)?.leaseMs ?? 60_000;
      await tx.q(`UPDATE jobs SET status='running', attempts=attempts+1, lease_until=$2 WHERE id=$1`, [j.id, new Date(now.getTime() + lease)]);
      return { ...j, attempts: j.attempts + 1 };
    });
  }

  async runOne(): Promise<boolean> {
    const job = await this.claim();
    if (!job) return false;
    const h = this.handlers.get(job.kind);
    try {
      if (!h) throw new AppError('no_handler', 'permanent', `no handler for ${job.kind}`);
      await h.run(job);
      await this.db.system((tx) => tx.q(`UPDATE jobs SET status='done', lease_until=NULL, last_error=NULL WHERE id=$1`, [job.id]));
    } catch (e) {
      const cls = errClass(e);
      const msg = (e as Error).message ?? String(e);
      const final = cls === 'permanent' || cls === 'definitive' || job.attempts >= job.max_attempts;
      if (final) {
        await this.db.system(async (tx) => {
          await tx.q(`UPDATE jobs SET status='dead', last_error=$2, lease_until=NULL WHERE id=$1`, [job.id, msg]);
          await tx.q(`INSERT INTO audit(workspace_id, actor, event, detail) VALUES($1,'system','job_dead',$2)`, [job.workspace_id, { job: job.id, kind: job.kind, error: msg }]);
        });
        this.log.warn('job_dead', { job: job.id, kind: job.kind, error: msg });
        if (h?.onDead) await h.onDead(job, e).catch((err) => this.log.error('on_dead_failed', { job: job.id, error: String(err) }));
      } else {
        const backoff = Math.min(30 * 60_000, 1000 * 2 ** job.attempts);
        await this.db.system((tx) => tx.q(`UPDATE jobs SET status='queued', run_at=$2, last_error=$3, lease_until=NULL WHERE id=$1`,
          [job.id, new Date(this.clock.now().getTime() + backoff), msg]));
        this.log.info('job_retry', { job: job.id, kind: job.kind, attempt: job.attempts, error: msg });
      }
    }
    return true;
  }

  /** Run until no job is due. Tests use this instead of the timer. */
  async drain(max = 500): Promise<number> {
    let n = 0;
    while (n < max && (await this.runOne())) n++;
    return n;
  }

  start(intervalMs = 150): void {
    this.timer = setInterval(async () => {
      if (this.busy) return;
      this.busy = true;
      try { await this.drain(50); } catch (e) { this.log.error('worker_error', { error: String(e) }); } finally { this.busy = false; }
    }, intervalMs);
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
