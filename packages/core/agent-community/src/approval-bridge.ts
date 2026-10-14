/**
 * ApprovalBridge — intercepts approval/request events for group-chat member
 * sessions and routes them through the ledger as 'approval' entries rather
 * than surfacing native approval cards in the UI.
 *
 * Design (v5 §5, V-8):
 *  - Registers a prepend:true, global:true approval/request waterfall listener.
 *  - Only handles requests whose agent belongs to a known member session.
 *  - All other requests get next() and reach the native approval UI unchanged.
 *  - Hard limit: strategies.setPolicy(agent, {default:'ask'}) must already be
 *    called for the member session; 'never' policy short-circuits before listeners.
 *  - R-19: in 'danger-full-access' permission mode the policy may be forced to
 *    'never'; the bridge then never fires. The UI should surface an explanation.
 *
 * Concurrency: each pending approval gets a stable resolveMap entry so
 * resolve(outcome) is safe to call from any concurrent path.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LedgerProjector } from './ledger.ts'
import type { BotId, BotRoomId } from './types.ts'

type ApprovalOutcome = 'allowed-once' | 'rejected'

interface PendingApproval {
  readonly entryId: string
  readonly roomId: BotRoomId
  resolve(outcome: ApprovalOutcome): void
}

/** Accessor used by the bridge to look up which room a session belongs to. */
export interface ApprovalBridgeAccessor {
  /** Return the roomId for this sessionId, or undefined if not a member session. */
  memberRoomId(sessionId: string): { roomId: BotRoomId; botId: BotId } | undefined
}

export class ApprovalBridge {
  private readonly ctx: Context
  private readonly ledger: LedgerProjector
  private readonly accessor: ApprovalBridgeAccessor
  private readonly pending = new Map<string, PendingApproval>()

  constructor(ctx: Context, ledger: LedgerProjector, accessor: ApprovalBridgeAccessor) {
    this.ctx = ctx
    this.ledger = ledger
    this.accessor = accessor
  }

  /**
   * Register the approval/request waterfall listener. Call once on service start.
   * Returns a disposer that unregisters the listener.
   */
  install(): () => void {
    // dsh-user-approval exposes waterfall on 'approval/request'.
    // prepend:true ensures we run before dsh-api-remotes forwards to the browser.
    // global:true is required for cross-scope session agents.
    const approvalSvc = (this.ctx as unknown as {
      approval?: {
        on(
          event: string,
          handler: (req: ApprovalRequest, next: () => Promise<ApprovalOutcome | 'unavailable'>) => Promise<ApprovalOutcome | 'unavailable'>,
          opts: { prepend: boolean; global: boolean },
        ): () => void
      }
    }).approval

    if (approvalSvc?.on === undefined) {
      // approval service not available — bridge is a no-op, native UI handles all
      return () => { /* noop */ }
    }

    const dispose = approvalSvc.on(
      'approval/request',
      async (req, next) => {
        const sessionId = (req.agent as unknown as { session?: { id?: string } })?.session?.id
        if (sessionId === undefined) return next()

        const membership = this.accessor.memberRoomId(sessionId)
        if (membership === undefined) return next()  // not a member session — pass through

        return this.handle(req, membership.roomId, membership.botId)
      },
      { prepend: true, global: true },
    )

    return dispose
  }

  /**
   * Claim an approval event: push an 'approval' ledger entry and wait for the
   * user to call resolveApproval(). Returns the outcome the waterfall expects.
   */
  private async handle(
    req: ApprovalRequest,
    roomId: BotRoomId,
    botId: BotId,
  ): Promise<ApprovalOutcome | 'unavailable'> {
    const callId = (req as unknown as { callId?: string }).callId
      ?? (req as unknown as { id?: string }).id
      ?? `approval-${Date.now()}`
    const toolName = (req as unknown as { tool?: string; toolName?: string }).tool
      ?? (req as unknown as { tool?: string; toolName?: string }).toolName
      ?? 'unknown'
    const args = safeSerialize((req as unknown as { args?: unknown; input?: unknown }).args
      ?? (req as unknown as { args?: unknown; input?: unknown }).input)

    const botName = this.ledger.botName(botId)

    const entry = this.ledger.push({
      type: 'approval',
      roomId,
      botId,
      botName,
      callId,
      toolName,
      args,
      at: new Date().toISOString(),
    })

    return new Promise<ApprovalOutcome | 'unavailable'>(resolve => {
      this.pending.set(callId, { entryId: entry.id, roomId, resolve })
    })
  }

  /**
   * Called by the RPC handler when the user clicks Allow/Reject in the UI.
   * Updates the ledger entry's outcome and resolves the pending approval.
   */
  resolveApproval(callId: string, outcome: ApprovalOutcome): void {
    const pending = this.pending.get(callId)
    if (pending === undefined) return
    this.pending.delete(callId)
    this.ledger.patch(pending.entryId, pending.roomId, { outcome } as never)
    pending.resolve(outcome)
  }

  /** Number of approvals currently waiting for a user decision. */
  pendingCount(): number {
    return this.pending.size
  }
}

// Minimal type for an approval request; the actual shape is DSH-internal.
// We only read from it, so a liberal unknown-based cast is safe.
type ApprovalRequest = Record<string, unknown>

function safeSerialize(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return String(value) }
}
