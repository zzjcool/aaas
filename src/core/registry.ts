import type {
  AgentAdapter,
  AgentInfo,
  AgentType,
  TriggerInfo,
  TriggerPlugin,
  TriggerType,
} from "../shared/types.ts";

/**
 * Plugin registries. Triggers decide *when* a job fires, agents decide *how*
 * it runs. Both are plain maps keyed by `type`, so a later loader can register
 * additional built-ins (github webhook, HTTP, claude-code, ...) without the
 * engine changing.
 */
export type AnyTriggerPlugin = TriggerPlugin<unknown>;

export class TriggerRegistry {
  readonly #plugins = new Map<string, AnyTriggerPlugin>();

  register(plugin: AnyTriggerPlugin): void {
    if (this.#plugins.has(plugin.type)) {
      throw new Error(`trigger plugin already registered: ${plugin.type}`);
    }
    this.#plugins.set(plugin.type, plugin);
  }

  get(type: TriggerType): AnyTriggerPlugin | undefined {
    return this.#plugins.get(type);
  }

  require(type: TriggerType): AnyTriggerPlugin {
    const plugin = this.#plugins.get(type);
    if (!plugin) {
      throw new Error(`unknown trigger type: ${type} (known: ${[...this.#plugins.keys()].join(", ")})`);
    }
    return plugin;
  }

  list(): TriggerInfo[] {
    return [...this.#plugins.values()].map((p) => ({ ...p.descriptor, type: p.type, builtins: true }));
  }

  get size(): number {
    return this.#plugins.size;
  }
}

export class AgentRegistry {
  readonly #adapters = new Map<string, AgentAdapter>();

  register(adapter: AgentAdapter): void {
    if (this.#adapters.has(adapter.type)) {
      throw new Error(`agent adapter already registered: ${adapter.type}`);
    }
    this.#adapters.set(adapter.type, adapter);
  }

  get(type: AgentType): AgentAdapter | undefined {
    return this.#adapters.get(type);
  }

  require(type: AgentType): AgentAdapter {
    const adapter = this.#adapters.get(type);
    if (!adapter) {
      throw new Error(`unknown agent type: ${type} (known: ${[...this.#adapters.keys()].join(", ")})`);
    }
    return adapter;
  }

  list(): AgentInfo[] {
    return [...this.#adapters.values()].map((a) => ({ ...a.descriptor, type: a.type, builtins: true }));
  }

  get size(): number {
    return this.#adapters.size;
  }
}
