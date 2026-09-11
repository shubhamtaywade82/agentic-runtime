import { AgentRuntimeError } from "../core/types.js";
import type {
  CapabilityDescriptor,
  CapabilityKind,
  CapabilitySource,
} from "./types.js";

/**
 * Default discoverability priority when none is declared (0-100 scale).
 * @public
 */
export const DEFAULT_CAPABILITY_PRIORITY = 50;

/**
 * Options for capability search.
 * @public
 */
export interface CapabilitySearchOptions {
  /** Maximum number of results. Default: unlimited. */
  limit?: number;
  /** Restrict results to these capability kinds. */
  kinds?: readonly CapabilityKind[];
  /** Restrict results to these capability sources. */
  sources?: readonly CapabilitySource[];
}

/**
 * A capability plus its relevance score against a query.
 * @public
 */
export interface ScoredCapability {
  descriptor: CapabilityDescriptor;
  score: number;
  /** Query terms that matched this capability (for rationale/debug). */
  matchedTerms: string[];
}

/**
 * Tokenizer for capability search: lowercase, split on non-alphanumeric,
 * drop stop words. Deterministic and locale-independent.
 * @public
 */
export function tokenizeForSearch(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with",
  "is", "are", "be", "by", "as", "at", "it", "this", "that", "from",
  "use", "using", "used", "my", "me", "you", "your", "please", "can",
  "could", "should", "would", "will", "do", "does", "did", "how", "what",
  "when", "where", "which", "who", "i", "we", "our", "us", "all", "any",
]);

interface SearchField {
  tokens: string[];
  weight: number;
}

function searchFields(descriptor: CapabilityDescriptor): SearchField[] {
  const dis = descriptor.discoverability;
  const fields: SearchField[] = [
    { tokens: tokenizeForSearch(descriptor.name), weight: 3 },
    { tokens: tokenizeForSearch(descriptor.description), weight: 1 },
  ];
  if (dis) {
    fields.push({
      tokens: dis.keywords.flatMap((k) => tokenizeForSearch(k)),
      weight: 2,
    });
    if (dis.category !== undefined) {
      fields.push({ tokens: tokenizeForSearch(dis.category), weight: 2 });
    }
  }
  if (descriptor.permissions) {
    fields.push({
      tokens: descriptor.permissions.flatMap((p) => tokenizeForSearch(p)),
      weight: 1,
    });
  }
  return fields;
}

/**
 * Score a set of capability descriptors against a free-text query.
 *
 * Scoring model (deterministic, no network, no LLM):
 * - Each query term that matches a field token exactly scores the field weight.
 * - Prefix matches (3+ chars) score half the field weight.
 * - Declared discoverability priority contributes priority/100 (default 0.5).
 * - Ties break by descriptor id ascending - results are fully deterministic.
 *
 * Capabilities with zero matched query terms are excluded (empty queries
 * fall back to priority ordering).
 * @public
 */
export function scoreCapabilities(
  query: string,
  capabilities: readonly CapabilityDescriptor[],
): ScoredCapability[] {
  const terms = [...new Set(tokenizeForSearch(query))];
  const scored: ScoredCapability[] = [];

  for (const descriptor of capabilities) {
    const fields = searchFields(descriptor);
    const priority = descriptor.discoverability?.priority ?? DEFAULT_CAPABILITY_PRIORITY;
    const priorityScore = priority / 100;
    const matchedTerms: string[] = [];
    let relevance = 0;

    if (terms.length === 0) {
      scored.push({ descriptor, score: priorityScore, matchedTerms });
      continue;
    }

    for (const term of terms) {
      let best = 0;
      for (const field of fields) {
        if (field.tokens.includes(term)) {
          best = Math.max(best, field.weight);
        } else if (term.length >= 3 && field.tokens.some((t) => t.startsWith(term))) {
          best = Math.max(best, field.weight / 2);
        }
      }
      if (best > 0) {
        relevance += best;
        matchedTerms.push(term);
      }
    }

    if (relevance > 0) {
      scored.push({ descriptor, score: relevance + priorityScore, matchedTerms });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.descriptor.id.localeCompare(b.descriptor.id));
  return scored;
}

/**
 * CapabilityIndex - the source-agnostic registry behind progressive discovery.
 *
 * Holds CapabilityDescriptors from every source (native tools, MCP tools,
 * MCP resources/prompts) and answers ranked searches so small-context models
 * never see 500 tool schemas at once. Registration is fail-closed: duplicate
 * ids throw, because a silent overwrite would hide a mounting bug.
 * @public
 */
export class CapabilityIndex {
  private readonly byId = new Map<string, CapabilityDescriptor>();

  /**
   * Register descriptors. Throws on duplicate id (fail-closed).
   * @public
   */
  register(...descriptors: readonly CapabilityDescriptor[]): this {
    for (const descriptor of descriptors) {
      if (this.byId.has(descriptor.id)) {
        throw new AgentRuntimeError(
          `Capability id '${descriptor.id}' is already registered.`,
          "CAPABILITY_CONFLICT",
        );
      }
      this.byId.set(descriptor.id, descriptor);
    }
    return this;
  }

  /**
   * Remove descriptors by id. Unknown ids are ignored (idempotent).
   * @public
   */
  unregister(ids: readonly string[]): this {
    for (const id of ids) this.byId.delete(id);
    return this;
  }

  /**
   * Remove every descriptor whose serverId matches (server disconnect).
   * @public
   */
  unregisterServer(serverId: string): this {
    for (const [id, d] of this.byId) {
      if (d.serverId === serverId) this.byId.delete(id);
    }
    return this;
  }

  /**
   * Drop all registered descriptors.
   * @public
   */
  clear(): this {
    this.byId.clear();
    return this;
  }

  /**
   * Number of registered descriptors.
   * @public
   */
  get size(): number {
    return this.byId.size;
  }

  /**
   * Get a descriptor by id.
   * @public
   */
  get(id: string): CapabilityDescriptor | undefined {
    return this.byId.get(id);
  }

  /**
   * List registered descriptors, optionally filtered by kind/source.
   * Order is registration order.
   * @public
   */
  list(filter: { kinds?: readonly CapabilityKind[]; sources?: readonly CapabilitySource[] } = {}): CapabilityDescriptor[] {
    return [...this.byId.values()].filter(
      (d) =>
        (filter.kinds === undefined || filter.kinds.includes(d.kind)) &&
        (filter.sources === undefined || filter.sources.includes(d.source)),
    );
  }

  /**
   * Ranked search over registered descriptors.
   * @public
   */
  search(query: string, opts: CapabilitySearchOptions = {}): ScoredCapability[] {
    const pool = this.list({
      ...(opts.kinds !== undefined ? { kinds: opts.kinds } : {}),
      ...(opts.sources !== undefined ? { sources: opts.sources } : {}),
    });
    let results = scoreCapabilities(query, pool);
    if (opts.limit !== undefined) results = results.slice(0, opts.limit);
    return results;
  }
}
