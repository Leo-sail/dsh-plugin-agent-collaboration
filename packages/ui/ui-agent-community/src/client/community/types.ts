/**
 * Local types for the Agent Community page.
 *
 * All of it is the plugin's own surface: the state the page shell keeps, the shape of the
 * sub-components it renders, and the RPC contract the host injects as `remote`. Nothing here
 * comes from the DSH shell, and nothing here imports a component — the modules under
 * `client/community/` can therefore share a shape without importing each other in a cycle.
 */
import type {
  BotCommunitySnapshot,
  BotIdentity,
  BotMessage,
  BotPresence,
  BotRoom,
  BotRun,
  ConfirmGroupRequest,
  ControlBotRunRequest,
  CreateBotRequest,
  CreateRoomRequest,
  DeleteBotRequest,
  DeleteRoomRequest,
  GroupProposal,
  RetryBotRunRequest,
  SendRoomMessageRequest,
  UpdateRoomRequest,
} from '@dsh-plugin-agent-community/agent-community'

/** The two lists the sidebar's tab strip switches between. */
export type ActiveTab = 'bots' | 'rooms'

/** One provider and the models it advertises, as the host reports them. */
export interface ModelGroup {
  readonly id: string
  readonly label?: string | undefined
  readonly models: readonly {
    readonly id: string
    readonly name?: string | undefined
  }[]
}

/** Everything the page asks of the host. Injected by the plugin, never fetched here. */
export interface CommunityRemote {
  snapshot(): Promise<BotCommunitySnapshot>
  /** Clear one room's unread badge (called while that room is on screen). */
  markRoomRead(input: {
    roomId: string
    /**
     * Newest message the user can have seen. Without it the host marks whatever is newest
     * when the call lands, so a reply arriving in the open room is marked read on the next
     * poll and never shows up as unread.
     */
    upToId?: string | undefined
  }): Promise<{ roomId: string; cleared: boolean }>
  /** Unread totals only — the sidebar entry's background refresh. */
  unreadTotals(): Promise<{ total: number; rooms: Record<string, number> }>
  createBot(input: CreateBotRequest): Promise<BotIdentity>
  updateBot(input: { id: string } & Partial<CreateBotRequest>): Promise<BotIdentity>
  deleteBot(input: DeleteBotRequest): Promise<void>
  listRooms(): Promise<BotRoom[]>
  createRoom(input: CreateRoomRequest): Promise<BotRoom>
  updateRoom(input: UpdateRoomRequest): Promise<BotRoom>
  deleteRoom(input: DeleteRoomRequest): Promise<void>
  sendMessage(input: SendRoomMessageRequest): Promise<BotMessage>
  listRuns(botId?: string): Promise<BotRun[]>
  getBotPresence(botId: string): Promise<BotPresence>
  listModelGroups(): Promise<ModelGroup[]>
  pickDirectory(): Promise<string | null>
  getDefaults(): Promise<{ defaultWorkspace: string }>
  controlRun(input: ControlBotRunRequest): Promise<BotRun>
  retryRun(input: RetryBotRunRequest): Promise<BotRun>
  ensureRoomSession(roomId: string): Promise<{ sessionId: string; isGroup: boolean }>
  proposeGroup(input: { roomId: string; messageId: string }): Promise<GroupProposal | undefined>
  confirmGroup(input: ConfirmGroupRequest): Promise<BotRoom>
  declineGroup(input: { proposalId: string }): Promise<void>
  // P0-2: ledger
  listLedger(roomId: string, opts?: {
    beforeSequence?: number
    afterSequence?: number
    changedAfterSequence?: number
    limit?: number
  }): Promise<Array<{
    id: string; type: string; roomId: string; at: string; sequence: number;
    text?: string; senderName?: string;
    botId?: string; botName?: string; runId?: string; streaming?: boolean;
    usage?: { outputTokens?: number; totalTokens?: number };
    callId?: string; name?: string; args?: string;
    ok?: boolean; output?: string;
    toolName?: string; outcome?: string;
    message?: string; code?: string;
  }>>
  // P0-3: approval
  answerBotQuestion(input: { roomId: string; questionId: string; answer?: string; skip?: boolean }): Promise<{ ok: boolean }>
  approveBotToolCall(callId: string, outcome: 'allowed-once' | 'rejected'): Promise<void>
  // P0-1: session visibility
  getSessionVisibility(): Promise<Array<{ sessionId: string; lastError: string | null; hiddenAt: string | null }>>
  reconcileSessionVisibility(): Promise<void>
  /** Clear a room's transcript, cancel stale runs, and clear its ledger. */
  clearMessages(roomId: string): Promise<void>
  /**
   * Record one system notice as a durable grey divider row inside that room's transcript.
   *
   * Fired by the panel for model/permission/command feedback; `stored: false` means the room was
   * gone by the time it arrived (the action itself already happened — nothing to retry).
   */
  noticeRoom(input: { roomId: string; text: string }): Promise<{ stored: boolean }>
  /**
   * Compress the room's OLDER messages into one summary, keeping the newest `keepLast`.
   *
   * The host does the work (it owns the messages, the ledger and the bot sessions), so the
   * result is the host's report, not a client-side guess: `compacted: false` with a
   * `reason` is a polite refusal (the room is too short, a turn is running) and means the
   * transcript was NOT touched.
   */
  compactRoom(input: { roomId: string; keepLast?: number }): Promise<{
    compacted: boolean
    reason?: string
    removed: number
    kept: number
    summary?: string
    sessionsRetired: number
  }>
  /** Skills available to the room's bot (host registry + workspace SKILL.md). */
  listSkills(roomId: string): Promise<Array<{
    id: string; name: string; description: string; path: string
  }>>
  /** Full text of a skill, for direct invocation from the menu. */
  loadSkill(roomId: string, name: string): Promise<{ name: string; content: string } | undefined>
  /**
   * Shallow listing of a skill directory. Supplied to the model with the skill body so
   * it reads the reference files it needs instead of exploring with bash/glob — which
   * was slow and reached outside the bot workspace.
   */
  listSkillFiles(dir: string): Promise<Array<{ path: string; isDir: boolean }>>
  /**
   * Copy a bot into a new bot and return its direct room, so the caller can
   * open the copy's conversation immediately.
   */
  copyBot(
    botId: string,
    sourceRoomId: string,
    upToMessageId: string,
  ): Promise<{ bot: { id: string; name: string }; room: { id: string } }>
}

/** The plugin's own RPC health, shown in the page's status bar while it is not ready. */
export interface CommunityDiagnostics {
  readonly status: 'pending' | 'ready' | 'failed'
  readonly detail: string
}

export interface CommunityPageProps {
  remote: CommunityRemote
  diagnostics?: () => CommunityDiagnostics
  /** Injected by DSH's slot renderer when this component occupies a main slot
   *  that declared children. Used to render the native conversation surface. */
}

/**
 * Error text for a caught value: `Error.message` when there is one, `String(value)` otherwise.
 *
 * Lives beside the types rather than in the page shell because the dialogs, the snapshot hook and
 * the shell all report failures with it — a single definition is what keeps their wording (and
 * therefore the user-visible message) identical.
 */
export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
