/**
 * Priority semaphore for LLM calls.
 *
 * Three separately-capped lanes rather than one global limit:
 *
 *   research    1  - a research call is not one request, it is an agentic loop that fans out
 *                    into several Exa searches (25s timeout each) plus webfetch round trips.
 *                    Parallelising the sessions multiplies that fan-out invisibly against a
 *                    shared free service, which is the fastest route to opaque 429s mid-campaign.
 *   writing     2  - I/O bound on the provider; 2 captures nearly all available parallelism
 *                    while keeping the blast radius of a crash to two units of work.
 *   interactive 1  - RESERVED. A user clicking "rewrite this email" must never queue behind a
 *                    200-company research batch. This is the difference between "slow but
 *                    usable" and "frozen".
 */

export type Lane = "research" | "writing" | "interactive";

const DEFAULT_LIMITS: Record<Lane, number> = { research: 1, writing: 2, interactive: 1 };
const MIN_GAP_MS = 250;

interface Waiter { resolve: () => void; enqueuedAt: number }

export class LlmQueue {
  private readonly limits: Record<Lane, number>;
  private readonly active: Record<Lane, number> = { research: 0, writing: 0, interactive: 0 };
  private readonly waiting: Record<Lane, Waiter[]> = { research: [], writing: [], interactive: [] };
  private lastDispatch = 0;
  private backoffUntil = 0;

  constructor(limits: Partial<Record<Lane, number>> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  stats(): { active: Record<Lane, number>; waiting: Record<Lane, number>; limits: Record<Lane, number> } {
    return {
      active: { ...this.active },
      waiting: { research: this.waiting.research.length, writing: this.waiting.writing.length, interactive: this.waiting.interactive.length },
      limits: { ...this.limits },
    };
  }

  /** Drop batch lanes to 1 for a while. Called on any RATE_LIMITED. */
  throttle(ms = 60_000): void {
    this.backoffUntil = Math.max(this.backoffUntil, Date.now() + ms);
  }

  private limitFor(lane: Lane): number {
    if (lane !== "interactive" && Date.now() < this.backoffUntil) return 1;
    return this.limits[lane];
  }

  private async acquire(lane: Lane): Promise<void> {
    if (this.active[lane] < this.limitFor(lane)) {
      this.active[lane]++;
      await this.spaceOut();
      return;
    }
    await new Promise<void>((resolve) => this.waiting[lane].push({ resolve, enqueuedAt: Date.now() }));
    await this.spaceOut();
  }

  /** Smooth bursts so we never fire N requests at a local server in the same tick. */
  private async spaceOut(): Promise<void> {
    const gap = this.lastDispatch + MIN_GAP_MS - Date.now();
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    this.lastDispatch = Date.now();
  }

  private release(lane: Lane): void {
    const next = this.waiting[lane].shift();
    if (next) next.resolve();          // hands over the slot; active count is unchanged
    else this.active[lane]--;
  }

  async run<T>(lane: Lane, fn: () => Promise<T>): Promise<T> {
    await this.acquire(lane);
    try {
      return await fn();
    } finally {
      this.release(lane);
    }
  }
}
