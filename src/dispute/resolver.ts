import {
  DisputeResolutionError,
} from "../core/types.js";
import type {
  ChatMsg,
  EventSink,
  RequestSchedule,
  ThoughtProcess,
} from "../core/types.js";

/**
 * A single position asserted by a party in a dispute.
 * @public
 */
export interface DisputeClaim {
  /** Party identifier (agent name, validator id, ...). */
  party: string;
  /** The asserted position. */
  content: string;
  /** Supporting evidence (receipt reference, raw output digest, ...). */
  evidence: string;
}

/**
 * A dispute between two or more parties over a factual subject.
 * @public
 */
export interface Dispute {
  id: string;
  /** The factual subject under contention. */
  subject: string;
  /** Conflicting claims. At least two parties must be represented. */
  claims: DisputeClaim[];
  createdAt: number;
}

/**
 * Deterministic ground-truth adjudicator (Tier 1 - Oracle).
 * Return null when the oracle has no authority over this subject;
 * the resolver then escalates to Tier 2.
 * @public
 */
export type DisputeOracle = (
  dispute: Dispute,
) => Promise<{ winner: string; verdict: string } | null>;

/**
 * Human escalation boundary (Tier 4).
 * Implementations MUST resolve within the timeout budget or reject;
 * the resolver additionally enforces the deadline defensively.
 * @public
 */
export interface HumanGate {
  requestVerdict(
    dispute: Dispute,
    timeoutMs: number,
  ): Promise<{ accepted: boolean; winner: string | null; verdict: string }>;
}

/**
 * The plan a tier will execute, emitted before escalation proceeds.
 * Discriminated union over the four tiers.
 * @public
 */
export type ResolutionPlan =
  | { tier: 1; kind: "oracle"; description: "deterministic ground-truth check" }
  | { tier: 2; kind: "recompute"; samples: number; entropyOverride: number }
  | { tier: 3; kind: "judge"; charter: string }
  | { tier: 4; kind: "human-gate"; timeoutMs: number };

/**
 * Terminal outcome of dispute resolution.
 * @public
 */
export interface ResolutionOutcome {
  disputeId: string;
  /** Tier that produced the terminal verdict. */
  tier: 1 | 2 | 3 | 4;
  /** True when a winner was determined (vs. escalated-unresolved error). */
  resolved: boolean;
  verdict: string;
  winner: string | null;
  /** Number of inference calls consumed (oracle = 0, human = 0). */
  inferenceCalls: number;
  /** Append-only negotiation record for the whole resolution. */
  ledger: NegotiationLedger;
}

/**
 * Kind of a negotiation ledger entry.
 * @public
 */
export type NegotiationKind =
  | "claim"
  | "counter"
  | "concession"
  | "evidence"
  | "verdict";

/**
 * A single append-only ledger entry.
 * @public
 */
export interface NegotiationEntry {
  /** Monotonic sequence number, 0-based, gap-free. */
  readonly seq: number;
  readonly at: number;
  readonly party: string;
  readonly kind: NegotiationKind;
  readonly content: string;
}

/**
 * NegotiationLedger - append-only record of the negotiation lifecycle.
 *
 * Invariants:
 * - Entries are frozen; no mutation API exists.
 * - seq values are monotonic and gap-free (seq === index).
 * - history() returns a defensive copy; callers cannot corrupt the record.
 * @public
 */
export class NegotiationLedger {
  private readonly entries: NegotiationEntry[] = [];

  /**
   * Append an entry. Returns the frozen entry.
   * @public
   */
  record(party: string, kind: NegotiationKind, content: string): NegotiationEntry {
    const entry: NegotiationEntry = Object.freeze({
      seq: this.entries.length,
      at: Date.now(),
      party,
      kind,
      content,
    });
    this.entries.push(entry);
    return entry;
  }

  /**
   * Defensive copy of the full record.
   * @public
   */
  history(): readonly NegotiationEntry[] {
    return [...this.entries];
  }

  /**
   * Most recent entry recorded by a party, or null.
   * @public
   */
  lastFrom(party: string): NegotiationEntry | null {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry && entry.party === party) return entry;
    }
    return null;
  }

  /**
   * Number of entries recorded.
   * @public
   */
  get size(): number {
    return this.entries.length;
  }
}

/**
 * Configuration for the DisputeResolver.
 * @public
 */
export interface DisputeResolverConfig {
  /** Tier 1 deterministic oracle. Optional; absent skips to Tier 2. */
  oracle?: DisputeOracle;
  /** Tier 2 recompute parameters. */
  recompute?: { samples?: number; entropyOverride?: number };
  /** Tier 3 judge charter (system prompt for the arbitration call). */
  judge?: { charter?: string };
  /** Tier 4 human escalation boundary. Optional; absent Tier 4 fails closed. */
  humanGate?: HumanGate;
  /** Tier 4 deadline in ms. Default 30_000. */
  humanGateTimeoutMs?: number;
  /** Observability sink. Optional. */
  sink?: EventSink;
}

const DEFAULT_RECOMPUTE_SAMPLES = 3;
const DEFAULT_RECOMPUTE_ENTROPY = 0.7;
const DEFAULT_HUMAN_GATE_TIMEOUT_MS = 30_000;
const DEFAULT_JUDGE_CHARTER =
  "You are an impartial arbitration judge. You weigh the evidence of the " +
  "disputing parties and emit one JSON verdict object and nothing else.";

/**
 * Extract a JSON object from raw model output (tolerates prose and fences).
 */
function extractJsonObject(raw: string): { ok: true; value: unknown } | { ok: false } {
  const text = raw.trim();
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    // fall through
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text.slice(start, end + 1)) };
  } catch {
    return { ok: false };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/**
 * DisputeResolver - the four-tier resolution lattice.
 *
 * Tier 1 (Oracle): deterministic ground-truth check. Zero inference.
 * Tier 2 (Recompute): independent re-sampling at higher entropy; strict
 *   majority among valid samples resolves the dispute.
 * Tier 3 (Judge): a no-tools arbitration call emitting a structured verdict;
 *   one self-correction retry with violations fed back.
 * Tier 4 (Human Gate): escalation to the human boundary under a hard
 *   deadline. Timeout or rejection throws DisputeResolutionError.
 *
 * Every tier transition is recorded in a NegotiationLedger and emitted as
 * dispute:* events. An abort signal is honored at tier boundaries.
 * @public
 */
export class DisputeResolver {
  private readonly oracle: DisputeOracle | null;
  private readonly recomputeSamples: number;
  private readonly recomputeEntropy: number;
  private readonly judgeCharter: string;
  private readonly humanGate: HumanGate | null;
  private readonly humanGateTimeoutMs: number;
  private readonly sink: EventSink | null;

  constructor(
    private readonly brain: ThoughtProcess,
    config: DisputeResolverConfig = {},
  ) {
    this.oracle = config.oracle ?? null;
    this.recomputeSamples = config.recompute?.samples ?? DEFAULT_RECOMPUTE_SAMPLES;
    this.recomputeEntropy =
      config.recompute?.entropyOverride ?? DEFAULT_RECOMPUTE_ENTROPY;
    this.judgeCharter = config.judge?.charter ?? DEFAULT_JUDGE_CHARTER;
    this.humanGate = config.humanGate ?? null;
    this.humanGateTimeoutMs = config.humanGateTimeoutMs ?? DEFAULT_HUMAN_GATE_TIMEOUT_MS;
    this.sink = config.sink ?? null;
  }

  /**
   * Resolve a dispute through the tier ladder.
   * Throws DisputeResolutionError when the lattice is exhausted (Tier 4
   * timeout/rejection, no human gate configured, or abort).
   * @public
   */
  async resolve(dispute: Dispute, signal?: AbortSignal): Promise<ResolutionOutcome> {
    const parties = dispute.claims.map((c) => c.party);
    if (parties.length < 2) {
      throw new DisputeResolutionError(1, "a dispute requires at least two parties");
    }

    const ledger = new NegotiationLedger();
    for (const claim of dispute.claims) {
      ledger.record(claim.party, "claim", `${claim.content} [evidence: ${claim.evidence}]`);
    }

    let inferenceCalls = 0;

    // ---------------------------------------------------------------- Tier 1
    this.assertLive(signal, 1);
    if (this.oracle) {
      this.emitPlan({ tier: 1, kind: "oracle", description: "deterministic ground-truth check" });
      const verdict = await this.oracle(dispute);
      if (verdict && parties.includes(verdict.winner)) {
        ledger.record(verdict.winner, "verdict", verdict.verdict);
        return {
          disputeId: dispute.id,
          tier: 1,
          resolved: true,
          verdict: verdict.verdict,
          winner: verdict.winner,
          inferenceCalls,
          ledger,
        };
      }
      this.emitEscalated(1, "oracle declined authority over this subject");
    }

    // ---------------------------------------------------------------- Tier 2
    this.assertLive(signal, 2);
    {
      const plan: ResolutionPlan = {
        tier: 2,
        kind: "recompute",
        samples: this.recomputeSamples,
        entropyOverride: this.recomputeEntropy,
      };
      this.emitPlan(plan);

      const tally = new Map<string, number>();
      for (let i = 0; i < this.recomputeSamples; i++) {
        const sample = await this.recomputeSample(dispute, parties, signal);
        inferenceCalls++;
        if (sample) {
          tally.set(sample, (tally.get(sample) ?? 0) + 1);
          ledger.record("recompute", "evidence", `sample ${i + 1} supports ${sample}`);
        } else {
          ledger.record("recompute", "evidence", `sample ${i + 1} was invalid or unparsable`);
        }
      }

      let winner: string | null = null;
      let winnerCount = 0;
      for (const [party, count] of tally) {
        if (count > winnerCount) {
          winner = party;
          winnerCount = count;
        }
      }

      if (winner !== null && winnerCount > this.recomputeSamples / 2) {
        const verdict =
          `Strict majority of independent re-computation (${winnerCount}/${this.recomputeSamples}) ` +
          `supports ${winner}.`;
        ledger.record(winner, "verdict", verdict);
        return {
          disputeId: dispute.id,
          tier: 2,
          resolved: true,
          verdict,
          winner,
          inferenceCalls,
          ledger,
        };
      }
      this.emitEscalated(2, "no strict majority among re-computation samples");
    }

    // ---------------------------------------------------------------- Tier 3
    this.assertLive(signal, 3);
    {
      const plan: ResolutionPlan = { tier: 3, kind: "judge", charter: this.judgeCharter };
      this.emitPlan(plan);

      let violations: string[] = [];
      for (let attempt = 1; attempt <= 2; attempt++) {
        const turn = await this.brain.digest(
          this.judgeMessages(dispute, violations, attempt),
          this.noToolsSchedule(this.recomputeEntropy / 2, signal),
        );
        inferenceCalls++;

        const extracted = extractJsonObject(turn.content);
        const record = extracted.ok ? asRecord(extracted.value) : null;
        const winner = record ? (record["winner"] as unknown) : undefined;
        const verdictText = record ? (record["verdict"] as unknown) : undefined;

        if (
          record &&
          typeof winner === "string" &&
          parties.includes(winner) &&
          typeof verdictText === "string" &&
          verdictText.length > 0
        ) {
          ledger.record(winner, "verdict", verdictText);
          return {
            disputeId: dispute.id,
            tier: 3,
            resolved: true,
            verdict: verdictText,
            winner,
            inferenceCalls,
            ledger,
          };
        }

        violations = [
          extracted.ok
            ? "verdict must be a JSON object with string fields 'winner' (a party id) and 'verdict'"
            : "output was not parseable as JSON",
        ];
      }
      this.emitEscalated(3, "judge failed to emit a valid verdict after retry");
    }

    // ---------------------------------------------------------------- Tier 4
    this.assertLive(signal, 4);
    if (!this.humanGate) {
      throw new DisputeResolutionError(
        4,
        "lattice exhausted and no human gate is configured",
      );
    }

    const plan: ResolutionPlan = {
      tier: 4,
      kind: "human-gate",
      timeoutMs: this.humanGateTimeoutMs,
    };
    this.emitPlan(plan);

    const gateOutcome = await this.withDeadline(
      this.humanGate.requestVerdict(dispute, this.humanGateTimeoutMs),
      this.humanGateTimeoutMs,
      4,
    );

    if (
      gateOutcome.accepted &&
      gateOutcome.winner !== null &&
      parties.includes(gateOutcome.winner)
    ) {
      ledger.record(gateOutcome.winner, "verdict", gateOutcome.verdict);
      return {
        disputeId: dispute.id,
        tier: 4,
        resolved: true,
        verdict: gateOutcome.verdict,
        winner: gateOutcome.winner,
        inferenceCalls,
        ledger,
      };
    }

    ledger.record("human-gate", "concession", gateOutcome.verdict);
    throw new DisputeResolutionError(
      4,
      `human gate rejected the dispute: ${gateOutcome.verdict}`,
    );
  }

  /**
   * One independent re-computation sample.
   * Returns the supported party, or null for invalid/unparsable output.
   */
  private async recomputeSample(
    dispute: Dispute,
    parties: string[],
    signal: AbortSignal | undefined,
  ): Promise<string | null> {
    const prompt = [
      "RE-COMPUTATION SAMPLE - DISPUTE ARBITRATION",
      `Subject under dispute: ${dispute.subject}`,
      "",
      ...dispute.claims.map(
        (c) => `Party "${c.party}" asserts: ${c.content}\n  Evidence: ${c.evidence}`,
      ),
      "",
      'Independently evaluate which party is best supported. Emit one JSON object: {"supports": "<party>", "rationale": "..."}',
    ].join("\n");

    const turn = await this.brain.digest(
      [
        { role: "system", content: "You are an independent verifier. Emit JSON only." },
        { role: "user", content: prompt },
      ],
      this.noToolsSchedule(this.recomputeEntropy, signal),
    );

    const extracted = extractJsonObject(turn.content);
    if (!extracted.ok) return null;
    const record = asRecord(extracted.value);
    const supports = record ? (record["supports"] as unknown) : undefined;
    return typeof supports === "string" && parties.includes(supports) ? supports : null;
  }

  private judgeMessages(
    dispute: Dispute,
    violations: readonly string[],
    attempt: number,
  ): ChatMsg[] {
    const user = [
      "ARBITRATION - FINAL JUDGMENT",
      `Subject under dispute: ${dispute.subject}`,
      "",
      ...dispute.claims.map(
        (c) => `Party "${c.party}" asserts: ${c.content}\n  Evidence: ${c.evidence}`,
      ),
      "",
      'Emit one JSON object: {"winner": "<party>", "verdict": "<reasoning>"}',
    ];

    if (attempt > 1) {
      user.push(
        "",
        "RETRY - your previous verdict was rejected.",
        "Violations:",
        ...violations.map((v) => `- ${v}`),
      );
    }

    return [
      { role: "system", content: this.judgeCharter },
      { role: "user", content: user.join("\n") },
    ];
  }

  private noToolsSchedule(
    entropyOverride: number,
    signal: AbortSignal | undefined,
  ): RequestSchedule {
    return {
      mounting: { manifests: [] },
      entropyOverride,
      killSwitch: signal ?? new AbortController().signal,
    };
  }

  private assertLive(signal: AbortSignal | undefined, tier: 1 | 2 | 3 | 4): void {
    if (signal?.aborted) {
      throw new DisputeResolutionError(tier, "aborted by kill switch");
    }
  }

  private withDeadline<T>(
    promise: Promise<T>,
    timeoutMs: number,
    tier: 1 | 2 | 3 | 4,
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        setTimeout(
          () =>
            reject(
              new DisputeResolutionError(
                tier,
                `human gate timed out after ${timeoutMs}ms`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  }

  private emitPlan(plan: ResolutionPlan): void {
    this.sink?.emit("dispute:plan", { ...plan });
  }

  private emitEscalated(tier: 1 | 2 | 3, reason: string): void {
    this.sink?.emit("dispute:escalated", { fromTier: tier, reason });
  }
}
