import { createHmac, randomBytes } from 'node:crypto';
import type { Logger } from '../lib/log';
import { AppError } from '../lib/errors';
import { canonical } from '../policy/approvals';

export type Access = 'read' | 'write_owner' | 'write_public' | 'model';
export interface ToolDef { access: Access; needsApproval: boolean; roles: string[]; timeoutMs: number }

/** Tool registry: who may call what, whether an approval id is required, and how long a call may take. */
export const TOOLS: Record<string, ToolDef> = {
  'wa.send': { access: 'write_owner', needsApproval: false, roles: ['messenger'], timeoutMs: 15_000 },
  'wa.media': { access: 'read', needsApproval: false, roles: ['ingest'], timeoutMs: 60_000 },
  'social.publish': { access: 'write_public', needsApproval: true, roles: ['publisher'], timeoutMs: 120_000 },
  'social.find': { access: 'read', needsApproval: false, roles: ['publisher'], timeoutMs: 30_000 },
  'social.readback': { access: 'read', needsApproval: false, roles: ['publisher', 'analyst'], timeoutMs: 30_000 },
  'social.metrics': { access: 'read', needsApproval: false, roles: ['analyst'], timeoutMs: 30_000 },
  'social.check': { access: 'read', needsApproval: false, roles: ['health'], timeoutMs: 30_000 },
  'social.info': { access: 'read', needsApproval: false, roles: ['analyst'], timeoutMs: 30_000 },
  'lookup.public': { access: 'read', needsApproval: false, roles: ['analyst'], timeoutMs: 30_000 },
  'llm.complete': { access: 'model', needsApproval: false, roles: ['skills'], timeoutMs: 60_000 },
};

export interface Receipt { tool: string; receipt: string }

/** Single path to every adapter: authorize, enforce timeout, sign a receipt, log without secrets. */
export class Gateway {
  private key = randomBytes(32);
  constructor(private log: Logger) {}

  authorize(role: string, tool: string, approvalId?: string): void {
    const t = TOOLS[tool];
    if (!t) throw new AppError('unknown_tool', 'permanent', tool);
    if (!t.roles.includes(role)) throw new AppError('tool_not_allowed', 'permanent', `${role} may not call ${tool}`);
    if (t.needsApproval && !approvalId) throw new AppError('approval_required', 'permanent', tool);
  }

  async call<T>(role: string, tool: string, meta: { workspaceId: string | null; approvalId?: string; args?: unknown }, fn: () => Promise<T>): Promise<T> {
    this.authorize(role, tool, meta.approvalId);
    const t = TOOLS[tool]!;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new AppError('timeout', 'ambiguous', `${tool} timed out`)), t.timeoutMs); });
    const started = Date.now();
    try {
      const res = await Promise.race([fn(), timeout]);
      this.log.info('tool_call', { tool, role, ws: meta.workspaceId, ms: Date.now() - started, ok: true });
      return res;
    } catch (e) {
      this.log.warn('tool_call', { tool, role, ws: meta.workspaceId, ms: Date.now() - started, ok: false, error: (e as Error).message });
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  receipt(tool: string, args: unknown, result: unknown): string {
    const body = `${tool}.${canonical(args ?? null)}.${canonical(result ?? null)}`;
    return createHmac('sha256', this.key).update(body).digest('base64url');
  }

  verifyReceipt(r: string, tool: string, args: unknown, result: unknown): boolean {
    return r === this.receipt(tool, args, result);
  }
}

/** fetch wrapper that only allows https calls to listed hosts. Live adapters receive this instead of global fetch. */
export function guardedFetch(hosts: string[], base: typeof fetch = fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.protocol !== 'https:' || !hosts.includes(url.hostname)) throw new AppError('egress_denied', 'permanent', url.hostname);
    return base(input, init);
  }) as typeof fetch;
}
