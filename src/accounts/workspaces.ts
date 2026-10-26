import type { Db, Tx } from '../db/db';
import { AppError } from '../lib/errors';
import { newId } from '../lib/ids';
import { capabilityFor } from './matrix';

/** WhatsApp numbers (E.164 digits) or browser-chat session ids. */
export const PHONE = /^(\d{8,15}|w[0-9a-f]{16})$/;

export async function createWorkspace(db: Db, a: { name: string; kind: 'personal' | 'creator' | 'business'; ownerPhone: string; aiDailyBudgetMinor?: number | null; id?: string }): Promise<string> {
  if (!PHONE.test(a.ownerPhone)) throw new AppError('invalid_phone', 'permanent');
  const id = a.id ?? newId('ws');
  await db.system(async (tx) => {
    if (await tx.one('SELECT 1 FROM members WHERE phone=$1', [a.ownerPhone])) throw new AppError('phone_already_bound', 'permanent');
    await tx.q(`INSERT INTO workspaces(id, name, kind, ai_daily_cap_minor) VALUES($1,$2,$3,$4)`, [id, a.name.slice(0, 120), a.kind, a.aiDailyBudgetMinor ?? null]);
    await tx.q(`INSERT INTO members(phone, workspace_id, role, name) VALUES($1,$2,'owner',$3)`, [a.ownerPhone, id, 'Owner']);
    await tx.q(`INSERT INTO audit(workspace_id, actor, event, detail) VALUES($1,'operator','workspace_created',$2)`, [id, { kind: a.kind }]);
  });
  return id;
}

/** A phone belongs to exactly one workspace; re-binding is refused rather than silently moved. */
export async function addMember(db: Db, workspaceId: string, phone: string, role: 'owner' | 'editor' | 'viewer'): Promise<void> {
  if (!PHONE.test(phone)) throw new AppError('invalid_phone', 'permanent');
  await db.system(async (tx) => {
    const existing = await tx.one<{ workspace_id: string }>('SELECT workspace_id FROM members WHERE phone=$1', [phone]);
    if (existing && existing.workspace_id !== workspaceId) throw new AppError('phone_already_bound', 'permanent');
    await tx.q(`INSERT INTO members(phone, workspace_id, role) VALUES($1,$2,$3) ON CONFLICT (phone) DO UPDATE SET role=excluded.role`, [phone, workspaceId, role]);
    await tx.q(`INSERT INTO audit(workspace_id, actor, event, detail) VALUES($1,'operator','member_set',$2)`, [workspaceId, { role }]);
  });
}

export async function connectAccount(tx: Tx, a: { workspaceId: string; platform: string; surface: string; accountType: string; externalId: string; label?: string }): Promise<{ id: string; route: string }> {
  const cap = capabilityFor(a.platform, a.surface, a.accountType);
  const existing = await tx.one<{ id: string }>('SELECT id FROM accounts WHERE platform=$1 AND external_id=$2', [a.platform, a.externalId]);
  const id = existing?.id ?? newId('acct');
  await tx.q(`INSERT INTO accounts(id, workspace_id, platform, surface, account_type, route, status, external_id, label)
    VALUES($1,$2,$3,$4,$5,$6,'connected',$7,$8)
    ON CONFLICT (id) DO UPDATE SET status='connected', account_type=excluded.account_type, route=excluded.route, label=excluded.label`,
    [id, a.workspaceId, a.platform, a.surface, a.accountType, cap.route, a.externalId, a.label ?? null]);
  await tx.q(`INSERT INTO audit(workspace_id, actor, event, detail) VALUES($1,'system','account_connected',$2)`, [a.workspaceId, { platform: a.platform, surface: a.surface, route: cap.route }]);
  return { id, route: cap.route };
}
