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
  RoomGoal,
  OpenWorkView,
  SendRoomMessageRequest,
  UpdateRoomRequest,
} from '@dsh-plugin-agent-community/agent-community'

/** The two lists the sidebar's tab strip switches between. */
export type ActiveTab = 'bots' | 'rooms'

/** One reasoning level a model publishes, exactly as DSH Settings describes it. */
export interface ModelReasoningEffort {
  readonly id: string
  readonly name?: string | undefined
  readonly description?: string | undefined
}

/** One model a provider advertises, exactly as DSH Settings describes it. */
export interface ModelOption {
  readonly id: string
  readonly name?: string | undefined
  readonly description?: string | undefined
  /** The levels this model accepts; absent when the host publishes none. */
  readonly reasoning?: {
    readonly efforts: readonly ModelReasoningEffort[]
    readonly defaultEffort?: string | undefined
  } | undefined
}

/** One provider and the models it advertises, as the host reports them. */
export interface ModelGroup {
  readonly id: string
  /** Display name from DSH Settings. `label` is the legacy spelling of the same field. */
  readonly name?: string | undefined
  readonly label?: string | undefined
  readonly models: readonly ModelOption[]
}

/** A provider Settings has configured but whose catalog could not be built. */
export interface ModelCatalogFailure {
  readonly id: string
  readonly name?: string | undefined
  readonly message?: string | undefined
}

/**
 * The deployment's whole model catalog.
 *
 * This is the ONLY source of provider ids, model ids and display names in this UI. It is
 * produced by DSH Settings, so custom providers, renamed models and per-model reasoning
 * levels all appear here without a code change — nothing about a vendor is baked in.
 */
export interface ModelCatalog {
  readonly groups: readonly ModelGroup[]
  /** Configured providers that are currently unavailable, with the host's reason. */
  readonly failures: readonly ModelCatalogFailure[]
  /** The model DSH Settings names as the deployment default. */
  readonly default?: {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string | undefined
  } | undefined
}

/** Everything the page asks of the host. Injected by the plugin, never fetched here. */
export interface CommunityRemote {
  snapshot(): Promise<BotCommunitySnapshot>
  /** 2026-11-09: user-triggered condense of the group experience card. */
  compactGroupExperience(input: { readonly roomId: string }): Promise<{ readonly ok: boolean; readonly reason: string }>
  /** S2-3: cross-room attention index (metadata only; no message text). */
  listOpenWork(): Promise<OpenWorkView>
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
  /** The same catalog plus the deployment default and the unavailable providers. */
  modelCatalog(): Promise<ModelCatalog>
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
    /** Inclusive change cursor: also returns rows patched since the last poll. */
    changedAfterChangeSeq?: number
    limit?: number
    /** Ignore cursors and return the room's current rows. */
    force?: boolean
  }): Promise<Array<{
    id: string; type: string; roomId: string; at: string; sequence: number;
    /** Room-wide change counter, bumped by every push AND every patch. */
    changeSeq?: number;
    text?: string; senderName?: string;
    botId?: string; botName?: string; runId?: string; streaming?: boolean;
    usage?: { outputTokens?: number; totalTokens?: number };
    callId?: string; name?: string; args?: string;
    ok?: boolean; output?: string;
    toolName?: string; outcome?: string;
    message?: string; code?: string;
    /** Deliverable files (deliverable row only). */
    files?: Array<{ path: string; name: string; description?: string; size?: number }>;
    /** OP-14 threading/task linkage (user and bot-text rows; absent when none). */
    replyTo?: string; threadId?: string; taskId?: string;
    /** The persisted message id, when the host knows it (reply targets prefer it). */
    messageId?: string;
  }>>
  // P0-3: approval
  /**
   * Answer (or skip) the question a bot is blocked on.
   *
   * The host answers `{ ok: false, reason }` when the question is no longer pending
   * in its bridge — expired, already answered, or the host reloaded — instead of
   * throwing. Callers MUST read `ok`: a refusal used to be swallowed, which left the
   * question card on screen and made both the answer and 跳过 look like dead controls
   * (「提问卡里打字回答或点跳过都没有反应」).
   */
  answerBotQuestion(input: { roomId: string; questionId: string; answer?: string; skip?: boolean }): Promise<{ ok: boolean; reason?: string }>
  /**
   * Answer one tool-call approval card.
   *
   * Returns a RECEIPT, not void: the host answers `{ ok: false, reason }` when its
   * ApprovalBridge no longer holds the `callId` (already answered, timed out, plugin
   * reloaded) and `{ ok: true }` when the decision was delivered. A refusal is DATA, not a
   * transport error, so the card can say so instead of silently doing nothing. An older
   * host returns void — treat `undefined` as accepted.
   */
  approveBotToolCall(callId: string, outcome: 'allowed-once' | 'rejected'): Promise<{ ok: boolean; reason?: string | undefined }>
  /**
   * P4: one room's record as a downloadable text blob.
   *
   * `json`/`jsonl` are the FULL rows (thinking/tools included); `markdown`/`transcript` are the
   * read-only share version that drops internals by default. The panel only downloads what the
   * host returns, so this signature never exposes a filesystem path.
   */
  exportLedger(roomId: string, format: 'json' | 'jsonl' | 'markdown' | 'transcript'): Promise<{
    ok: boolean
    content?: string | undefined
    filename?: string | undefined
    reason?: string | undefined
  }>
  // P0-1: session visibility
  getSessionVisibility(): Promise<Array<{ sessionId: string; lastError: string | null; hiddenAt: string | null }>>
  reconcileSessionVisibility(): Promise<void>
  /** Clear a room's transcript, cancel stale runs, and clear its ledger. */
  clearMessages(roomId: string): Promise<void>
  /** Erase this room's bot memory without clearing the transcript (opt-in in the clear dialog). */
  clearRoomMemory(roomId: string): Promise<{ cleared: number }>
  /** Remove members from a room; the host reassigns leadership/dissolves when needed. */
  removeBots(input: { roomId: string; botIds: readonly string[]; reason?: string }): Promise<{
    ok: boolean
    removed: readonly string[]
    refused: ReadonlyArray<{ botId: string; reason: string }>
    error?: string
    memberIds?: readonly string[]
  }>
  /** Delete one learned experience card from a room (settings management). */
  deleteRoomPattern(input: { roomId: string; patternId: string }): Promise<{ ok: boolean; reason?: string }>
  /** Confirm a pending experience card so it may enter future prompts. */
  confirmRoomPattern(input: { roomId: string; patternId: string }): Promise<{ ok: boolean; reason?: string }>
  /** Save the room's single editable experience card (empty clears it). */
  updateRoomExperience(input: { roomId: string; text: string }): Promise<{ ok: boolean; reason?: string }>
  // ── P5-2 room knowledge: user-written Markdown injected as [本房间知识] ──────────
  //
  // NOT bot memory: this is text the USER maintains for the room (team conventions, a glossary,
  // reference notes) and the host prepends it to the next turn's bot prompt. These two RPCs are
  // the only readers/writers of the knowledge document.
  /** Read this room's knowledge Markdown. `content` is absent/empty when the room has none. */
  getRoomKnowledge(roomId: string): Promise<{
    ok: boolean
    content?: string | undefined
    chars?: number | undefined
    reason?: string | undefined
  }>
  /** Save the room's knowledge Markdown; whitespace-only content clears it (the host removes the file). */
  setRoomKnowledge(roomId: string, content: string): Promise<{
    ok: boolean
    chars?: number | undefined
    reason?: string | undefined
  }>
  /**
   * S3: grant THIS room's goal a bounded number of automatic continuation rounds.
   *
   * The host owns the decision (it refuses when the room or its goal is gone, and it clamps
   * `maxRounds`) and answers with the updated goal when it accepts. The goal itself is read
   * from `snapshot.rooms[].goal`; this is the ONLY way to make a proposed goal runnable, so a
   * grant is always an explicit user act.
   */
  authorizeRoomGoal(input: { roomId: string; maxRounds?: number }): Promise<{
    ok: boolean
    goal?: RoomGoal
    reason?: string
  }>
  /**
   * S3: stop a goal from queuing further automatic rounds.
   *
   * Pausing is not finishing: the goal text and its progress stay, and `resumeRoomGoal`
   * re-arms it (bounds are enforced by the host). A proposed goal is paused by declining
   * the proposal, which is what the strip's 「先不启用」 does.
   */
  pauseRoomGoal(input: { roomId: string }): Promise<{ ok: boolean; reason?: string }>
  /** S3: re-arm a paused goal after the user asked it to continue. */
  resumeRoomGoal(input: { roomId: string }): Promise<{ ok: boolean; reason?: string }>
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
  /**
   * Read one declared deliverable for the in-panel preview.
   *
   * Addressed by (room, run, index) rather than by path: the host only reads files a bot
   * already declared, and the Bot session id never reaches the browser.
   */
  readDeliverablePreview(input: {
    roomId: string
    runId: string
    index: number
    offset?: number
  }): Promise<DeliverablePreview>
  /**
   * Open one file in the right Sidebar's document preview, exactly as DSH's own file
   * cards do. Returns false when there is no on-screen Session or no right Sidebar,
   * and the caller keeps its in-panel preview.
   */
  openFilePreview(path: string): Promise<boolean>
  /**
   * Host office→PDF conversion for the in-panel preview. 0.3.1 keeps `.docx` in the
   * browser (docx-preview) and `.xlsx` in the browser (SheetJS); this path remains for
   * PowerPoint and the legacy binary formats (`.doc`, `.xls`).
   */
  renderDeliverableDocument(input: {
    roomId: string
    runId: string
    index: number
  }): Promise<{ ok: true; name: string; dataUrl: string } | { ok: false; error: string }>
  /**
   * Host desktop actions for one delivered file: its associated applications, open it,
   * or reveal it. Addressed through the delivery record, never a client-supplied path.
   */
  deliverableFileAction(input: {
    roomId: string
    runId: string
    index: number
    action: 'applications' | 'open' | 'reveal'
    application?: string
  }): Promise<
    | { ok: true; applications?: Array<{ id: string; name: string; default: boolean; icon: string | null }> }
    | { ok: false; error: string }
  >
  /** Whether this host can open/reveal files in an OS application (desktop gate). */
  canOpenWorkspacePath(): Promise<boolean>
  /** Applications associated with one file on this machine, in OS preference order. */
  workspacePathApplications(path: string): Promise<Array<{
    id: string; name: string; default: boolean; icon: string | null
  }>>
  /** Open a file with its association (or a named app), or reveal it in the file manager. */
  openWorkspacePath(request: {
    path: string
    application?: string
    action?: 'reveal'
  }): Promise<{ opened: boolean }>
  // ── Local agents (A6): discovery + custom ACP agents for the settings panel ──────
  localAgentSnapshot(): Promise<LocalAgentSnapshotView>
  localAgentRefresh(): Promise<LocalAgentSnapshotView>
  localAgentAddCustomAgent(input: AddLocalAgentRequest): Promise<LocalAgentSnapshotView>
  localAgentUpdateCustomAgent(input: UpdateLocalAgentRequest): Promise<LocalAgentSnapshotView>
  localAgentRemoveCustomAgent(input: { readonly id: string }): Promise<LocalAgentSnapshotView>

}

/** One local agent route as the discovery service reports it. */
export interface LocalAgentRouteView {
  readonly route: string
  readonly name: string
  readonly kind: 'acp' | 'claude' | 'codex'
  readonly custom: boolean
  readonly available: boolean
  readonly path?: string | undefined
  readonly version?: string | undefined
  readonly signInHint?: string | undefined
}

/** A user-added ACP agent. */
export interface LocalAgentCustomAgent {
  readonly id: string
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
}

/** The local-agent settings snapshot (mirrors the host type). */
export interface LocalAgentSnapshotView {
  readonly enabled: boolean
  readonly supported: boolean
  readonly home: string
  readonly scannedAt: string
  readonly detected: readonly LocalAgentRouteView[]
  readonly custom: readonly LocalAgentCustomAgent[]
  /** Routes actually registered as model providers (the Bot form hides persona for these). */
  readonly registeredRoutes: readonly string[]
}

export interface AddLocalAgentRequest {
  readonly name: string
  readonly command: string
  readonly args?: readonly string[] | string | undefined
}

export interface UpdateLocalAgentRequest extends AddLocalAgentRequest {
  readonly id: string
}

/** One preview payload for a declared deliverable. */
export type DeliverablePreview =
  | { kind: 'text'; name: string; text: string; offset: number; truncated: boolean }
  | { kind: 'data'; name: string; mime: string; dataUrl: string }
  | { kind: 'binary'; name: string; size: number }
  | { kind: 'missing'; name: string }

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
