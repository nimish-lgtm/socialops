import { randomBytes, createHash } from 'node:crypto';

export const newId = (prefix: string): string => `${prefix}_${randomBytes(10).toString('hex')}`;
export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
export const hashPhone = (phone: string): string => sha256('phone:' + phone).slice(0, 24);
