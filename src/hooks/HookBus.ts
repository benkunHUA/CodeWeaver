import type {
  HookContexts,
  HookErrorPolicy,
  HookEvent,
  HookHandler,
  HookResult,
} from "./types.js";

// A handler erased of its event-specific context so the bus can store every event uniformly.
type AnyHookHandler = (context: unknown) => HookResult | Promise<HookResult>;

interface Registration {
  readonly name: string;
  readonly handler: AnyHookHandler;
  readonly onError: HookErrorPolicy;
}

interface EventRegistry {
  UserPromptSubmit: Registration[];
  PreToolUse: Registration[];
  PostToolUse: Registration[];
  Stop: Registration[];
}

// PreToolUse fails closed by default; every other event keeps the loop running.
const DEFAULT_ERROR_POLICY: Readonly<Record<HookEvent, HookErrorPolicy>> = {
  UserPromptSubmit: "ignore",
  PreToolUse: "block",
  PostToolUse: "ignore",
  Stop: "ignore",
};

export interface HookBusOptions {
  readonly logger?: ((message: string) => void) | undefined;
}

export interface HookRegisterOptions {
  readonly onError?: HookErrorPolicy | undefined;
  readonly name?: string | undefined;
}

export class HookBus {
  readonly #handlers: EventRegistry = {
    UserPromptSubmit: [],
    PreToolUse: [],
    PostToolUse: [],
    Stop: [],
  };
  readonly #logger: (message: string) => void;

  constructor({ logger }: HookBusOptions = {}) {
    this.#logger = logger ?? (() => {});
  }

  register<E extends HookEvent>(
    event: E,
    handler: HookHandler<E>,
    options: HookRegisterOptions = {},
  ): void {
    const registrations = this.#handlers[event];
    registrations.push({
      name: options.name ?? `handler-${registrations.length + 1}`,
      handler: handler as AnyHookHandler,
      onError: options.onError ?? DEFAULT_ERROR_POLICY[event],
    });
  }

  async trigger<E extends HookEvent>(event: E, context: HookContexts[E]): Promise<string | undefined> {
    for (const registration of this.#handlers[event]) {
      try {
        // Handlers get an isolated snapshot so they cannot mutate the caller's object.
        // Cloning stays inside the try: an uncloneable context (functions, symbols)
        // must follow this handler's onError policy instead of escaping the bus and
        // tearing down the agent loop.
        const snapshot = structuredClone(context);
        const result = await registration.handler(snapshot);
        if (typeof result === "string") return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#log(`hook error: ${event} failed: ${message}`);
        if (registration.onError === "block") {
          return `Permission denied: hook error in ${event}`;
        }
      }
    }
    return undefined;
  }

  listHandlers(event: HookEvent): readonly string[] {
    return this.#handlers[event].map((registration) => registration.name);
  }

  #log(message: string): void {
    try {
      this.#logger(message);
    } catch {
      /* Diagnostics must not interrupt dispatch. */
    }
  }
}
