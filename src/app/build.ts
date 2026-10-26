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
import { WebChat } from '../adapters/webchat';
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

export interface Overrides { lookupFetch?: typeof fetch; clock?: Clock; log?: Logger; wa?: WhatsAppPort; social?: SocialPort; llm?: LlmPort; inspector?: MediaInspector; db?: Db }

/** Refuse unsafe adapter combinations: web and live never run a fake; mock (tests) never touches a real platform. */
export function preflight(mode: Config['mode'], a: { wa: WhatsAppPort; social: SocialPort; llm: LlmPort }): void {
  if (mode === 'live' || mode === 'web') {
    const want = mode === 'live' ? 'live' : 'web';
    if (a.wa.kind !== want) throw new Error(`MODE=${mode} refused: chat channel must be ${want}`);
    if (a.social.kind !== 'live') throw new Error(`MODE=${mode} refused: social adapter must be live`);
    if (a.llm.kind !== 'live') throw new Error(`MODE=${mode} refused: model must be live`);
  } else if (a.wa.kind === 'live' || a.social.kind === 'live') {
    throw new Error('MODE=mock refused: tests never use real WhatsApp or social platforms');
  }
}

export function buildDeps(config: Config, o: Overrides = {}): Deps {
  const log = o.log ?? createLogger(config.logLevel);
  const clock = o.clock ?? systemClock;
  const db = o.db ?? new Db(roleUrl(config.databaseUrl, 'socialops_app', config.dbRolePassword), roleUrl(config.databaseUrl, 'socialops_system', config.dbRolePassword));
  const storage = new DiskStorage(config.storageDir);
  const wa = o.wa ?? (config.mode === 'live' ? new CloudWhatsApp(config.wa, guardedFetch(['graph.facebook.com', 'lookaside.fbsbx.com'])) : config.mode === 'web' ? new WebChat(db, storage) : new FakeWhatsApp());
  const social = o.social ?? (config.mode === 'mock' ? new FakeSocial() : new MetaSocial({ version: config.meta.version, enabled: config.meta.publishEnabled }, guardedFetch(['graph.facebook.com'])));
  const llm = o.llm ?? (config.llm.provider === 'anthropic' ? new AnthropicLlm(config.llm.apiKey, guardedFetch(['api.anthropic.com'])) : new FakeLlm());
  preflight(config.mode, { wa, social, llm });
  const gateway = new Gateway(log);
  const d = {
    config, db, clock, log, wa, social, llm, gateway,
    storage,
    inspector: o.inspector ?? new FfprobeInspector(),
    messenger: new Messenger(db, clock, wa, gateway, log),
    credentials: new Credentials(config.credentialKey),
    links: new Links(db, config.linkSecret, config.publicBaseUrl),
    queue: new Queue(db, clock, log),
    lookupFetch: o.lookupFetch ?? guardedFetch(['graph.facebook.com', 'www.googleapis.com']),
  } as unknown as Deps;
  d.skills = new Skills(d);
  d.engine = new Engine(d, WORKFLOWS);
  registerJobs(d);
  return d;
}
