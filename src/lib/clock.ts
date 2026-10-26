export interface Clock { now(): Date }

export const systemClock: Clock = { now: () => new Date() };

/** Test clock: time only moves when told to. */
export class ManualClock implements Clock {
  private t: number;
  constructor(start = Date.parse('2026-11-02T06:30:00Z')) { this.t = start; }
  now(): Date { return new Date(this.t); }
  advance(ms: number): void { this.t += ms; }
  set(d: Date): void { this.t = d.getTime(); }
}

export const HOUR = 3600_000;
export const DAY = 24 * HOUR;
