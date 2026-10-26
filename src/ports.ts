/** Adapter ports. Every external system sits behind one of these; fakes and live versions share them. */

export interface Button { id: string; title: string }
export type OutMessage =
  | { kind: 'text'; body: string }
  | { kind: 'buttons'; body: string; buttons: Button[] }
  | { kind: 'template'; name: string; lang: string; vars: string[] };

export interface WhatsAppPort {
  readonly kind: 'fake' | 'live';
  send(to: string, msg: OutMessage): Promise<{ waId: string }>;
  downloadMedia(mediaId: string): Promise<{ data: Buffer; mime: string }>;
}

export interface AccountRef {
  id: string;
  platform: string;
  surface: string;
  accountType: string;
  externalId: string | null;
}

export interface MediaRef { ref: string; mime: string; sha256: string; publicUrl: string }

export interface PublishResult { externalId: string; url: string | null }

export interface SocialPort {
  readonly kind: 'fake' | 'live';
  canPublish(account: AccountRef): boolean;
  publish(req: { account: AccountRef; media: MediaRef; caption: string; idempotencyKey: string; token: string }): Promise<PublishResult>;
  findByKey(req: { account: AccountRef; idempotencyKey: string; caption: string; token: string }): Promise<PublishResult | null>;
  readback(req: { account: AccountRef; externalId: string; token: string }): Promise<{ live: boolean; url: string | null; caption: string | null }>;
  metrics(req: { account: AccountRef; externalId: string; token: string }): Promise<Record<string, number | null>>;
  checkToken(req: { account: AccountRef; token: string }): Promise<'ok' | 'expired'>;
}

export interface LlmRequest { model: string; system: string; user: string; maxTokens: number }
export interface LlmResult { text: string; inputTokens: number; outputTokens: number; measured: boolean }
export interface LlmPort {
  readonly kind: 'fake' | 'live';
  complete(req: LlmRequest): Promise<LlmResult>;
}

export interface StoragePort {
  put(workspaceId: string, data: Buffer, mime: string): Promise<{ ref: string; sha256: string; bytes: number }>;
  get(ref: string): Promise<Buffer>;
  remove(ref: string): Promise<void>;
}

export interface MediaInspector {
  inspect(path: string, mime: string): Promise<{ durationS: number | null; width: number | null; height: number | null; hasAudio: boolean | null; skipped?: boolean }>;
}
