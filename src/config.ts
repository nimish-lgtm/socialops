import fs from 'node:fs';
import { z } from 'zod';

export const MODES = ['mock', 'sim', 'hybrid', 'live'] as const;
export type Mode = (typeof MODES)[number];

const Env = z.object({
  MODE: z.enum(MODES).default('mock'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  DATABASE_URL: z.string().default('postgres://socialops_owner:dev@localhost:5432/socialops_dev'),
  DB_ROLE_PASSWORD: z.string().default('dev'),
  PUBLIC_BASE_URL: z.string().default('http://localhost:8080'),
  STORAGE_DIR: z.string().default('./data/media'),
  CREDENTIAL_KEY: z.string().default(''),
  LINK_SECRET: z.string().default(''),
  OPERATOR_TOKEN: z.string().default(''),
  WA_GRAPH_VERSION: z.string().default('v20.0'),
  WA_PHONE_NUMBER_ID: z.string().default(''),
  WA_ACCESS_TOKEN: z.string().default(''),
  WA_APP_SECRET: z.string().default(''),
  WA_VERIFY_TOKEN: z.string().default(''),
  META_APP_ID: z.string().default(''),
  META_APP_SECRET: z.string().default(''),
  META_GRAPH_VERSION: z.string().default('v20.0'),
  META_PUBLISH_ENABLED: z.enum(['true', 'false']).default('false'),
  LLM_PROVIDER: z.enum(['fake', 'anthropic']).default('fake'),
  ANTHROPIC_API_KEY: z.string().default(''),
  LLM_MODEL_SMALL: z.string().default('claude-haiku-5-5'),
  LLM_MODEL_LARGE: z.string().default('claude-sonnet-5-5'),
  AI_DAILY_BUDGET_INR: z.string().default(''),
  APPROVAL_TTL_HOURS: z.coerce.number().positive().default(24),
  DELETE_COOLING_DAYS: z.coerce.number().int().nonnegative().default(7),
});

export interface Config {
  mode: Mode;
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  databaseUrl: string;
  dbRolePassword: string;
  publicBaseUrl: string;
  storageDir: string;
  credentialKey: string;
  linkSecret: string;
  operatorToken: string;
  wa: { version: string; phoneNumberId: string; token: string; appSecret: string; verifyToken: string };
  meta: { appId: string; appSecret: string; version: string; publishEnabled: boolean };
  llm: { provider: 'fake' | 'anthropic'; apiKey: string; small: string; large: string };
  aiDailyBudgetMinor: number | null;
  approvalTtlHours: number;
  deleteCoolingDays: number;
}

const DEV_KEY = 'd'.repeat(64);

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const e = Env.parse(env);
  const budget = e.AI_DAILY_BUDGET_INR.trim() === '' ? null : Math.round(Number(e.AI_DAILY_BUDGET_INR) * 100);
  const dev = e.MODE === 'mock' || e.MODE === 'sim';
  return {
    mode: e.MODE,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    dbRolePassword: e.DB_ROLE_PASSWORD,
    publicBaseUrl: e.PUBLIC_BASE_URL.replace(/\/$/, ''),
    storageDir: e.STORAGE_DIR,
    credentialKey: e.CREDENTIAL_KEY || (dev ? DEV_KEY : ''),
    linkSecret: e.LINK_SECRET || (dev ? 'dev-link-secret' : ''),
    operatorToken: e.OPERATOR_TOKEN || (dev ? 'dev-operator' : ''),
    wa: { version: e.WA_GRAPH_VERSION, phoneNumberId: e.WA_PHONE_NUMBER_ID || (dev ? 'SIM_PNID' : ''), token: e.WA_ACCESS_TOKEN, appSecret: e.WA_APP_SECRET || (dev ? 'sim-app-secret' : ''), verifyToken: e.WA_VERIFY_TOKEN || (dev ? 'sim-verify' : '') },
    meta: { appId: e.META_APP_ID, appSecret: e.META_APP_SECRET, version: e.META_GRAPH_VERSION, publishEnabled: e.META_PUBLISH_ENABLED === 'true' },
    llm: { provider: e.LLM_PROVIDER, apiKey: e.ANTHROPIC_API_KEY, small: e.LLM_MODEL_SMALL, large: e.LLM_MODEL_LARGE },
    aiDailyBudgetMinor: budget !== null && Number.isFinite(budget) && budget >= 0 ? budget : null,
    approvalTtlHours: e.APPROVAL_TTL_HOURS,
    deleteCoolingDays: e.DELETE_COOLING_DAYS,
  };
}

/** Reads KEY=VALUE lines from a local .env without overriding real environment variables. */
export function loadEnvFile(file = '.env'): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = (m[2] ?? '').replace(/^"|"$/g, '');
  }
}

/** Secrets and settings each mode needs before it may start. Returns the list of problems. */
export function configProblems(c: Config): string[] {
  const p: string[] = [];
  const realWa = c.mode === 'hybrid' || c.mode === 'live';
  if (!/^[0-9a-f]{64}$/i.test(c.credentialKey)) p.push('CREDENTIAL_KEY must be 64 hex chars');
  if (!c.linkSecret) p.push('LINK_SECRET is required');
  if (!c.operatorToken) p.push('OPERATOR_TOKEN is required');
  if (realWa) {
    for (const [k, v] of Object.entries({ WA_PHONE_NUMBER_ID: c.wa.phoneNumberId, WA_ACCESS_TOKEN: c.wa.token, WA_APP_SECRET: c.wa.appSecret, WA_VERIFY_TOKEN: c.wa.verifyToken })) if (!v) p.push(`${k} is required in ${c.mode} mode`);
    if (c.dbRolePassword === 'dev') p.push('DB_ROLE_PASSWORD must not be the dev default');
    if (c.credentialKey === DEV_KEY) p.push('CREDENTIAL_KEY must not be the dev key');
  }
  if (c.llm.provider === 'anthropic' && !c.llm.apiKey) p.push('ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic');
  if (c.mode === 'live' && c.llm.provider !== 'anthropic') p.push('live mode needs LLM_PROVIDER=anthropic');
  if (c.mode === 'live' && (!c.meta.appId || !c.meta.appSecret)) p.push('META_APP_ID and META_APP_SECRET are required in live mode');
  return p;
}
