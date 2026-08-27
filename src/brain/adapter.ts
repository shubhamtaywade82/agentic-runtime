import { OllamaClient } from "@nemesis-oss/ollama-sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import type {
  ThoughtProcess,
  ThoughtPortConfig,
  ChatMsg,
  RequestSchedule,
  AssistantTurn,
  ToolCallRequest,
  TurnUsage,
  MountedTools,
  JSONSchema7,
  InferenceQualityError,
  TransportFailure,
} from "../core/types.js";

/**
 * Coerce raw tool arguments to Record<string, unknown>.
 * Handles stringified JSON and malformed payloads.
 */
function coerce(rawArgs: unknown): Record<string, unknown> {
  if (typeof rawArgs === "string") {
    try {
      return JSON.parse(rawArgs);
    } catch {
      throw new InferenceQualityError("Malformed tool argument payload.", ["malformed_json"]);
    }
  }
  if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    return rawArgs as Record<string, unknown>;
  }
  throw new InferenceQualityError("Non-object tool arguments.", ["non_object_args"]);
}

/**
 * Convert Zod schema to JSON Schema (conservative, OpenAPI 3 compatible).
 */
function toJsonSchema(schema: unknown): JSONSchema7 {
  return zodToJsonSchema(schema as any, { target: "openApi3" }) as JSONSchema7;
}

/**
 * OllamaThoughtProcess - Adapter for @nemesis-oss/ollama-sdk.
 * 
 * Key architectural decisions:
 * - Does NOT attach JSON Schema to `format` while tools are mounted (prevents grammar collision)
 * - Uses model-native tool calling for ≥7B parameter models
 * - Handles partial-write truncation via `length_truncated` finishTag
 * - Memoized model provisioning via SDK's auto-provision
 */
export class OllamaThoughtProcess implements ThoughtProcess {
  private remote: OllamaClient;
  private readonly modelAlias: string;
  private readonly defaults: NonNullable<ThoughtPortConfig["defaults"]>;

  constructor(cfg: ThoughtPortConfig, modelAlias: string) {
    this.modelAlias = modelAlias;
    this.defaults = cfg.defaults ?? {};
    this.remote = new OllamaClient({
      baseUrl: cfg.baseUrl,
      endpoints: cfg.defaults?.timeoutMs ? undefined : undefined, // SDK handles failover
      timeoutMs: this.defaults.timeoutMs ?? 60_000,
      retries: this.defaults.retries ?? 2,
    });
  }

  get identityTag(): string {
    return `ollama:${this.modelAlias}`;
  }

  async digest(messages: ChatMsg[], schedule: RequestSchedule): Promise<AssistantTurn> {
    const startTime = performance.now();

    const options: Record<string, unknown> = {};
    if (schedule.entropyOverride !== undefined) {
      options.temperature = schedule.entropyOverride;
    } else {
      options.temperature = 0.1; // Low entropy for deterministic tool calling
    }
    if (this.defaults.numCtx) {
      options.num_ctx ??= this.defaults.numCtx;
    }

    // Build payload for SDK chat call
    const payload: Record<string, unknown> = {
      model: this.modelAlias,
      messages,
      stream: false,
      options,
    };

    // Mount tools if provided (model-native tool calling)
    if (schedule.mounting?.manifests.length) {
      payload.tools = schedule.mounting.manifests.map((m) => ({
        type: "function",
        function: {
          name: m.name,
          description: m.description,
          parameters: m.parametersJsonSchema,
        },
      }));
      // CRITICAL: Do NOT set `format` while tools are mounted.
      // Grammar-constrained decoding + tool calling = token probability collapse.
    } else if (schedule.constrain?.subjectOutputSchema) {
      // Only apply grammar constraint when NO tools are mounted
      payload.format = schedule.constrain.subjectOutputSchema;
    }

    if (schedule.idleLiveSeconds) {
      payload.keep_alive = schedule.idleLiveSeconds;
    } else if (this.defaults.idleLiveSeconds) {
      payload.keep_alive = this.defaults.idleLiveSeconds;
    }

    // Signal handling for cancellation
    const abortSignal = schedule.killSwitch;
    let aborted = false;
    const abortHandler = () => { aborted = true; };
    abortSignal.addEventListener("abort", abortHandler);

    try {
      // Call SDK - returns { messages: ChatMsg[], done: boolean, done_reason: string, ... }
      const response = await this.remote.chat(payload as any);
      
      const durationMs = performance.now() - startTime;

      // SDK returns messages array; assistant turn is the last message with role='assistant'
      const assistantMsg = response.messages
        ?.filter((m: any) => m.role === "assistant")
        .pop() ?? response.messages?.[response.messages.length - 1];

      if (!assistantMsg) {
        throw new InferenceQualityError("No assistant message in response.", ["missing_assistant_message"]);
      }

      const toolCalls = assistantMsg.tool_calls ?? [];
      const finishReason = response.done_reason ?? (toolCalls.length > 0 ? "tool_calls" : "stop");
      
      // Map done_reason to finishTag
      let finishTag: AssistantTurn["finishTag"] = "stop";
      if (toolCalls.length > 0) {
        finishTag = "tool_calls";
      } else if (finishReason === "length") {
        finishTag = "length_truncated";
      }

      return {
        content: assistantMsg.content ?? "",
        toolCalls: toolCalls.map((tc: any, i: number) => ({
          id: tc.id ?? `${i}-${crypto.randomUUID()}`,
          name: tc.function?.name ?? `unknown_${i}`,
          arguments: coerce(tc.function?.arguments ?? {}),
        })),
        finishTag,
        usage: {
          promptTokens: response.prompt_eval_count ?? -1,
          evalTokens: response.eval_count ?? -1,
          totalDurationMs: durationMs,
          loadDurationMs: response.load_duration ?? -1,
        },
      };
    } catch (err) {
      if (aborted) {
        throw new Error("Inference aborted by kill switch");
      }
      if (isTransientTransport(err)) {
        throw new TransportFailure(err instanceof Error ? err.message : String(err), undefined, err);
      }
      throw new InferenceQualityError(
        `Thought digest failed upstream: ${err instanceof Error ? err.message : String(err)}`,
        ["upstream_error"],
      );
    } finally {
      abortSignal.removeEventListener("abort", abortHandler);
    }
  }
}

/**
 * Check if an error is a transient transport failure (retryable).
 * Delegates to core/types for single source of truth.
 */
function isTransientTransport(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|5\d\d/.test(`${err.name} ${err.message}`);
}

/**
 * Factory to create an OllamaThoughtProcess with default config.
 * @public
 */
export function createOllamaThoughtProcess(
  baseUrl: string,
  modelAlias: string,
  defaults?: ThoughtPortConfig["defaults"],
): OllamaThoughtProcess {
  return new OllamaThoughtProcess({ baseUrl, defaults }, modelAlias);
}