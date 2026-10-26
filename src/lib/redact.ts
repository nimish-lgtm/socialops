const SECRET_KEY = /token|secret|password|api[_-]?key|authorization|enc_blob|otp/i;
const PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bEAA[A-Za-z0-9]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b[a-f0-9]{64}\b/g,
];

const mask = (s: string): string => (s.length < 18 ? '***' : `${s.slice(0, 4)}...${s.slice(-2)}`);

export function redactString(s: string): string {
  let out = s;
  for (const p of PATTERNS) out = out.replace(p, (m) => mask(m));
  return out.replace(/((?:token|secret|password|api[_-]?key)["']?\s*[:=]\s*["']?)([^\s"',}]{6,})/gi, (_m, k: string, v: string) => k + mask(v));
}

/** Depth-limited redaction of nested values before logging or showing to a model. */
export function redact(v: unknown, depth = 0): unknown {
  if (depth > 12) return '[nesting limit]';
  if (typeof v === 'string') return redactString(v);
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  if (v instanceof Error) return { message: redactString(v.message) };
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) =>
      [k, SECRET_KEY.test(k) && typeof x === 'string' ? mask(x) : redact(x, depth + 1)]));
  }
  return v;
}
