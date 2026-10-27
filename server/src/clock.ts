export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Controllable clock for tests (`processing` with `resolve_at`). */
export class FakeClock implements Clock {
  private current: number;
  constructor(start = Date.UTC(2026, 9, 26, 12, 0, 0)) {
    this.current = start;
  }
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current += ms;
  }
}
