import fs from 'node:fs';
import path from 'node:path';
import type { Tx } from '../db/db';
import { newId } from '../lib/ids';

interface ModelPrice { usd_per_mtok_in: number | null; usd_per_mtok_out: number | null }
interface Prices { fx: { USD_INR: number }; models: Record<string, ModelPrice> }

export const PRICES: Prices = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../config/prices.json'), 'utf8'));

/** Cost in paise, or null when the model is unpriced. Never returns 0 for an unknown price. */
export function costMinor(model: string, inTok: number, outTok: number, prices: Prices = PRICES): number | null {
  const p = prices.models[model];
  if (!p || p.usd_per_mtok_in == null || p.usd_per_mtok_out == null) return null;
  const usd = (inTok * p.usd_per_mtok_in + outTok * p.usd_per_mtok_out) / 1e6;
  return Math.ceil(usd * prices.fx.USD_INR * 100);
}

/** Rough token estimate (chars/3) for admission only; billed numbers come from provider-reported usage. */
export const estimateTokens = (s: string): number => Math.ceil(s.length / 3);

export async function spentTodayMinor(tx: Tx, now: Date): Promise<number> {
  const r = await tx.one<{ s: string }>(`SELECT COALESCE(SUM(cost_minor),0) s FROM usage_events WHERE created_at > $1`, [new Date(now.getTime() - 24 * 3600_000)]);
  return Number(r?.s ?? 0);
}

export type Admission = { ok: true } | { ok: false; reason: 'no_ai_budget' | 'ai_disabled' | 'unpriced_model' | 'budget_exhausted' };

/** Fails closed: a real model with no budget or no price is never called. Fake models are free. */
export async function admit(tx: Tx, a: { fakeModel: boolean; capMinor: number | null; estimateMinor: number | null; now: Date }): Promise<Admission> {
  if (a.fakeModel) return { ok: true };
  if (a.capMinor == null) return { ok: false, reason: 'no_ai_budget' };
  if (a.capMinor <= 0) return { ok: false, reason: 'ai_disabled' };
  if (a.estimateMinor == null) return { ok: false, reason: 'unpriced_model' };
  if ((await spentTodayMinor(tx, a.now)) + a.estimateMinor > a.capMinor) return { ok: false, reason: 'budget_exhausted' };
  return { ok: true };
}

export async function recordUsage(tx: Tx, u: { workspaceId: string; kind: string; item: string; inTok: number; outTok: number; costMinor: number | null; measured: boolean; unknownOutcome?: boolean; now: Date }): Promise<void> {
  await tx.q(`INSERT INTO usage_events(id, workspace_id, kind, item, input_tokens, output_tokens, cost_minor, priced, measured, created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [newId('use'), u.workspaceId, u.kind, u.item, u.inTok, u.outTok, u.costMinor, u.costMinor != null && !u.unknownOutcome, u.measured, u.now]);
}

export async function costReport(tx: Tx): Promise<{ pricedMinor: number; unpricedEvents: number; measuredEvents: number; events: number }> {
  const r = await tx.one<{ priced: string; unpriced: string; measured: string; n: string }>(
    `SELECT COALESCE(SUM(cost_minor) FILTER (WHERE priced),0) priced, COUNT(*) FILTER (WHERE NOT priced) unpriced, COUNT(*) FILTER (WHERE measured) measured, COUNT(*) n FROM usage_events`);
  return { pricedMinor: Number(r?.priced ?? 0), unpricedEvents: Number(r?.unpriced ?? 0), measuredEvents: Number(r?.measured ?? 0), events: Number(r?.n ?? 0) };
}
