import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** AES-256-GCM envelope: iv(12) | tag(16) | ciphertext, base64. */
export function encrypt(plain: string, hexKey: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(hexKey, 'hex'), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function decrypt(b64: string, hexKey: string): string {
  const buf = Buffer.from(b64, 'base64');
  const d = createDecipheriv('aes-256-gcm', Buffer.from(hexKey, 'hex'), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

/** Meta webhook signature over the raw body. Returns false (never throws) for any malformed header. */
export function verifySignature(raw: Buffer, header: unknown, secret: string): boolean {
  if (!secret || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const got = header.slice(7);
  if (!/^[0-9a-f]{64}$/i.test(got)) return false;
  const want = createHmac('sha256', secret).update(raw).digest();
  return timingSafeEqual(Buffer.from(got, 'hex'), want);
}

export const signBody = (raw: Buffer | string, secret: string): string => 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
