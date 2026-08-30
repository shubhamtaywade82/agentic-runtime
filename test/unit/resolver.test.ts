import { describe, it, expect } from "vitest";
import {
  DisputeResolver,
  NegotiationLedger,
} from "../../src/dispute/resolver.js";
import type { Dispute, HumanGate } from "../../src/dispute/resolver.js";
import { DisputeResolutionError } from "../../src/core/types.js";
import { assistantTurn, createScriptedBrain } from "./scripted-brain.js";

function makeDispute(): Dispute {
  return {
    id: "dispute-1",
    subject: "Is the measured API latency 200ms or 2000ms?",
    claims: [
      { party: "worker-a", content: "latency is 200ms", evidence: "receipt-aaa111" },
      { party: "worker-b", content: "latency is 2000ms", evidence: "receipt-bbb222" },
    ],
    createdAt: Date.now(),
  };
}

/** Script responses by prompt marker so tiers are distinguishable offline. */
function tierScriptedBrain(script: {
  recompute?: (i: number) => string;
  judge?: (i: number) => string;
}) {
  let recomputeCalls = 0;
  let judgeCalls = 0;
  return createScriptedBrain((call) => {
    const user = call.messages[1]?.content ?? "";
    if (user.startsWith("RE-COMPUTATION SAMPLE")) {
      recomputeCalls++;
      return assistantTurn({ content: script.recompute?.(recomputeCalls) ?? "garbage" });
    }
    if (user.startsWith("ARBITRATION - FINAL JUDGMENT")) {
      judgeCalls++;
      return assistantTurn({ content: script.judge?.(judgeCalls) ?? "garbage" });
    }
    return assistantTurn({ content: "unexpected prompt" });
  });
}

describe("DisputeResolver - S1-S8 deterministic matrix", () => {
  it("S1: Tier 1 oracle resolves deterministically with zero inference", async () => {
    const brain = createScriptedBrain(() => {
      throw new Error("brain must not be called when the oracle has authority");
    });
    const resolver = new DisputeResolver(brain, {
      oracle: async () => ({ winner: "worker-a", verdict: "receipt-aaa111 is the ground truth" }),
    });

    const outcome = await resolver.resolve(makeDispute());

    expect(brain.calls).toHaveLength(0);
    expect(outcome).toMatchObject({
      tier: 1,
      resolved: true,
      winner: "worker-a",
      inferenceCalls: 0,
    });
    expect(outcome.verdict).toContain("ground truth");
    // Ledger records both claims plus the verdict.
    expect(outcome.ledger.size).toBe(3);
  });

  it("S2: oracle declines -> Tier 2 strict majority resolves", async () => {
    const brain = tierScriptedBrain({
      recompute: () => '{"supports": "worker-a", "rationale": "receipt matches"}',
    });
    const resolver = new DisputeResolver(brain, {
      oracle: async () => null, // no authority over this subject
    });

    const outcome = await resolver.resolve(makeDispute());

    expect(outcome.tier).toBe(2);
    expect(outcome.resolved).toBe(true);
    expect(outcome.winner).toBe("worker-a");
    expect(outcome.inferenceCalls).toBe(3);
    expect(["(3/3)", "(2/3)"].some((s) => outcome.verdict.includes(s))).toBe(true);
  });

  it("S2b: Tier 2 tolerates invalid samples when a majority still forms", async () => {
    const brain = tierScriptedBrain({
      recompute: (i) =>
        i === 2 ? "unparsable noise" : '{"supports": "worker-b"}',
    });
    const resolver = new DisputeResolver(brain);

    const outcome = await resolver.resolve(makeDispute());

    expect(outcome.tier).toBe(2);
    expect(outcome.winner).toBe("worker-b");
    expect(outcome.inferenceCalls).toBe(3);
  });

  it("S3: Tier 2 deadlock -> Tier 3 judge resolves", async () => {
    const brain = tierScriptedBrain({
      // a, b, invalid -> tally 1 v 1, no strict majority.
      recompute: (i) =>
        i === 1
          ? '{"supports": "worker-a"}'
          : i === 2
            ? '{"supports": "worker-b"}'
            : "unparsable noise",
      judge: () => '{"winner": "worker-b", "verdict": "receipt-bbb222 carries the timestamp"}',
    });
    const resolver = new DisputeResolver(brain);

    const outcome = await resolver.resolve(makeDispute());

    expect(outcome.tier).toBe(3);
    expect(outcome.resolved).toBe(true);
    expect(outcome.winner).toBe("worker-b");
    expect(outcome.inferenceCalls).toBe(4); // 3 samples + 1 judge call
    expect(outcome.verdict).toContain("timestamp");
  });

  it("S4: judge fails twice -> Tier 4 human gate resolves", async () => {
    const brain = tierScriptedBrain({
      recompute: () => "garbage", // no valid samples -> no majority
      judge: () => '{"winner": "not-a-party"}', // invalid twice
    });
    const resolver = new DisputeResolver(brain, {
      humanGate: {
        requestVerdict: async () => ({
          accepted: true,
          winner: "worker-a",
          verdict: "human adjudicated in favor of worker-a",
        }),
      },
    });

    const outcome = await resolver.resolve(makeDispute());

    expect(outcome.tier).toBe(4);
    expect(outcome.resolved).toBe(true);
    expect(outcome.winner).toBe("worker-a");
    expect(outcome.inferenceCalls).toBe(5); // 3 samples + 2 judge attempts
  });

  it("S5: human gate rejection -> DisputeResolutionError at tier 4", async () => {
    const brain = tierScriptedBrain({
      recompute: () => "garbage",
      judge: () => "also garbage",
    });
    const resolver = new DisputeResolver(brain, {
      humanGate: {
        requestVerdict: async () => ({
          accepted: false,
          winner: null,
          verdict: "insufficient evidence to adjudicate",
        }),
      },
    });

    await expect(resolver.resolve(makeDispute())).rejects.toThrow(DisputeResolutionError);
    await expect(resolver.resolve(makeDispute())).rejects.toThrow(/human gate rejected/);
  });

  it("S5b: lattice exhausted with no human gate configured -> fails closed", async () => {
    const brain = tierScriptedBrain({
      recompute: () => "garbage",
      judge: () => "garbage",
    });
    const resolver = new DisputeResolver(brain);

    await expect(resolver.resolve(makeDispute())).rejects.toThrow(
      /no human gate is configured/,
    );
  });

  it("S6: human gate timeout -> DisputeResolutionError at tier 4", async () => {
    const brain = tierScriptedBrain({
      recompute: () => "garbage",
      judge: () => "garbage",
    });
    const hangingGate: HumanGate = {
      requestVerdict: () => new Promise(() => {}), // never resolves
    };
    const resolver = new DisputeResolver(brain, {
      humanGate: hangingGate,
      humanGateTimeoutMs: 50,
    });

    await expect(resolver.resolve(makeDispute())).rejects.toThrow(/timed out after 50ms/);
  });

  it("S7: NegotiationLedger is append-only, monotonic, and defensively copied", async () => {
    const ledger = new NegotiationLedger();
    const a = ledger.record("worker-a", "claim", "latency is 200ms");
    const b = ledger.record("worker-b", "counter", "latency is 2000ms");
    const c = ledger.record("worker-a", "evidence", "receipt-aaa111");

    expect(a.seq).toBe(0);
    expect(b.seq).toBe(1);
    expect(c.seq).toBe(2);
    expect(Object.isFrozen(a)).toBe(true);

    const history = ledger.history();
    expect(history.map((e) => e.seq)).toEqual([0, 1, 2]);

    // Defensive copy: mutating the returned array must not corrupt the ledger.
    (history as NegotiationEntryLike[]).length = 0;
    expect(ledger.size).toBe(3);
    expect(ledger.lastFrom("worker-a")?.content).toBe("receipt-aaa111");
    expect(ledger.lastFrom("worker-b")?.kind).toBe("counter");
    expect(ledger.lastFrom("nobody")).toBeNull();
  });

  it("S7b: resolver ledger records the full escalation trail", async () => {
    const brain = tierScriptedBrain({
      recompute: () => '{"supports": "worker-a"}',
    });
    const resolver = new DisputeResolver(brain, { oracle: async () => null });
    const outcome = await resolver.resolve(makeDispute());

    const history = outcome.ledger.history();
    // 2 claims + 3 samples + 1 verdict
    expect(history.length).toBe(6);
    expect(history.filter((e) => e.kind === "claim")).toHaveLength(2);
    expect(history.filter((e) => e.kind === "evidence")).toHaveLength(3);
    expect(history.filter((e) => e.kind === "verdict")).toHaveLength(1);
  });

  it("S8: pre-aborted signal fails fast without inference", async () => {
    const brain = createScriptedBrain(() => {
      throw new Error("brain must not be called after abort");
    });
    const resolver = new DisputeResolver(brain);

    const controller = new AbortController();
    controller.abort();

    await expect(resolver.resolve(makeDispute(), controller.signal)).rejects.toThrow(
      /aborted by kill switch/,
    );
    expect(brain.calls).toHaveLength(0);
  });

  it("S8b: a dispute with fewer than two parties is rejected", async () => {
    const resolver = new DisputeResolver(createScriptedBrain(() => assistantTurn()));
    const singleParty = {
      ...makeDispute(),
      claims: [makeDispute().claims[0]!],
    };

    await expect(resolver.resolve(singleParty)).rejects.toThrow(
      /at least two parties/,
    );
  });

  it("every tier transition emits dispute events on the sink", async () => {
    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const brain = tierScriptedBrain({
      recompute: () => "garbage",
      judge: () => "garbage",
    });
    const resolver = new DisputeResolver(brain, {
      oracle: async () => null, // run tier 1, decline, escalate
      sink: {
        emit: (name, payload) => events.push({ name, payload }),
      },
      humanGate: {
        requestVerdict: async () => ({
          accepted: true,
          winner: "worker-a",
          verdict: "human says a",
        }),
      },
    });

    await resolver.resolve(makeDispute());

    const plans = events.filter((e) => e.name === "dispute:plan");
    const escalations = events.filter((e) => e.name === "dispute:escalated");
    expect(plans.map((p) => p.payload.tier)).toEqual([1, 2, 3, 4]);
    expect(escalations.map((e) => e.payload.fromTier)).toEqual([1, 2, 3]);
  });
});

/** Local structural alias for the defensive-copy mutation test. */
interface NegotiationEntryLike {
  seq: number;
}
