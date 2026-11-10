/**
 * The small, stable driver interface every engine family implements.
 *
 * The point of this boundary is to keep protocol churn out of the adapter: ACP's SDK major
 * versions, Codex's app-server notifications and Claude's stream-json are all this interface's
 * problem, while `adapter.ts` only sees normalized events.
 *
 * @module
 */
import type { TokenUsage } from '@deepseek-ai/dsh-llm'

/** One model a driver reports. `default` means "whatever the CLI is configured to use". */
export interface DriverModel {
  readonly id: string
  readonly name: string
}

/** One bridged DSH tool, in the shape an MCP `tools/list` returns. */
export interface DriverMcpTool {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
}

/** A resolved DSH tool call handed back to the waiting agent. */
export interface DriverToolResult {
  readonly callId: string
  readonly text: string
  readonly isError: boolean
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
  /** Bot permission, mapped by each driver onto its CLI's sandbox/permission mode. */
  readonly permission?: 'read-only' | 'workspace-write' | 'full-access' | undefined
  /** CLI-side session/thread to resume, when a previous turn established one. */
  readonly resumeId?: string | undefined
  /** Tools to expose over loopback MCP for this turn (empty/absent disables the bridge). */
  readonly mcp?: { readonly tools: readonly DriverMcpTool[] } | undefined
  /** Results for bridged calls the previous stream parked; this continues the same turn. */
  readonly toolResults?: readonly DriverToolResult[] | undefined
  readonly signal?: AbortSignal | undefined
}

/** Normalized driver events. The adapter is the only consumer. */
export type AgentEvent =
  | { readonly type: 'thread'; readonly threadId: string }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thought'; readonly text: string }
  | { readonly type: 'activity'; readonly text: string }
  | { readonly type: 'usage'; readonly usage: TokenUsage }
  /** The agent invoked a bridged DSH tool; the stream stops here until the host resolves it. */
  | {
    readonly type: 'tool-call'
    readonly callId: string
    readonly name: string
    readonly arguments: Record<string, unknown>
  }
  | { readonly type: 'done'; readonly reason?: string }
  | { readonly type: 'error'; readonly error: Error }
  /**
   * A permission prompt (ACP/Claude). A3 has no approval bridge yet; the adapter renders it
   * as an activity line so the turn never hangs waiting for a UI that is not mounted.
   */
  | { readonly type: 'permission'; readonly action: string; readonly detail?: string | undefined }

/** One engine family, in the shape the adapter consumes. */
export interface LocalAgentDriver {
  readonly route: string
  stream(input: DriverStreamInput): AsyncIterable<AgentEvent>
  listModels(): Promise<readonly DriverModel[]>
  /** Drop this conversation's CLI-side state so the next turn starts a fresh thread. */
  resetSession?(sessionId: string): void | Promise<void>
  dispose(): Promise<void>
}
