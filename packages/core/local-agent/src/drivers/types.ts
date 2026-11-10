/**
 * The small, stable driver interface every engine family implements.
 *
 * The point of this boundary is to keep protocol churn out of the adapter: ACP's SDK major
 * versions, Codex's JSONL shape and Claude's stream-json are all this interface's problem,
 * while `adapter.ts` only sees normalized events.
 *
 * @module
 */
import type { TokenUsage } from '@deepseek-ai/dsh-llm'

/** One model a driver reports. `default` means "whatever the CLI is configured to use". */
export interface DriverModel {
  readonly id: string
  readonly name: string
}

/** What one turn needs from the driver. */
export interface DriverStreamInput {
  /** DSH Session id — the driver keys its own conversation mapping by it. */
  readonly sessionId: string
  /** The text to hand the agent. Contains conversation content only, never a system prompt. */
  readonly prompt: string
  /** Session working directory. */
  readonly cwd: string
  /** Explicit model id, or undefined for the CLI's configured default. */
  readonly model?: string | undefined
  /** CLI-side session/thread to resume, when a previous turn established one. */
  readonly resumeId?: string | undefined
  readonly signal?: AbortSignal | undefined
}

/** Normalized driver events. The adapter is the only consumer. */
export type AgentEvent =
  | { readonly type: 'thread'; readonly threadId: string }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thought'; readonly text: string }
  | { readonly type: 'activity'; readonly text: string }
  | { readonly type: 'usage'; readonly usage: TokenUsage }
  | { readonly type: 'done'; readonly reason?: string }
  | { readonly type: 'error'; readonly error: Error }
  /**
   * A permission prompt (ACP/Claude). A2 has no approval bridge yet; the adapter renders it
   * as an activity line so the turn never hangs waiting for a UI that is not mounted.
   */
  | { readonly type: 'permission'; readonly action: string; readonly detail?: string | undefined }

/** One engine family, in the shape the adapter consumes. */
export interface LocalAgentDriver {
  readonly route: string
  stream(input: DriverStreamInput): AsyncIterable<AgentEvent>
  listModels(): Promise<readonly DriverModel[]>
  dispose(): Promise<void>
}
