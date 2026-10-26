import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { canonical, hashPayload } from '../src/policy/approvals';
import { signBody, verifySignature, encrypt, decrypt } from '../src/security/crypto';
import { parseWebhook } from '../src/channel/ingress';
import { detectClaims, bannedHits } from '../src/skills/skills';
import { redact } from '../src/lib/redact';
import { validateWorkflow, type Workflow } from '../src/core/engine';
import { WORKFLOWS } from '../src/workflows';
import { qcProblems } from '../src/jobs/handlers';
import { configProblems, loadConfig } from '../src/config';
import { preflight } from '../src/app/build';
import { capabilityFor, MATRIX } from '../src/accounts/matrix';
import { inWindow } from '../src/core/messenger';
import { costMinor } from '../src/core/cost';
import { publishPayload } from '../src/workflows/helpers';

describe('approval hash', () => {
  it('T-UNIT-01 covers nested data, ignores key order, distinguishes types', () => {
    expect(hashPayload({ a: 1, b: { y: 1, z: 2 } })).toBe(hashPayload({ b: { z: 2, y: 1 }, a: 1 }));
    expect(hashPayload({ a: { x: 1 } })).not.toBe(hashPayload({ a: { x: 2 } }));
    expect(hashPayload({ a: [1, 2] })).not.toBe(hashPayload({ a: [2, 1] }));
    expect(hashPayload({ a: 1 })).not.toBe(hashPayload({ a: '1' }));
    expect(hashPayload({ a: null })).not.toBe(hashPayload({ a: NaN }));
    expect(hashPayload({ d: new Date(1) })).not.toBe(hashPayload({ d: new Date(2) }));
    expect(canonical({ u: undefined, k: 1 })).toBe('{"k":1}');
  });
  it('T-UNIT-02 the publish payload includes the consent answer, so changing consent voids the approval', () => {
    const base = { assetSha: 'a', caption: 'c', accountId: 'x', platform: 'p', route: 'E', consent: 'none' };
    expect(hashPayload(publishPayload(base))).not.toBe(hashPayload(publishPayload({ ...base, consent: 'minors_or_unsure' })));
  });
  it('T-UNIT-03 canonical is key-order independent for any object (property)', () => {
    fc.assert(fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (o) => {
      const reversed = Object.fromEntries(Object.entries(o).reverse());
      expect(canonical(o)).toBe(canonical(reversed));
    }));
  });
});

describe('webhook security', () => {
  it('T-UNIT-04 signature: valid passes; tampered, missing, short, non-hex, wrong prefix fail without throwing', () => {
    const body = Buffer.from('{"a":1}');
    const sig = signBody(body, 's');
    expect(verifySignature(body, sig, 's')).toBe(true);
    for (const bad of [undefined, '', 'sha256=', 'sha256=zz', 'sha256=' + 'z'.repeat(64), 'sha1=' + 'a'.repeat(64), sig.toUpperCase(), sig + 'a', 42, null]) {
      expect(verifySignature(body, bad, 's')).toBe(false);
    }
    expect(verifySignature(Buffer.from('{"a":2}'), sig, 's')).toBe(false);
    expect(verifySignature(body, sig, '')).toBe(false);
  });
  it('T-UNIT-05 signature check never throws on arbitrary headers (fuzz)', () => {
    fc.assert(fc.property(fc.anything(), (h) => { expect(typeof verifySignature(Buffer.from('x'), h, 's')).toBe('boolean'); }));
  });
  it('T-UNIT-06 webhook parser never throws on arbitrary JSON (fuzz) and parses known shapes', () => {
    fc.assert(fc.property(fc.jsonValue(), (j) => { expect(() => parseWebhook(j)).not.toThrow(); }));
    const r = parseWebhook({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'P' }, messages: [
      { id: 'a', from: '919000000001', type: 'text', text: { body: 'hi' } },
      { id: 'b', from: '919000000001', type: 'interactive', interactive: { button_reply: { id: 'a:x:y' } } },
      { id: 'c', from: '919000000001', type: 'video', video: { id: 'm', mime_type: 'video/mp4', caption: 'cap' } },
      { id: 'd', from: 'not-a-phone', type: 'text', text: { body: 'x' } },
    ], statuses: [{ id: 's', status: 'delivered' }] } }] }] });
    expect(r.messages.map((m) => m.type)).toEqual(['text', 'button', 'media']);
    expect(r.messages[2]).toMatchObject({ mediaId: 'm', caption: 'cap', pnid: 'P' });
    expect(r.statuses).toHaveLength(1);
  });
  it('T-UNIT-07 credential encryption round-trips and fails with the wrong key', () => {
    const k = 'ab'.repeat(32);
    expect(decrypt(encrypt('secret-token', k), k)).toBe('secret-token');
    expect(() => decrypt(encrypt('secret-token', k), 'cd'.repeat(32))).toThrow();
  });
});

describe('content checks', () => {
  it('T-UNIT-08 claims detection flags prices, percentages, dates, phones and risky words', () => {
    const c = detectClaims('Diwali sale 20% off, ₹499 only, 31 Oct tak. Call 98765 43210. Guaranteed taste!');
    expect(c.join('|')).toMatch(/20% off/);
    expect(c.join('|')).toMatch(/₹499/);
    expect(c.join('|')).toMatch(/31 Oct/);
    expect(c.join('|')).toMatch(/98765 43210/);
    expect(c.join('|')).toMatch(/Guaranteed/i);
    expect(detectClaims('Aaj ka mausam accha hai')).toEqual([]);
  });
  it('T-UNIT-09 banned phrases are found case-insensitively', () => {
    expect(bannedHits('100% GUARANTEED result', ['guaranteed', 'sabse sasta'])).toEqual(['guaranteed']);
  });
  it('T-UNIT-10 media QC rejects unsupported types, unreadable files and too-short videos', () => {
    expect(qcProblems({ durationS: 30, width: 1080, height: 1920 }, 'video/mp4')).toEqual([]);
    expect(qcProblems({ durationS: 1, width: 1080, height: 1920 }, 'video/mp4')).toEqual(['video 3 second se chhota hai']);
    expect(qcProblems({ durationS: null, width: null, height: null }, 'image/jpeg')).toEqual(['file padh nahi paya']);
    expect(qcProblems({ durationS: null, width: 0, height: 0 }, 'image/jpeg')).toEqual(['file padh nahi paya']);
    expect(qcProblems({ durationS: null, width: null, height: null, skipped: true }, 'image/jpeg')).toEqual([]);
    expect(qcProblems({ durationS: null, width: null, height: null }, 'application/pdf')).toEqual(['sirf photo ya video chalega']);
  });
  it('T-UNIT-11 redaction masks tokens and keyed secrets in nested values', () => {
    const t = 'EAAB' + 'x'.repeat(40);
    const out = JSON.stringify(redact({ msg: `Bearer ${'a'.repeat(30)} and ${t}`, access_token: 'supersecretvalue123', nested: { password: 'hunter2hunter2' } }));
    expect(out).not.toContain(t);
    expect(out).not.toContain('supersecretvalue123');
    expect(out).not.toContain('hunter2hunter2');
  });
});

describe('workflows and configuration', () => {
  it('T-UNIT-12 every workflow is valid: reachable, no dead ends, external writes guarded by approval', () => {
    for (const w of WORKFLOWS) expect(validateWorkflow(w)).toEqual([]);
    const bad: Workflow = { name: 'bad', initial: 'a', states: { a: { on: { go: 'b' }, externalWrite: true }, b: { terminal: true }, c: { terminal: true } } };
    const errs = validateWorkflow(bad).join('\n');
    expect(errs).toMatch(/without approval guard/);
    expect(errs).toMatch(/unreachable c/);
  });
  it('T-UNIT-13 capability is per account type; unknown combinations are unsupported; all rows marked unverified', () => {
    expect(capabilityFor('instagram', 'account', 'professional').route).toBe('E');
    expect(capabilityFor('instagram', 'account', 'personal').route).toBe('A');
    expect(capabilityFor('tiktok', 'account', 'any').route).toBe('N');
    expect(Object.values(MATRIX).every((r) => r.verified === false)).toBe(true);
  });
  it('T-UNIT-14 live and hybrid refuse unsafe adapters and dev secrets', () => {
    const fake = { kind: 'fake' } as any, live = { kind: 'live' } as any;
    expect(() => preflight('live', { wa: live, social: fake, llm: live })).toThrow(/social/);
    expect(() => preflight('hybrid', { wa: live, social: live, llm: live })).toThrow(/social must be fake/);
    expect(() => preflight('mock', { wa: live, social: fake, llm: fake })).toThrow();
    expect(() => preflight('live', { wa: live, social: live, llm: live })).not.toThrow();
    const p = configProblems(loadConfig({ MODE: 'live' }));
    expect(p.join('\n')).toMatch(/CREDENTIAL_KEY/);
    expect(p.join('\n')).toMatch(/WA_ACCESS_TOKEN/);
    expect(p.join('\n')).toMatch(/LLM_PROVIDER=anthropic/);
    expect(configProblems(loadConfig({ MODE: 'mock' }))).toEqual([]);
  });
  it('T-UNIT-15 the 24h window and INR cost math', () => {
    const now = new Date('2026-11-02T10:00:00Z');
    expect(inWindow(new Date(now.getTime() - 23 * 3600_000), now)).toBe(true);
    expect(inWindow(new Date(now.getTime() - 25 * 3600_000), now)).toBe(false);
    expect(inWindow(null, now)).toBe(false);
    expect(costMinor('claude-haiku-5-5', 1000, 200)).toBe(Math.ceil(((1000 * 0.1 + 200 * 0.5) / 1e6) * 94.94 * 100));
    expect(costMinor('unknown-model', 1000, 200)).toBeNull();
  });
});
