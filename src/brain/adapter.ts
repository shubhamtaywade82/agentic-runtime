import { OllamaClient, type ChatRequestOptions, type ChatResponse } from "@nemesis-oss/ollama-sdk";
import type {
  ThoughtProcess,
  ThoughtPortConfig,
  ChatMsg,
  RequestSchedule,
  AssistantTurn,
} from "../core/types.js";
import { InferenceQualityError, TransportFailure } from "../core/types.js";

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
 * SDK Chat response structure (flexible to handle version differences).
 */
interface SDKChatResponse {
  messages?: Array<{ role: string; content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> }>;
  message?: { role: string; content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> };
  content?: string;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }>;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  load_duration?: number;
  total_duration?: number;
}

/**
 * OllamaThoughtProcess - Adapter for \@nemesis-oss/ollama-sdk.
 * 
 * Key architectural decisions:
 * - Does NOT attach JSON Schema to `format` while tools are mounted (prevents grammar collision)
 * - Uses model-native tool calling for ≥7B parameter models
 * - Handles partial-write truncation via `length_truncated` finishTag
 * - Memoized model provisioning via SDK's auto-provision
 * @public
 */
export class OllamaThoughtProcess implements ThoughtProcess {
  private remote: OllamaClient;
  private readonly modelAlias: string;
  private readonly defaults: NonNullable<ThoughtPortConfig["defaults"]>;

  constructor(cfg: ThoughtPortConfig, modelAlias: string) {
    this.modelAlias = modelAlias;
    this.defaults = cfg.defaults ?? {};
    const clientConfig: Record<string, unknown> = {
      baseUrl: cfg.baseUrl,
      timeoutMs: this.defaults.timeoutMs ?? 60_000,
      retries: this.defaults.retries ?? 2,
    };
    // Only add endpoints if explicitly provided
    if (this.defaults.timeoutMs) {
      // endpoints would be configured separately if needed
    }
    // SDK config type is not fully exported, use type assertion
    this.remote = new OllamaClient(clientConfig as Record<string, unknown>);
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
    const payload: ChatRequestOptions = {
      model: this.modelAlias,
      messages: messages as any, // SDK expects specific message format
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
      // Call SDK - response structure depends on SDK version
      const response = await this.remote.chat(payload);
      
      const durationMs = performance.now() - startTime;

      // Handle different response structures from SDK
      // Try to extract assistant message from various possible response shapes
      let assistantMsg: SDKChatResponse | null = null;
      let doneReason: string | undefined;
      let promptTokens: number = -1;
      let evalTokens: number = -1;
      let loadDuration: number = -1;

      if (response && typeof response === "object") {
        // Try messages array first
        if (Array.isArray(response.messages)) {
          const msgs = response.messages;
          assistantMsg = msgs
            ?.filter((m) => m.role === "assistant")
            .pop() ?? msgs?.[msgs.length - 1] ?? null;
          doneReason = response.done_reason;
        }
        // Try direct message property
        else if (response.message) {
          assistantMsg = response.message;
          doneReason = response.done_reason;
        }
        // Try direct properties (response itself is the message)
        else if (response.content !== undefined) {
          assistantMsg = response;
        }

        promptTokens = response.prompt_eval_count ?? -1;
        evalTokens = response.eval_count ?? -1;
        loadDuration = response.load_duration ?? -1;
      }

      if (!assistantMsg) {
        throw new InferenceQualityError("No assistant message in response.", ["missing_assistant_message"]);
      }

      const toolCalls = assistantMsg?.tool_calls ?? [];
      const finishReason = doneReason ?? (toolCalls.length > 0 ? "tool_calls" : "stop");
      
      // Map done_reason to finishTag
      let finishTag: AssistantTurn["finishTag"] = "stop";
      if (toolCalls.length > 0) {
        finishTag = "tool_calls";
      } else if (finishReason === "length") {
        finishTag = "length_truncated";
      }

      return {
        content: assistantMsg?.content ?? "",
        toolCalls: toolCalls.map((tc: { id?: string; function?: { name?: string; arguments?: unknown } }, i: number) => ({
          id: tc.id ?? `${i}-${crypto.randomUUID()}`,
          name: tc.function?.name ?? `unknown_${i}`,
          arguments: coerce(tc.function?.arguments ?? {}),
        })),
        finishTag,
        usage: {
          promptTokens,
          evalTokens,
          totalDurationMs: durationMs,
          loadDurationMs: loadDuration,
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
  return new OllamaThoughtProcess({ baseUrl, defaults: defaults ?? {} }, modelAlias);
}