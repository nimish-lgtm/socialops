import type { Tx } from '../db/db';
import type { AccountRef } from '../ports';

export async function owners(tx: Tx, workspaceId: string): Promise<string[]> {
  return (await tx.q<{ phone: string }>(`SELECT phone FROM members WHERE workspace_id=$1 AND role='owner' ORDER BY created_at`, [workspaceId])).map((r) => r.phone);
}

/** Point the next free-text message from this phone at a task event (e.g. the topic or caption answer). */
export async function awaitAnswer(tx: Tx, phone: string, taskId: string, event: string): Promise<void> {
  await tx.q(`UPDATE conversations SET state='awaiting', context=$2 WHERE phone=$1`, [phone, { taskId, event }]);
}

export async function clearAwait(tx: Tx, taskId: string): Promise<void> {
  await tx.q(`UPDATE conversations SET state='idle', context='{}' WHERE state='awaiting' AND context->>'taskId'=$1`, [taskId]);
}

export interface AccountRow { id: string; workspace_id: string; platform: string; surface: string; account_type: string; route: string; status: string; external_id: string | null; label: string | null }

export const accountRef = (a: AccountRow): AccountRef => ({ id: a.id, platform: a.platform, surface: a.surface, accountType: a.account_type, externalId: a.external_id });

export const platformLabel = (a: Pick<AccountRow, 'platform' | 'surface' | 'label'>): string =>
  `${a.platform === 'instagram' ? 'Instagram' : 'Facebook'}${a.surface === 'page' ? ' Page' : ''}${a.label ? ` (${a.label})` : ''}`;

export const fullCaption = (d: { caption?: string; hashtags?: string[] }): string =>
  [d.caption ?? '', (d.hashtags ?? []).join(' ')].filter(Boolean).join('\n');

/** The exact input publish will execute. The approval hash covers all of it, including the consent answer. */
export function publishPayload(d: Record<string, any>) {
  return {
    asset_sha256: d.assetSha ?? null,
    caption: fullCaption(d),
    account_id: d.accountId ?? null,
    platform: d.platform ?? null,
    route: d.route ?? null,
    audience: 'public',
    consent: d.consent ?? null,
    amount_minor: 0,
  };
}

export const CONSENT_EVENTS = ['none', 'others_ok', 'minors_or_unsure'] as const;
export type ConsentAnswer = (typeof CONSENT_EVENTS)[number];
