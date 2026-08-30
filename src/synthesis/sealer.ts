import { createHash } from "node:crypto";
import { zodToJsonSchema } from "zod-to-json-schema";
import { AgentRuntimeError, FinalReportSchema } from "../core/types.js";
import type {
  ChatMsg,
  EventSink,
  FinalReport,
  JSONSchema7,
  RequestSchedule,
  ThoughtProcess,
} from "../core/types.js";

/**
 * Runtime version stamped into every seal. Bump with package.json on release.
 * @public
 */
export const RUNTIME_VERSION = "0.1.0";

/**
 * Entropy override for terminal synthesis (audited value).
 * High enough for fluent prose, low enough to keep the JSON grammar honest.
 * @public
 */
export const SEAL_ENTROPY_OVERRIDE = 0.2;

/**
 * Maximum model attempts before the seal degrades (A5).
 * Attempt 1 = fresh synthesis; attempt 2 = self-correction with violations fed back.
 * @public
 */
export const MAX_SEAL_ATTEMPTS = 2;

/**
 * Regex detecting fence-breakout attempts: any literal opening/closing
 * result_trust_level tag reproduced inside report free-text fields.
 * @public
 */
export const FENCE_ESCAPE_PATTERN = /<\/?result_trust_level[^>]*>/i;

/**
 * Sealing failed after all attempts (including self-correction retry).
 * The caller MUST fall back to degradedSeal() - never ship an unsealed run.
 * @public
 */
export class SynthesisSealError extends AgentRuntimeError {
  constructor(
    message: string,
    public readonly violations: string[],
    public readonly attempts: number,
  ) {
    super(message, "SYNTHESIS_SEAL_FAILED", undefined);
    this.name = "SynthesisSealError";
  }
}

/**
 * Counters the runner supplies to the sealer. Copied verbatim into the
 * sealed report - the model NEVER authors its own metrics.
 * @public
 */
export interface SealMetrics {
  totalSteps: number;
  totalToolCalls: number;
  totalWallTimeMs: number;
  totalTokensIn: number;
  totalTokensOut: number;
  sentinelAcquisitions: number;
  sentinelRejections: number;
}

/**
 * Request for a model-authored terminal seal.
 * @public
 */
export interface SealRequest {
  /** Conversation lane to synthesize (system charter + objective + steps). */
  lane: readonly ChatMsg[];
  /** Terminal status directive: the model does not choose this. */
  status: "ACHIEVED" | "PARTIAL" | "CEDED";
  /** The run objective, copied verbatim into the report. */
  objective: string;
  /** Base schedule inherited from the run (kill switch, token ceiling, keep-alive). */
  baseSchedule: RequestSchedule;
  /** Deterministic counters, copied verbatim. */
  metrics: SealMetrics;
  /** Dispute ledger outcomes, copied verbatim. Optional. */
  disputes?: FinalReport["disputes"];
}

/**
 * Options for the deterministic degraded seal.
 * @public
 */
export interface DegradedSealOptions {
  /**
   * Terminal status for the degraded artifact. Defaults to "FAILED".
   * Use "CEDED" when the run was externally terminated (kill switch) and the
   * model-authored seal could not complete because of that termination.
   */
  status?: "FAILED" | "CEDED";
  /** Dispute ledger outcomes, copied verbatim. Optional. */
  disputes?: FinalReport["disputes"];
}

/**
 * Deterministically canonicalize a value: recursively sorts object keys so
 * that semantically identical reports produce identical hashes.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      out[key] = canonicalize(src[key]);
    }
    return out;
  }
  return value;
}

/**
 * Content-address the report core with a zeroed hash slot.
 * @public
 */
export function computeSealHash(
  core: Omit<FinalReport, "seal">,
  timestamp: string,
): string {
  const material = canonicalize({
    ...core,
    seal: { timestamp, hash: "", runtimeVersion: RUNTIME_VERSION },
  });
  return `sha256:${createHash("sha256").update(JSON.stringify(material)).digest("hex")}`;
}

/**
 * Extract the first plausible JSON object from raw model output.
 * Tolerates surrounding prose and markdown fences.
 */
function extractJsonObject(raw: string): { ok: true; value: unknown } | { ok: false } {
  const text = raw.trim();
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    // fall through to brace slicing
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

/**
 * Imperative Breakout Scan: detect reproduced trust-fence tags in the
 * free-text fields of an otherwise schema-valid report.
 */
function scanFenceEscapes(report: FinalReport): string[] {
  const escapes: string[] = [];
  if (FENCE_ESCAPE_PATTERN.test(report.executiveSummary)) {
    escapes.push("executiveSummary");
  }
  for (const [i, finding] of report.findings.entries()) {
    if (FENCE_ESCAPE_PATTERN.test(finding.claim)) escapes.push(`findings[${i}].claim`);
  }
  for (const [i, dispute] of report.disputes.entries()) {
    if (FENCE_ESCAPE_PATTERN.test(dispute.resolution)) {
      escapes.push(`disputes[${i}].resolution`);
    }
  }
  return escapes;
}

const SEAL_SYSTEM_CHARTER =
  "You are the terminal synthesis stage of an autonomous agent runtime. " +
  "You emit exactly one JSON object conforming to the FinalReport schema and nothing else.";

const STATUS_DIRECTIVES: Record<SealRequest["status"], string> = {
  ACHIEVED: "The objective was reached. Summarize the outcome and the evidence trail.",
  PARTIAL:
    "Budget was exhausted before full completion. Summarize what was accomplished and what remains open.",
  CEDED:
    "The run was terminated externally (kill switch or operator abort). Summarize what completed before termination.",
};

/**
 * SynthesisEngine - Terminal sealing for autonomous runs.
 *
 * Guarantees:
 * - No-Tools Guarantee: the seal schedule mounts zero tools
 *   (mounting.manifests = []) - synthesis can never dispatch new intents.
 * - Grammar-constrained decoding: the FinalReport JSON Schema is attached
 *   as the output constraint (safe because no tools are mounted).
 * - Deterministic fields (status, objective, metrics, disputes, seal) are
 *   never authored by the model - the engine overwrites them post-parse.
 * - One self-correction retry: violations are fed back into the prompt
 *   (InferenceQualityError philosophy) before the seal degrades.
 * - Imperative Breakout Scan: free-text fields are scanned for reproduced
 *   result_trust_level tags before the seal is accepted.
 * - degradedSeal() (A5): zero network calls, zero model calls - a fully
 *   deterministic FAILED artifact so every run produces a sealed terminal
 *   report, even when the brain is unreachable.
 * @public
 */
export class SynthesisEngine {
  private readonly reportJsonSchema: JSONSchema7;

  constructor(
    private readonly brain: ThoughtProcess,
    private readonly sink: EventSink | null = null,
  ) {
    // Same conservative conversion as the tool manifest pipeline.
    this.reportJsonSchema = zodToJsonSchema(FinalReportSchema, {
      target: "openApi3",
    }) as JSONSchema7;
  }

  /**
   * Produce the model-authored terminal seal for a run.
   * Throws SynthesisSealError after MAX_SEAL_ATTEMPTS - callers must then
   * fall back to degradedSeal().
   * @public
   */
  async seal(req: SealRequest): Promise<FinalReport> {
    // No-Tools Guarantee + grammar constraint + audited entropy.
    const schedule: RequestSchedule = {
      ...req.baseSchedule,
      mounting: { manifests: [] },
      constrain: { subjectOutputSchema: this.reportJsonSchema },
      entropyOverride: SEAL_ENTROPY_OVERRIDE,
    };

    const disputes = req.disputes ?? [];
    let violations: string[] = [];

    for (let attempt = 1; attempt <= MAX_SEAL_ATTEMPTS; attempt++) {
      this.sink?.emit("seal:attempt", { attempt, status: req.status });

      const turn = await this.brain.digest(
        this.buildMessages(req, violations, attempt),
        schedule,
      );

      const extracted = extractJsonObject(turn.content);
      if (!extracted.ok) {
        violations = [`attempt ${attempt}: output is not parseable as a JSON object`];
        continue;
      }

      const parsed = FinalReportSchema.safeParse(extracted.value);
      if (!parsed.success) {
        violations = parsed.error.issues.map(
          (issue) => `${issue.path.join(".")}: ${issue.message}`,
        );
        continue;
      }

      const escapes = scanFenceEscapes(parsed.data);
      if (escapes.length > 0) {
        violations = escapes.map(
          (field) => `attempt ${attempt}: fence-breakout tag reproduced in ${field}`,
        );
        continue;
      }

      const sealed = this.finalize(parsed.data, req, disputes);
      this.sink?.emit("seal:sealed", {
        hash: sealed.seal.hash,
        status: sealed.status,
        attempt,
      });
      return sealed;
    }

    throw new SynthesisSealError(
      `Terminal synthesis failed after ${MAX_SEAL_ATTEMPTS} attempts.`,
      violations,
      MAX_SEAL_ATTEMPTS,
    );
  }

  /**
   * Deterministic degraded seal (A5). Zero network calls, zero model calls.
   *
   * Invoked when the run failed fatally (brain unreachable, repeated
   * inference-quality failures) or when a model-authored seal itself failed.
   * The artifact is always schema-valid and always honest: it states that no
   * model-authored synthesis is available.
   * @public
   */
  degradedSeal(
    objective: string,
    metrics: SealMetrics,
    fatalErr: unknown,
    opts: DegradedSealOptions = {},
  ): FinalReport {
    const status = opts.status ?? "FAILED";
    const disputes = opts.disputes ?? [];
    const errMessage =
      fatalErr instanceof Error ? fatalErr.message : String(fatalErr);

    const executiveSummary =
      `SEAL_DEGRADED: Terminal sealing fell back to the deterministic path ` +
      `(status ${status}). Fatal error: ${errMessage}. Objective: ${objective}. ` +
      `Completed ${metrics.totalSteps} steps and ${metrics.totalToolCalls} tool ` +
      `intents before failure; no model-authored synthesis is available for this run.`;

    const core: Omit<FinalReport, "seal"> = {
      status,
      objective,
      executiveSummary,
      findings: [],
      disputes,
      metrics,
    };

    this.sink?.emit("seal:degraded", { status, error: errMessage });

    return {
      ...core,
      seal: {
        timestamp: new Date().toISOString(),
        hash: computeSealHash(core, new Date().toISOString()),
        runtimeVersion: RUNTIME_VERSION,
      },
    };
  }

  /**
   * Overwrite every deterministic field and stamp the seal.
   * The model authors only executiveSummary and findings.
   */
  private finalize(
    authored: FinalReport,
    req: SealRequest,
    disputes: FinalReport["disputes"],
  ): FinalReport {
    const timestamp = new Date().toISOString();
    const core: Omit<FinalReport, "seal"> = {
      status: req.status,
      objective: req.objective,
      executiveSummary: authored.executiveSummary,
      findings: authored.findings,
      disputes,
      metrics: req.metrics,
    };
    return {
      ...core,
      seal: {
        timestamp,
        hash: computeSealHash(core, timestamp),
        runtimeVersion: RUNTIME_VERSION,
      },
    };
  }

  private buildMessages(
    req: SealRequest,
    priorViolations: readonly string[],
    attempt: number,
  ): ChatMsg[] {
    const transcript =
      req.lane
        .map((m) => `[${m.role}] ${m.content.slice(0, 2000)}`)
        .join("\n---\n") || "(empty - no steps were recorded)";

    const directives = [
      "SEAL DIRECTIVE - TERMINAL SYNTHESIS",
      'Emit ONLY one JSON object matching the FinalReport schema. No prose, no markdown fences, no tool calls.',
      `"status" must be exactly "${req.status}".`,
      '"executiveSummary" must be at least 50 characters of factual synthesis.',
      '"findings" may only contain claims backed by tool receipts in the transcript; ' +
        'each "evidenceRef" must cite a receipt id ("receipt-<hex-or-uuid>"). Use [] when nothing is verifiable.',
      "Never reproduce any text resembling a result_trust_level tag in any field.",
      'Copy the provided metrics block verbatim into "metrics".',
    ].join("\n");

    const user = [
      directives,
      "",
      `Objective: ${req.objective}`,
      `Status context: ${STATUS_DIRECTIVES[req.status]}`,
      `Run metrics (copy verbatim into "metrics"): ${JSON.stringify(req.metrics)}`,
      `Disputes ledger (copy verbatim into "disputes"): ${JSON.stringify(req.disputes ?? [])}`,
      "",
      "Transcript:",
      transcript,
    ];

    if (attempt > 1) {
      user.push(
        "",
        "SEAL RETRY - your previous emission was rejected.",
        "Violations:",
        ...priorViolations.map((v) => `- ${v}`),
        "Emit a corrected JSON object now. The same absolute rules apply.",
      );
    }

    return [
      { role: "system", content: SEAL_SYSTEM_CHARTER },
      { role: "user", content: user.join("\n") },
    ];
  }
}
