import { redact } from './redact';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

/** Structured JSON logs. Fields pass through redaction so tokens and secrets never reach a log line. */
export function createLogger(min: Level = 'info', sink: (line: string) => void = (l) => process.stdout.write(l + '\n')): Logger {
  const emit = (level: Level, event: string, fields: Record<string, unknown> = {}) => {
    if (ORDER[level] < ORDER[min]) return;
    sink(JSON.stringify({ ts: new Date().toISOString(), level, event, ...(redact(fields) as object) }));
  };
  return {
    debug: (e, f) => emit('debug', e, f),
    info: (e, f) => emit('info', e, f),
    warn: (e, f) => emit('warn', e, f),
    error: (e, f) => emit('error', e, f),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
