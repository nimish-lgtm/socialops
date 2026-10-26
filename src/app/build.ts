import type { Config } from '../config';
import { Db, roleUrl } from '../db/db';
import { systemClock, type Clock } from '../lib/clock';
import { createLogger, type Logger } from '../lib/log';
import type { LlmPort, MediaInspector, SocialPort, WhatsAppPort } from '../ports';
import { FakeWhatsApp } from '../adapters/fake-whatsapp';
import { CloudWhatsApp } from '../adapters/cloud-whatsapp';
import { FakeSocial } from '../adapters/fake-social';
import { MetaSocial } from '../adapters/meta-social';
import { AnthropicLlm, FakeLlm } from '../adapters/llm';
import { DiskStorage, FfprobeInspector } from '../adapters/storage';
import { Gateway, guardedFetch } from '../core/gateway';
import { Messenger } from '../core/messenger';
import { Engine } from '../core/engine';
import { Queue } from '../core/queue';
import { Credentials } from '../security/credentials';
import { Links } from '../security/links';
import { Skills } from '../skills/skills';
import { WORKFLOWS } from '../workflows';
import { registerJobs } from '../jobs/handlers';
import type { Deps } from './deps';

export interface Overrides { clock?: Clock; log?: Logger; wa?: WhatsAppPort; social?: SocialPort; llm?: LlmPort; inspector?: MediaInspector; db?: Db }

/** Refuse unsafe adapter combinations: live never runs a fake; mock/sim never touch a real platform. */
export function preflight(mode: Config['mode'], a: { wa: WhatsAppPort; social: SocialPort; llm: LlmPort }): void {
  if (mode === 'live') {
    const fakes = Object.entries(a).filter(([, x]) => x.kind !== 'live').map(([k]) => k);
    if (fakes.length) throw new Error(`MODE=live refused: fake adapter(s): ${fakes.join(', ')}`);
  } else if (mode === 'hybrid') {
    if (a.wa.kind !== 'live') throw new Error('MODE=hybrid refused: WhatsApp must be live');
    if (a.social.kind !== 'fake') throw new Error('MODE=hybrid refused: social must be fake (nothing is published)');
  } else if (a.wa.kind !== 'fake' || a.social.kind !== 'fake') {
    throw new Error(`MODE=${mode} refused: WhatsApp and social must be fakes`);
  }
}

export function buildDeps(config: Config, o: Overrides = {}): Deps {
  const real = config.mode === 'hybrid' || config.mode === 'live';
  const log = o.log ?? createLogger(config.logLevel);
  const clock = o.clock ?? systemClock;
  const db = o.db ?? new Db(roleUrl(config.databaseUrl, 'socialops_app', config.dbRolePassword), roleUrl(config.databaseUrl, 'socialops_system', config.dbRolePassword));
  const wa = o.wa ?? (real ? new CloudWhatsApp(config.wa, guardedFetch(['graph.facebook.com', 'lookaside.fbsbx.com'])) : new FakeWhatsApp());
  const social = o.social ?? (config.mode === 'live' ? new MetaSocial({ version: config.meta.version, enabled: config.meta.publishEnabled }, guardedFetch(['graph.facebook.com'])) : new FakeSocial());
  const llm = o.llm ?? (config.llm.provider === 'anthropic' ? new AnthropicLlm(config.llm.apiKey, guardedFetch(['api.anthropic.com'])) : new FakeLlm());
  preflight(config.mode, { wa, social, llm });
  const gateway = new Gateway(log);
  const d = {
    config, db, clock, log, wa, social, llm, gateway,
    storage: new DiskStorage(config.storageDir),
    inspector: o.inspector ?? new FfprobeInspector(),
    messenger: new Messenger(db, clock, wa, gateway, log, config.mode === 'hybrid'),
    credentials: new Credentials(config.credentialKey),
    links: new Links(db, config.linkSecret, config.publicBaseUrl),
    queue: new Queue(db, clock, log),
  } as unknown as Deps;
  d.skills = new Skills(d);
  d.engine = new Engine(d, WORKFLOWS);
  registerJobs(d);
  return d;
}
