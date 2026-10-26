import type { Tx } from '../db/db';
import { AppError } from '../lib/errors';
import { newId } from '../lib/ids';
import { decrypt, encrypt } from './crypto';

/**
 * The only module that decrypts platform tokens. Tokens are handed to an adapter call and never stored
 * elsewhere, logged, or shown to a model.
 */
export class Credentials {
  constructor(private key: string) {}

  async store(tx: Tx, a: { workspaceId: string; accountId: string; provider: string; token: string; expiresAt: Date | null }): Promise<void> {
    await tx.q(`INSERT INTO credentials(id, workspace_id, account_id, provider, enc_blob, expires_at, status)
      VALUES($1,$2,$3,$4,$5,$6,'active')
      ON CONFLICT (account_id) DO UPDATE SET enc_blob=excluded.enc_blob, expires_at=excluded.expires_at, status='active'`,
      [newId('cred'), a.workspaceId, a.accountId, a.provider, encrypt(a.token, this.key), a.expiresAt]);
  }

  async token(tx: Tx, accountId: string, now: Date): Promise<string> {
    const row = await tx.one<{ enc_blob: string; status: string; expires_at: Date | null }>('SELECT enc_blob, status, expires_at FROM credentials WHERE account_id=$1', [accountId]);
    if (!row || row.status !== 'active') throw new AppError('credential_missing', 'permanent');
    if (row.expires_at && new Date(row.expires_at).getTime() <= now.getTime()) throw new AppError('credential_expired', 'permanent');
    try {
      return decrypt(row.enc_blob, this.key);
    } catch {
      throw new AppError('credential_unreadable', 'permanent');
    }
  }

  async markExpired(tx: Tx, accountId: string): Promise<void> {
    await tx.q(`UPDATE credentials SET status='expired' WHERE account_id=$1`, [accountId]);
    await tx.q(`UPDATE accounts SET status='unhealthy' WHERE id=$1`, [accountId]);
  }
}
