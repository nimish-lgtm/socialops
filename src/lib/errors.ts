/**
 * Error classes drive recovery: permanent stops the job; definitive means the platform said no;
 * not_sent is safe to retry; ambiguous may have taken effect and must be reconciled, never blindly retried.
 */
export type ErrClass = 'permanent' | 'transient' | 'definitive' | 'not_sent' | 'ambiguous';

export class AppError extends Error {
  constructor(public code: string, public cls: ErrClass, message?: string) {
    super(message ?? code);
  }
}

export const permanent = (code: string, msg?: string) => new AppError(code, 'permanent', msg);
export const transient = (code: string, msg?: string) => new AppError(code, 'transient', msg);
export const errClass = (e: unknown): ErrClass => (e instanceof AppError ? e.cls : 'ambiguous');
