/** Injectable time source. Tests and demos use VirtualClock; production uses SystemClock. */
export interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}

/** A clock whose sleep() advances time instead of waiting. */
export class VirtualClock implements Clock {
  private currentMs: number;

  constructor(start: Date | string | number = Date.UTC(2026, 0, 1, 0, 0, 0)) {
    this.currentMs =
      start instanceof Date ? start.getTime() : typeof start === 'number' ? start : Date.parse(start);
    if (!Number.isFinite(this.currentMs)) throw new Error('VirtualClock start must be a valid date');
  }

  now(): Date {
    return new Date(this.currentMs);
  }

  async sleep(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) throw new Error(`Invalid sleep duration: ${ms}`);
    this.currentMs += ms;
  }

  advance(ms: number): void {
    this.currentMs += ms;
  }

  elapsedSince(start: Date): number {
    return this.currentMs - start.getTime();
  }
}
