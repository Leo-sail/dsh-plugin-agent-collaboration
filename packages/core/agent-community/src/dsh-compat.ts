/**
 * Optional access to the DSH APIs this plugin uses, so no DSH version is required.
 *
 * THE RULE: a package that only makes a FEATURE nicer must never be the reason the plugin fails
 * to load, and its absence must never take the session down with it. That happened for real — a
 * hand-installed copy of `@deepseek-ai/dsh-*` shadowed the host's own packages, the plugin's
 * import of them resolved against the wrong version, and the user's native sessions stopped
 * working. The plugin cannot control what a host ships; it can refuse to hard-depend on it.
 *
 * Three tiers, in order of preference:
 *
 *   1. the host's own API, loaded lazily and cached (best: exactly the host's semantics);
 *   2. a local implementation of the small subset the plugin actually needs (works everywhere);
 *   3. a logged degradation, when not even that is possible.
 *
 * The DSH *plugin contract* packages (`@deepseek-ai/cordis` for the service base,
 * `@deepseek-ai/dsh-typert-protocol` for the remote surface, `@deepseek-ai/schemastery` for the
 * config schema) stay normal imports: without them a DSH plugin is not a DSH plugin. Nothing here
 * pins a VERSION of anything — see the `*` peer ranges in package.json.
 *
 * @module
 */

// TYPE-ONLY import: erased at build time, so it costs no runtime dependency and pins no version.
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'

/** Content blocks a user message may carry; the host's own type is structurally the same. */
export interface CompatContentBlock {
  readonly type: string
  readonly text?: string | undefined
}

/** The message shape `agent.inject()` / `agent.followup()` accept. */
export type CompatUserMessage = UserMessage

/** What the caller supplies; the host fills in ids and timestamps itself. */
export interface CreateUserMessageInput {
  readonly content: readonly CompatContentBlock[]
  readonly source: { readonly kind: string }
}

/**
 * Build the message locally.
 *
 * This is the shape the plugin has been injecting since before this module existed, so a host
 * without `dsh-llm` gets the same message it would have got — minus the helper's own validation.
 */
export function localUserMessage(input: CreateUserMessageInput): CompatUserMessage {
  const message = {
    // The host's factory stamps an id; ours has to as well, because every consumer downstream
    // (the transcript, the ledger, the turn reader) keys on it.
    id: randomUUID(),
    role: 'user',
    content: input.content.map(block => ({ ...block })),
    source: { kind: input.source.kind },
  }
  // Cast: the host's type carries fields a given DSH version may add (timestamps, routing
  // metadata). The plugin fills what it can and leaves the rest to the host, which is the whole
  // point of not pinning a version.
  return message as unknown as CompatUserMessage
}

type Factory = (input: CreateUserMessageInput) => CompatUserMessage

let factory: Factory | undefined
let reportedFallback = false

/**
 * A user message for the CURRENT host — its own factory when available, ours otherwise.
 *
 * Lazy on purpose: the import is attempted on first use, so a host that does not ship `dsh-llm`
 * (or ships one whose entry point moved) still starts the plugin and still gets a usable message.
 *
 * @param input - text and source for the message.
 * @param onFallback - called once, with the reason, when the host's factory is unavailable.
 */
export async function createUserMessage(
  input: CreateUserMessageInput,
  onFallback?: (reason: string) => void,
): Promise<CompatUserMessage> {
  if (factory === undefined) {
    try {
      const mod = await import('@deepseek-ai/dsh-llm') as { createUserMessage?: Factory }
      if (typeof mod.createUserMessage === 'function') factory = mod.createUserMessage
    } catch {
      // Not installed, or not resolvable from here: fall through to the local shape.
    }
    if (factory === undefined) {
      factory = localUserMessage
      if (!reportedFallback && onFallback !== undefined) {
        reportedFallback = true
        onFallback('@deepseek-ai/dsh-llm is not available; using the plugin\'s own message shape')
      }
    }
  }
  return factory(input)
}

/** Whether the host's own message factory was found (for the diagnostics line and the fixture). */
export function usingHostMessageFactory(): boolean {
  return factory !== undefined && factory !== localUserMessage
}

/** Test seam: forget what was resolved, so a fixture can exercise both paths. */
export function resetCompatCache(): void {
  factory = undefined
  reportedFallback = false
}
