import { EventSink } from "../core/types.js";
import { GateAbortedError, GateSaturatedError } from "../core/types.js";
import { GATE_METRICS, GATE_LABEL_KEYS } from "../observability/metrics.js";

/**
 * Priority level for gate acquisition.
 * @public
 */
export type Priority = "critical" | "normal";

/**
 * ConcurrencyGate - Priority-aware semaphore with self-recycling invariant.
 * 
 * Features:
 * - Critical/normal priority lanes with fairness ladder
 * - Abort cleanup by referential identity (D11)
 * - Slot refund on aborted grant (D12)
 * - Dead-entry self-recycling (D12-b)
 * - Wait-time and refund instrumentation (A1)
 * - Typed saturation error (A2)
 * - Fast-path wait-time emission (A7) - healthy runs must not be invisible to
 *   queue-congestion SLA metrics; fast-path grants emit gate:wait with waitedMs=0
 * - Fairness ladder with empty-normal fallback
 * - Lifetime stats accounting for terminal report metrics
 *
 * Metric contract: this gate emits the canonical metric names declared in
 * `observability/metrics.ts` (GATE_METRICS.*) with the canonical label keys
 * (GATE_LABEL_KEYS.*). `runtime_gate_wait_ms` is emitted for EVERY grant,
 * including zero-wait fast-path grants, so congestion SLA histograms see
 * healthy runs too (A7).
 * @public
 */
export class ConcurrencyGate {
  private active = 0;
  private criticalQueue: Array<() => void> = [];
  private normalQueue: Array<() => void> = [];
  private consecutiveCriticalDispatches = 0;
  private grantsTotal = 0;
  private refundsTotal = 0;
  private saturationsTotal = 0;

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueueDepth: number,
    public readonly label: string,
    private readonly sink: EventSink
  ) {}

  /**
   * Acquire a lease from the gate.
   * 
   * Features:
   * - Wait-time emission (gate:wait) for observability, including fast-path
   *   grants (waitedMs: 0) so congestion SLA histograms see healthy runs (A7)
   * - Refund emission (gate:refund) on aborted grants
   * - Typed saturation error (GateSaturatedError) for A2
   * - Fast-path abort check
   * - Abort cleanup by referential identity
   * - Dead-entry self-recycling on grant race
   * @public
   */
  async acquire(priority: Priority, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw new GateAbortedError(this.label);
    if (this.depth() >= this.maxQueueDepth) {
      this.saturationsTotal++;
      this.sink.emit(GATE_METRICS.SATURATION_TOTAL, {
        [GATE_LABEL_KEYS.GATE]: this.label,
        maxDepth: this.maxQueueDepth,
      });
      throw new GateSaturatedError(this.label, this.maxQueueDepth);
    }
    if (this.active < this.maxConcurrent) {
      // A7: fast-path grants must be visible to wait-time histograms.
      // Without this, only congested runs emit a wait sample and the SLA signal
      // degenerates into "only unhappy paths are measured".
      this.sink.emit(GATE_METRICS.WAIT_MS, {
        [GATE_LABEL_KEYS.GATE]: this.label,
        [GATE_LABEL_KEYS.PRIORITY]: priority,
        waitedMs: 0,
      });
      return this.grantLease();
    }

    const queuedAt = performance.now();

    return new Promise<() => void>((resolve, reject) => {
      // eslint-disable-next-line prefer-const
      let entry: (() => void) | undefined;
      const onAbort = () => {
        this.criticalQueue = this.criticalQueue.filter((e) => e !== entry);
        this.normalQueue = this.normalQueue.filter((e) => e !== entry);
        reject(new GateAbortedError(this.label));
      };
      
      entry = () => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          // Dead entry (D12-b): this waiter was aborted after being dequeued.
          // It never held a lease, so it must NOT decrement `active` - the
          // slot released by our predecessor is handed straight to the next
          // waiter. Emit the refund counter and recycle.
          this.refundsTotal++;
          this.sink.emit(GATE_METRICS.REFUNDS_TOTAL, {
            [GATE_LABEL_KEYS.GATE]: this.label,
            reason: "aborted_at_grant",
          });
          this.dispatchNext();
          reject(new GateAbortedError(this.label));
          return;
        }
        // Emit wait time upon successful acquisition
        this.sink.emit(GATE_METRICS.WAIT_MS, {
          [GATE_LABEL_KEYS.GATE]: this.label,
          [GATE_LABEL_KEYS.PRIORITY]: priority,
          waitedMs: performance.now() - queuedAt,
        });
        resolve(this.grantLease());
      };
      
      signal.addEventListener("abort", onAbort, { once: true });
      (priority === "critical" ? this.criticalQueue : this.normalQueue).push(entry!);
    });
  }

  private grantLease(): () => void {
    this.active++;
    this.grantsTotal++;
    this.sink.emit(GATE_METRICS.GRANTS_TOTAL, {
      [GATE_LABEL_KEYS.GATE]: this.label,
      active: this.active,
    });
    let used = false;
    return () => {
      if (used) return; // Idempotent release
      used = true;
      // D12: the slot is refunded exactly once, here - at the release site.
      // dispatchNext() only HANDS OFF the freed slot; it never decrements,
      // so a dead entry dispatching the slot onward cannot double-refund and
      // drive `active` negative (the historical over-grant bug).
      this.active--;
      this.dispatchNext();
    };
  }

  private dispatchNext(): void {
    let next: (() => void) | undefined;
    
    // Fairness Policy: Cap consecutive critical dispatches to prevent normal-worker starvation
    if (this.criticalQueue.length > 0 && this.consecutiveCriticalDispatches < 10) {
      next = this.criticalQueue.shift();
      this.consecutiveCriticalDispatches++;
    } else if (this.normalQueue.length > 0) {
      next = this.normalQueue.shift();
      this.consecutiveCriticalDispatches = 0;
    } else if (this.criticalQueue.length > 0) {
      // Fallback if normal queue is entirely empty
      next = this.criticalQueue.shift();
      this.consecutiveCriticalDispatches++;
    } else {
      this.consecutiveCriticalDispatches = 0;
    }
    
    next?.();
  }
  
  private depth(): number { 
    return this.criticalQueue.length + this.normalQueue.length; 
  }

  /**
   * Lifetime stats for this gate.
   *
   * Used by the terminal report metrics (sentinelAcquisitions/sentinelRejections)
   * and by operators verifying gate health without attaching an event sink.
   *
   * - grants: total leases granted (fast-path + queued)
   * - refunds: grants destroyed by abort at dispatch time (cancel storms)
   * - saturations: acquisitions rejected by queue-depth ceiling
   * - active: currently held leases
   * - queued: waiters currently parked in the fairness ladder
   * @public
   */
  stats(): {
    label: string;
    grants: number;
    refunds: number;
    saturations: number;
    active: number;
    queued: number;
  } {
    return {
      label: this.label,
      grants: this.grantsTotal,
      refunds: this.refundsTotal,
      saturations: this.saturationsTotal,
      active: this.active,
      queued: this.depth(),
    };
  }
}

