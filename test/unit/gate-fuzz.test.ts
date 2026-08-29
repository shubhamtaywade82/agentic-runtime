/**
 * SEEDED PROPERTY/FUZZ TEST - ConcurrencyGate invariants (D11/D12).
 *
 * For a deterministic set of seeds, fires randomized interleavings of
 * acquire / release / abort against a gate and asserts the invariants that
 * the audit found violated at HEAD 38ce0e9:
 *
 *  I1 (D12 over-grant): `active` NEVER exceeds maxConcurrent - observed via
 *      the active gauge carried on every runtime_gate_grants_total event.
 *  I2 (D11 abort cleanup): aborted waiters are removed from the queue by
 *      referential identity - at quiescence `queued === 0`.
 *  I3 (idempotent release): every granted lease is refunded exactly once -
 *      at quiescence `active === 0` and `grants === resolved acquires`.
 *
 * Deterministic by construction (mulberry32 PRNG); failures reproduce by
 * seed number.
 */
import { describe, it, expect } from "vitest";
import { ConcurrencyGate } from "../../src/sentinel/gate.js";
import { GATE_METRICS } from "../../src/observability/metrics.js";
import type { EventSink, Priority } from "../../src/core/types.js";

/** Deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface FuzzOutcome {
  maxConcurrent: number;
  maxActiveObserved: number;
  grants: number;
  active: number;
  queued: number;
  resolvedCount: number;
  rejectedCount: number;
}

async function fuzzOnce(seed: number): Promise<FuzzOutcome> {
  const rand = mulberry32(seed);
  const maxConcurrent = 1 + Math.floor(rand() * 3); // 1..3
  const maxQueueDepth = 1 + Math.floor(rand() * 6); // 1..6
  const waiters = 4 + Math.floor(rand() * 8); // 4..11 concurrent acquires

  const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const sink: EventSink = {
    emit: (name, payload) => events.push({ name, payload }),
  };
  const gate = new ConcurrencyGate(maxConcurrent, maxQueueDepth, "fuzz", sink);

  const controllers: AbortController[] = [];
  let resolvedCount = 0;
  let rejectedCount = 0;

  const tasks: Promise<void>[] = [];
  for (let i = 0; i < waiters; i++) {
    const controller = new AbortController();
    controllers.push(controller);
    const priority: Priority = rand() < 0.3 ? "critical" : "normal";

    // Random abort scheduling: some waiters abort early, some mid-flight,
    // some never (their leases are released after a random hold).
    if (rand() < 0.45) {
      const delay = Math.floor(rand() * 12);
      setTimeout(() => controller.abort(), delay);
    }

    const task = gate
      .acquire(priority, controller.signal)
      .then(async (release) => {
        resolvedCount++;
        const holdMs = Math.floor(rand() * 8);
        await new Promise((r) => setTimeout(r, holdMs));
        release();
        // Double-release attempts exercise idempotence.
        if (rand() < 0.3) release();
      })
      .catch(() => {
        rejectedCount++;
      });
    tasks.push(task);
  }

  // Let the interleaving play out, then force-settle every remaining waiter.
  await new Promise((r) => setTimeout(r, 25));
  for (const controller of controllers) controller.abort();
  await Promise.allSettled(tasks);
  // Drain any dispatch cascade triggered by the final abort wave.
  await new Promise((r) => setTimeout(r, 10));

  let maxActiveObserved = 0;
  for (const event of events) {
    if (event.name === GATE_METRICS.GRANTS_TOTAL) {
      const active = Number(event.payload.active);
      if (Number.isFinite(active)) maxActiveObserved = Math.max(maxActiveObserved, active);
    }
  }
  const stats = gate.stats();
  return {
    maxConcurrent,
    maxActiveObserved,
    grants: stats.grants,
    active: stats.active,
    queued: stats.queued,
    resolvedCount,
    rejectedCount,
  };
}

describe("ConcurrencyGate - seeded fuzz (D11/D12 invariants)", () => {
  it("never over-grants, leaks waiters, or double-refunds across randomized interleavings", async () => {
    const SEEDS = 48;
    const failures: string[] = [];

    for (let seed = 1; seed <= SEEDS; seed++) {
      const outcome = await fuzzOnce(seed);
      const context =
        `seed=${seed} max=${outcome.maxConcurrent} maxActive=${outcome.maxActiveObserved} ` +
        `grants=${outcome.grants} resolved=${outcome.resolvedCount} ` +
        `rejected=${outcome.rejectedCount} active=${outcome.active} queued=${outcome.queued}`;

      // I1 (D12 over-grant): the active gauge never exceeds the ceiling.
      if (outcome.maxActiveObserved > outcome.maxConcurrent) {
        failures.push(`over-grant beyond maxConcurrent: ${context}`);
      }
      // I3: every resolved acquire holds exactly one lease; all were released.
      if (outcome.grants !== outcome.resolvedCount) {
        failures.push(`grants (${outcome.grants}) != resolved acquires (${outcome.resolvedCount}): ${context}`);
      }
      if (outcome.active !== 0) {
        failures.push(`active leases leaked at quiescence: ${context}`);
      }
      // I2: no aborted waiter is stranded in the fairness ladder.
      if (outcome.queued !== 0) {
        failures.push(`waiters stranded in queue: ${context}`);
      }
    }

    expect(failures).toEqual([]);
  }, 30_000);

  it("holds active within maxConcurrent for every seed (over-grant regression, D12)", async () => {
    for (let seed = 100; seed <= 140; seed++) {
      const outcome = await fuzzOnce(seed);
      // Exact per-seed bound: a gate with maxConcurrent=N may never report
      // more than N concurrently-active leases on any grant event.
      expect(outcome.maxActiveObserved).toBeLessThanOrEqual(outcome.maxConcurrent);
      expect(outcome.active).toBe(0);
      expect(outcome.queued).toBe(0);
    }
  }, 30_000);
});
