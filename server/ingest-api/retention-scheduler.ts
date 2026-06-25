/**
 * Scheduled retention purge runner.
 *
 * A timer that invokes {@link runPurge} on a fixed cadence (default daily,
 * configurable, disable-able). Guards against overlap with an in-flight flag
 * so a long purge never stacks on top of itself. The actor on scheduled runs
 * is the fixed `system` label.
 *
 * The scheduler is intentionally simple — a single-process `setInterval`. It
 * is started by `main.ts` only when Postgres is wired and the purge is
 * enabled; tests drive `runOnce()` directly without arming the timer.
 */

import type { Logger } from "pino";
import { runPurge, type PurgeRunnerDeps } from "./retention.js";

/** Fixed actor label used for scheduled (non-user-initiated) purges. */
export const PRINCIPAL_SYSTEM = "system";

export interface RetentionSchedulerOptions extends PurgeRunnerDeps {
  /** Tenant the single-tenant OSS scheduler purges. */
  tenantId: string;
  logger?: Pick<Logger, "info" | "warn" | "error">;
}

export class RetentionScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  constructor(private readonly opts: RetentionSchedulerOptions) {}

  /**
   * Run a single purge pass now, skipping if one is already in flight (overlap
   * guard). Returns `true` if a pass ran, `false` if it was skipped. Never
   * throws — a purge failure is logged and swallowed so the timer survives.
   */
  async runOnce(): Promise<boolean> {
    if (this.running) {
      this.opts.logger?.warn(
        "retention purge already in progress; skipping this tick"
      );
      return false;
    }
    this.running = true;
    try {
      await runPurge(
        this.opts,
        this.opts.tenantId,
        PRINCIPAL_SYSTEM,
        new Date(),
        this.opts.logger
      );
      return true;
    } catch (err) {
      this.opts.logger?.error({ err }, "scheduled retention purge failed");
      return false;
    } finally {
      this.running = false;
    }
  }

  /**
   * Arm the interval timer. `unref()`s the timer so it never keeps the process
   * alive on its own. Does not run an immediate pass — the first run happens
   * one interval after start.
   */
  start(): void {
    if (this.timer || this.stopped) return;
    const intervalMs = this.opts.retentionConfig.purgeIntervalHours * 60 * 60 * 1000;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, intervalMs);
    // Don't hold the event loop open for the purge timer alone.
    this.timer.unref?.();
    this.opts.logger?.info(
      {
        intervalHours: this.opts.retentionConfig.purgeIntervalHours,
        tenantId: this.opts.tenantId,
      },
      "retention purge scheduler started"
    );
  }

  /** Stop the timer (graceful shutdown). */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
