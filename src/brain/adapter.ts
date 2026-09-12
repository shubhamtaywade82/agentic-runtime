import { OllamaClient } from "@nemesis-oss/ollama-sdk";
import type {
  ThoughtProcess,
  ThoughtPortConfig,
  ChatMsg,
  RequestSchedule,
  AssistantTurn,
} from "../core/types.js";
import {
  InferenceQualityError,
  RunAbortedError,
  TransportFailure,
  isInferenceQualityError,
  isTransientTransport,
} from "../core/types.js";

/**
 * Internal SDK response structure for type-safe handling.
 *
 * Mirrors the SDK 1.x ChatResponse shape: a single `message` object. (The
 * historical `messages` array fallback was dead code - no released SDK
 * version ever returned a conversation array from /api/chat.)
 */
interface SDKMessage {
  role: string;
  content?: string;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }>;
}

interface SDKChatResponse {
  message?: SDKMessage;
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  load_duration?: number;
  total_duration?: number;
}

/**
 * Coerce raw tool arguments to Record<string, unknown>.
 * Handles stringified JSON and malformed payloads.
 * Throws InferenceQualityError on malformed payloads (not transport).
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
 * Convert nanoseconds to milliseconds (native Ollama durations are in ns).
 */
function nsToMs(v?: number): number {
  return typeof v === "number" && v >= 0 ? v / 1_000_000 : -1;
}

/**
 * OllamaThoughtProcess - Adapter for \@nemesis-oss/ollama-sdk.
 * 
 * Key architectural decisions:
 * - Does NOT attach JSON Schema to `format` while tools are mounted (prevents grammar collision)
 * - Uses model-native tool calling for ≥7B parameter models
 * - Handles partial-write truncation via `length_truncated` finishTag
 * - Memoized model provisioning via SDK's auto-provision
 * - Forwards the schedule kill switch into the SDK request (`signal`), so
 *   aborting cancels the in-flight HTTP call instead of only being noticed
 *   after the response arrives
 * @public
 */
export class OllamaThoughtProcess implements ThoughtProcess {
  private remote: OllamaClient;
  private readonly modelAlias: string;
  private readonly defaults: NonNullable<ThoughtPortConfig["defaults"]>;
  private onToken?: ((delta: string) => void) | undefined;
  private onThinking?: ((delta: string) => void) | undefined;

  constructor(
    cfg: ThoughtPortConfig | { client: OllamaClient | any; model?: string; onToken?: ((delta: string) => void) | undefined; onThinking?: ((delta: string) => void) | undefined },
    modelAlias?: string,
  ) {
    if ("client" in cfg) {
      this.remote = cfg.client;
      this.modelAlias = cfg.model ?? (cfg.client as any).model ?? "openbmb/minicpm5-2b";
      this.defaults = {};
      this.onToken = cfg.onToken;
      this.onThinking = cfg.onThinking;
    } else {
      this.modelAlias = modelAlias!;
      this.defaults = cfg.defaults ?? {};
      this.onToken = this.defaults.onToken;
      this.onThinking = this.defaults.onThinking;
      const clientConfig: Record<string, unknown> = {
        baseUrl: cfg.baseUrl,
        timeoutMs: this.defaults.timeoutMs ?? 60_000,
        retries: this.defaults.retries ?? 2,
      };
      this.remote = new OllamaClient(clientConfig as Record<string, unknown>);
    }
  }

  setOnToken(fn?: ((delta: string) => void) | undefined): void {
    this.onToken = fn;
  }

  setOnThinking(fn?: ((delta: string) => void) | undefined): void {
    this.onThinking = fn;
  }

  private async streamChat(
    payload: Record<string, unknown>,
    opts: {
      abortSignal: AbortSignal;
      aborted: () => boolean;
      onToken?: ((delta: string) => void) | undefined;
      onThinking?: ((delta: string) => void) | undefined;
    },
  ): Promise<SDKChatResponse> {
    payload.stream = true;
    const stream = await (this.remote as any).chat(payload);
    for await (const event of stream) {
      if (opts.aborted() || opts.abortSignal.aborted) {
        stream.abort?.();
        throw new RunAbortedError("Inference aborted by kill switch");
      }
      if (event.type === "token" && event.data?.delta && opts.onToken) {
        opts.onToken(event.data.delta);
      } else if (event.type === "thinking" && event.data?.delta && opts.onThinking) {
        opts.onThinking(event.data.delta);
      }
    }
    const finalRes = await stream.finalResult;
    return {
      message: finalRes.message,
      done: finalRes.done,
      done_reason: finalRes.doneReason,
      prompt_eval_count: finalRes.usage?.promptTokens ?? finalRes.raw?.prompt_eval_count,
      eval_count: finalRes.usage?.completionTokens ?? finalRes.raw?.eval_count,
      model: finalRes.model,
      total_duration: finalRes.raw?.total_duration,
      load_duration: finalRes.raw?.load_duration,
      prompt_eval_duration: finalRes.raw?.prompt_eval_duration,
      eval_duration: finalRes.raw?.eval_duration,
    } as unknown as SDKChatResponse;
  }

  get identityTag(): string {
    return `ollama:${this.modelAlias}`;
  }

  async digest(messages: ChatMsg[], schedule: RequestSchedule): Promise<AssistantTurn> {
    const options: Record<string, unknown> = {};
    if (schedule.entropyOverride !== undefined) {
      options.temperature = schedule.entropyOverride;
    } else {
      options.temperature = 0.1; // Low entropy for deterministic tool calling
    }
    if (this.defaults.numCtx) {
      options.num_ctx = this.defaults.numCtx;
    }

    // Build payload for SDK chat call
    // Use type assertion to bypass read-only properties in SDK types
    const payload: Record<string, unknown> = {
      model: this.modelAlias,
      messages: messages as SDKMessage[],
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

    // Keep-alive to prevent reload latency spikes mid-loop
    if (schedule.idleLiveSeconds) {
      payload.keep_alive = schedule.idleLiveSeconds;
    } else if (this.defaults.idleLiveSeconds) {
      payload.keep_alive = this.defaults.idleLiveSeconds;
    }

    // Signal handling for cancellation.
    // The `aborted` flag + post-call check covers SDKs without signal
    // support; the payload signal makes the daemon-side request itself
    // cancellable (SDK >= 1.3 ChatRequestOptions.signal).
    const abortSignal = schedule.killSwitch;
    let aborted = false;
    const abortHandler = () => { aborted = true; };
    abortSignal.addEventListener("abort", abortHandler, { once: true });

    try {
      // Check if already aborted before calling
      if (abortSignal.aborted) {
        throw new RunAbortedError("Inference aborted by kill switch");
      }

      // Propagate the kill switch into the SDK request so aborting cancels
      // the in-flight HTTP call (audit fix: was previously only observed
      // after the response arrived, so in-flight inference was unkillable).
      payload.signal = abortSignal;

      let r: SDKChatResponse;
      const isSealPhase = schedule.constrain !== undefined;
      const onToken = schedule.onToken ?? this.onToken;
      const onThinking = schedule.onThinking ?? this.onThinking;
      if (onToken && !isSealPhase) {
        r = await this.streamChat(payload, {
          abortSignal,
          aborted: () => aborted,
          onToken,
          onThinking,
        });
      } else {
        payload.stream = false;
        const response = await this.remote.chat(payload as any);
        r = response as unknown as SDKChatResponse;
      }
      
      // Double check abort signal after the potentially long async call
      if (aborted || abortSignal.aborted) {
        throw new RunAbortedError("Inference aborted by kill switch");
      }
      
      // The assistant message is the response's `message` field (SDK 1.x
      // ChatResponse shape).
      const assistantMsg = r.message ?? null;
      const doneReason = r.done_reason;
      
      if (!assistantMsg) {
        throw new InferenceQualityError("No assistant message in response.", ["missing_assistant_message"]);
      }

      // D1: Detect truncation via done_reason = "length"
      // The native daemon emits done_reason ∈ { "stop" | "length" | "load" }
      const truncated = r.done === true && doneReason === "length";

      const toolCalls = assistantMsg.tool_calls ?? [];
      
      // D1: Safety policy - NEVER execute fragments from truncated emission
      // Truncated argument JSON would cause Zod rejection downstream,
      // misdiagnosed as parameter mistake instead of generation-ceiling event
      const finalToolCalls = truncated ? [] : toolCalls;

      // Map done_reason to finishTag
      let finishTag: AssistantTurn["finishTag"] = "stop";
      if (truncated) {
        finishTag = "length_truncated";
      } else if (finalToolCalls.length > 0) {
        finishTag = "tool_calls";
      } else if (doneReason === "length") {
        finishTag = "length_truncated";
      }

      return {
        content: assistantMsg.content ?? "",
        toolCalls: finalToolCalls.map((tc: { id?: string; function?: { name?: string; arguments?: unknown } }, i: number) => ({
          id: tc.id ?? `${i}-${crypto.randomUUID()}`,
          name: tc.function?.name ?? `unknown_${i}`,
          arguments: coerce(tc.function?.arguments ?? {}),
        })),
        finishTag,
        usage: {
          promptTokens: r.prompt_eval_count ?? -1,
          evalTokens: r.eval_count ?? -1,
          totalDurationMs: nsToMs(r.total_duration),
          loadDurationMs: nsToMs(r.load_duration),
        },
      };
    } catch (err) {
      if (aborted || abortSignal.aborted) {
        throw new RunAbortedError("Inference aborted by kill switch", err);
      }
      // Preserve already-typed quality errors verbatim (e.g. malformed tool
      // arguments from coerce()): re-wrapping destroyed their violations
      // list and mislabelled root causes as upstream_error.
      if (isInferenceQualityError(err)) {
        throw err;
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