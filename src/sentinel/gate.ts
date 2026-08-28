import { EventSink } from "../core/types.js";
import { GateAbortedError, GateSaturatedError } from "../core/types.js";

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
 * - Fairness ladder with empty-normal fallback
 * @public
 */
export class ConcurrencyGate {
  private active = 0;
  private criticalQueue: Array<() => void> = [];
  private normalQueue: Array<() => void> = [];
  private consecutiveCriticalDispatches = 0;

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
   * - Wait-time emission (gate:wait) for observability
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
      throw new GateSaturatedError(this.label, this.maxQueueDepth);
    }
    if (this.active < this.maxConcurrent) return this.grantLease();

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
          // Emit refund event for cancel storms
          this.sink.emit("gate:refund", { label: this.label, reason: "aborted_at_grant" });
          this.dispatchNext(); 
          reject(new GateAbortedError(this.label));
          return;
        }
        // Emit wait time upon successful acquisition
        this.sink.emit("gate:wait", { 
          label: this.label, 
          priority, 
          waitedMs: performance.now() - queuedAt 
        });
        resolve(this.grantLease());
      };
      
      signal.addEventListener("abort", onAbort, { once: true });
      (priority === "critical" ? this.criticalQueue : this.normalQueue).push(entry!);
    });
  }

  private grantLease(): () => void {
    this.active++;
    this.sink.emit("gate:grant", { label: this.label, active: this.active });
    let used = false;
    return () => {
      if (used) return; // Idempotent release
      used = true;
      this.dispatchNext();
    };
  }

  private dispatchNext(): void {
    this.active--;
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
}

