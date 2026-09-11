import type { EventSink, JSONSchema7, ToolDefinition } from "../core/types.js";
import { ToolkitCatalogue, toJsonSchema } from "../hands/catalogue.js";
import type { ResourceSentinel } from "../sentinel/index.js";
import { CapabilityIndex } from "./capability-index.js";
import { toolToCapability } from "./types.js";
import type { CapabilityDescriptor, CapabilitySource } from "./types.js";
import type { MountedCapabilities } from "./selector.js";
import { CAPABILITY_METRICS, CAPABILITY_LABEL_KEYS } from "../observability/metrics.js";

/**
 * Brain-mount manifest for one capability (model-native tool calling).
 * @public
 */
export interface CapabilityManifest {
  name: string;
  description: string;
  parametersJsonSchema: JSONSchema7;
}

/**
 * Result of registering one tool into the router.
 * @public
 */
export interface RegisteredCapability {
  descriptor: CapabilityDescriptor;
  manifest: CapabilityManifest;
}

/**
 * Options for the capability router.
 * @public
 */
export interface CapabilityRouterOptions {
  sink: EventSink;
  sentinel?: ResourceSentinel;
}

/**
 * CapabilityRouter - the single registration site for all tool capabilities.
 *
 * Native tools and adapted MCP tools are placed into one ToolkitCatalogue
 * (so Sentinel gating, deadline guards, output fencing and truncation apply
 * uniformly) and their descriptors are indexed in one CapabilityIndex (so
 * selectors can narrow what the model *sees* without changing what is
 * *governed*).
 *
 * Layering invariant: the router depends on hands + core only. It knows
 * nothing about MCP transports; the MCP adapter produces plain
 * ToolDefinitions and hands them to `registerTools`.
 * @public
 */
export class CapabilityRouter {
  private readonly catalogue: ToolkitCatalogue;
  private readonly index = new CapabilityIndex();
  private readonly manifests = new Map<string, CapabilityManifest>();
  private readonly sink: EventSink;

  constructor(opts: CapabilityRouterOptions) {
    this.sink = opts.sink;
    this.catalogue = new ToolkitCatalogue(opts.sink, opts.sentinel);
  }

  /**
   * The execution catalogue (native + adapted tools, governed by the sentinel).
   * @public
   */
  getCatalogue(): ToolkitCatalogue {
    return this.catalogue;
  }

  /**
   * The capability index backing progressive discovery.
   * @public
   */
  getIndex(): CapabilityIndex {
    return this.index;
  }

  /**
   * Register native tools defined by the host application.
   * @public
   */
  registerNativeTools(tools: readonly ToolDefinition[]): RegisteredCapability[] {
    return this.registerTools(tools, "native", undefined);
  }

  /**
   * Register tools from any source (native or adapted MCP tools).
   *
   * Fail-closed semantics: `ToolkitCatalogue.place` validation errors and
   * duplicate capability ids throw before any partial state is committed
   * (the loop aborts registration on first error; already-registered ids
   * from *this* call remain, which callers treat as atomic-enough because
   * the throw happens before indexing of the offending tool).
   * @public
   */
  registerTools(
    tools: readonly ToolDefinition[],
    source: CapabilitySource,
    serverId: string | undefined,
  ): RegisteredCapability[] {
    const registered: RegisteredCapability[] = [];
    for (const tool of tools) {
      const descriptor = toolToCapability(tool, { source, serverId });
      const manifest: CapabilityManifest = {
        name: tool.handle,
        description: tool.caption,
        parametersJsonSchema: toJsonSchema(tool.argsShape),
      };
      // Place first: catalogue.place runs fail-closed validation
      // (gpu-inference requires targetModelId) before anything is indexed.
      this.catalogue.place(tool);
      this.index.register(descriptor);
      this.manifests.set(descriptor.id, manifest);
      this.sink.emit(CAPABILITY_METRICS.REGISTRATIONS_TOTAL, {
        [CAPABILITY_LABEL_KEYS.SOURCE]: descriptor.source,
        [CAPABILITY_LABEL_KEYS.KIND]: descriptor.kind,
      });
      registered.push({ descriptor, manifest });
    }
    return registered;
  }

  /**
   * Manifests for the capabilities a selector chose to mount.
   * Unknown ids are skipped defensively (a selector returning stale ids
   * must not crash the loop); the run degrades to fewer mounted tools.
   * @public
   */
  manifestsFor(mounted: MountedCapabilities): CapabilityManifest[] {
    const manifests: CapabilityManifest[] = [];
    for (const capability of mounted.capabilities) {
      if (capability.kind !== "tool") continue;
      const manifest = this.manifests.get(capability.id);
      if (manifest !== undefined) manifests.push(manifest);
    }
    return manifests;
  }

  /**
   * All registered manifests (v0.1 "mount everything" behavior).
   * @public
   */
  allManifests(): CapabilityManifest[] {
    return [...this.manifests.values()];
  }

  /**
   * Unregister a disconnected server's descriptors from the index and the
   * manifest map. The catalogue keeps placed tools (dispatch-safe: the loop
   * surfaces connection failures as structured tool failures) - removal is
   * discovery-level only.
   * @public
   */
  forgetServer(serverId: string): void {
    for (const id of [...this.manifests.keys()]) {
      if (this.index.get(id)?.serverId === serverId) {
        this.manifests.delete(id);
      }
    }
    this.index.unregisterServer(serverId);
  }
}
