import type { Config } from '../config';
import type { Db } from '../db/db';
import type { Clock } from '../lib/clock';
import type { Logger } from '../lib/log';
import type { LlmPort, MediaInspector, SocialPort, StoragePort, WhatsAppPort } from '../ports';
import type { Gateway } from '../core/gateway';
import type { Messenger } from '../core/messenger';
import type { Engine } from '../core/engine';
import type { Queue } from '../core/queue';
import type { Credentials } from '../security/credentials';
import type { Links } from '../security/links';
import type { Skills } from '../skills/skills';
import type { DiskStorage } from '../adapters/storage';

export interface Deps {
  config: Config;
  db: Db;
  clock: Clock;
  log: Logger;
  wa: WhatsAppPort;
  social: SocialPort;
  llm: LlmPort;
  storage: StoragePort & Pick<DiskStorage, 'resolve' | 'removeWorkspace'>;
  inspector: MediaInspector;
  gateway: Gateway;
  messenger: Messenger;
  credentials: Credentials;
  links: Links;
  skills: Skills;
  engine: Engine;
  queue: Queue;
}
