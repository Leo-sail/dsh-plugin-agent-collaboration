import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { AgentPresetRole } from './agent-preset.ts'
import type { TaskSegmentRecord } from './task-segment.ts'
import type { FailureKind } from './run-budget.ts'
import type { MemoryJournalRow } from './memory-store.ts'

export type BotId = string & { readonly __brand: 'BotId' }
export type BotRoomId = string & { readonly __brand: 'BotRoomId' }
export type BotRunId = string & { readonly __brand: 'BotRunId' }
export type BotMessageId = string & { readonly __brand: 'BotMessageId' }

export type BotRunStatus = 'queued' | 'running' | 'completed' | 'interrupted' | 'failed' | 'cancelled'
export type BotPresence = 'idle' | 'queued' | 'running' | 'waiting-human' | 'failed' | 'offline'
export type BotRoomPolicy = 'mention-only' | 'round-robin'
export type BotMessageSenderKind = 'user' | 'bot' | 'a2a' | 'routine' | 'leader'
export type BotConnectionState = 'connected' | 'reconnecting' | 'disconnected'

export type BotTeamRunOrigin = 'team-assign' | 'team-message' | 'team-report' | 'team-user'
export type BotTeamMessageKind = 'assign' | 'message' | 'report' | 'summary' | 'notice'

export type BotTeamLeader =
  | { readonly kind: 'session'; readonly sessionId: SessionId }
  | { readonly kind: 'bot'; readonly botId: BotId }

export interface BotTeam {
  readonly leader: BotTeamLeader
  readonly leaderName: string
  readonly workspace?: string | undefined
  readonly status: 'active' | 'dismissed'
}

export interface BotAvatar {
  readonly seed: string
  readonly locked: boolean
  readonly assetPath?: string | undefined
}

export interface BotProfileBinding {
  readonly profileId: string
  readonly scopeId?: string | undefined
  readonly memoryNamespace: string
  readonly skillScope?: string | undefined
  readonly agentPreset?: string | undefined
  readonly credentialNamespace?: string | undefined
}

export interface BotIdentity {
  readonly id: BotId
  readonly name: string
  readonly description: string
  readonly avatar: BotAvatar
  readonly provider?: string | undefined
  readonly model?: string | undefined
  /**
   * Adapter-owned reasoning effort for this bot's model calls (e.g. 'max').
   *
   * Absent/`''` asks the provider for its own default. Set an explicit level only when the
   * model publishes it: a model that publishes no reasoning levels rejects ANY explicit level
   * (UNSUPPORTED_REASONING_EFFORT), so a stored level the route does not offer makes every
   * turn fail.
   */
  readonly reasoningEffort?: string | undefined
  readonly workspace?: string | undefined
  readonly systemPrompt?: string | undefined
  readonly mentionOnly?: boolean | undefined
  /**
   * S2-1: the ROLE this bot runs under (absent = the deployment's default member preset).
   *
   * Stored as a role name, not a raw preset id, so the deployment decides which preset backs each
   * role (`botAgentPreset` / `coordinatorAgentPreset`). A coordinator gets a deliberately small
   * tool world: it routes, briefs and reports; it does not execute commands or write files.
   */
  readonly agentPreset?: AgentPresetRole | undefined
  /**
   * Intent subscriptions (OP-18): keywords this bot wants to be woken for in a GROUP room.
   *
   * Additive and bounded. The router checks them after explicit `@`/`@all` and before its
   * lexical guesswork, so a bot can say "wake me for 数据/图表" without changing its role text.
   * Empty/absent means "no subscriptions" — the old routing applies unchanged.
   */
  readonly subscriptions?: readonly string[] | undefined
  /** Access preset applied to this bot's agent session. Defaults to 'workspace-write'. */
  readonly permission?: 'read-only' | 'workspace-write' | 'full-access' | undefined
  readonly presence?: BotPresence | undefined
  readonly profile: BotProfileBinding
  readonly builtIn?: boolean
  /**
   * Copy lineage. When this bot was created by copying another bot (the UI's fork
   * action), this is the original bot's id, and `forkIndex` is the running number
   * shown in its name as "（n）". Copies are labelled by their source, so forking
   * the same bot twice yields "（1）" and "（2）"; forking a copy starts its own
   * series.
   */
  readonly forkedFromBotId?: BotId | undefined
  readonly forkIndex?: number | undefined
  readonly createdAt: string
  readonly updatedAt: string
  /**
   * Which of the room's skills this bot's identity actually needs (§5.3).
   *
   * Persisted on the bot, not in a room-keyed cache, because the same bot can sit
   * in many rooms and its relevance ranking is a property of the bot. Absent means
   * "never analysed"; the prompt then falls back to the full skill set, which is
   * always correct, only less pre-filtered.
   */
  readonly skillProfile?: BotSkillProfile | undefined
}

export interface BotMailboxItem {
  readonly id: string
  readonly roomId: BotRoomId
  readonly botId: BotId
  readonly messageId: BotMessageId
  readonly sequence: number
  readonly status: 'pending' | 'claimed' | 'settled'
  readonly createdAt: string
  readonly claimedAt?: string | undefined
  readonly settledAt?: string | undefined
}

/**
 * One system notice the room keeps after a reload.
 *
 * These are the transient status lines the panel used to paint in a coloured strip at the top of the
 * page (「已把「fghj」的模型设为：…」, 「已邀请 X 加入群聊」, command failures). The user asked for them to
 * live INSIDE the transcript as grey divider rows, which means they must survive a reload — a row
 * that vanishes on refresh is a different feature.
 *
 * Stored on the ROOM, not in `state.messages`, on purpose: the unread badge is derived from the
 * messages (`unreadByRoom`) and the model prompt is built from them too, so keeping notices out of
 * that list makes "notices never count as unread and are never fed to the bot" a structural fact
 * instead of a filter somebody has to remember to apply. Deleting a room drops its notices with it.
 */
export interface BotRoomNotice {
  readonly id: string
  readonly text: string
  readonly at: string
}

/**
 * One collaboration pattern card (OP-09): what this group learned from a delivered task.
 *
 * Built DETERMINISTICALLY from the finish report (no model call): the first sentences become
 * the approach, lines that mention a pitfall/risk become `pitfalls`, and the finish evidence
 * becomes a short reference list. Cards are remembered on the room and re-rendered into later
 * turns as the `[本群经验卡]` section, so a new task in the same group starts from what
 * worked before instead of relearning it.
 */
export interface GroupPatternCard {
  readonly id: string
  /** The task this pattern was learned from (normalized for de-duplication). */
  readonly task: string
  /** What was done, extracted from the report's opening lines. */
  readonly approach: string
  /** Pitfalls/risks/attention lines from the report (at most 3). */
  readonly pitfalls?: readonly string[] | undefined
  /** Short references to the finish evidence (paths/ids, at most 5). */
  readonly evidence?: readonly string[] | undefined
  readonly createdAt: string
  /** Only finish_task produces cards today; the field keeps the origin explicit. */
  readonly source: 'finish'
  /**
   * `pending` cards come from a BYPASSED finish and are shown in room settings but NOT
   * injected into the prompt until the user confirms them. Absent means `active` for cards
   * recorded before this field existed.
   */
  readonly status?: 'active' | 'pending' | undefined
}

/**
 * The room's ONE editable experience card (group memory).
 *
 * Auto-generated from finished-task pattern cards until the user edits it; after a manual save
 * `source` becomes `user` and later finishes never overwrite the text. An empty user card means
 * "no experience block" (it suppresses the legacy pattern-card fallback).
 */
export interface RoomExperienceCard {
  readonly text: string
  readonly updatedAt: string
  readonly source: 'auto' | 'user'
}

/**
 * How much INFERRED work a room lets run (S0-3).
 *
 * `legacy` — no admission evaluation at all: every routing decision runs exactly as before.
 * `observe` — an INFERRED decision (nobody addressed a bot: greetings, collective words, a
 *             role match, a subscription hit, the leader fallback) does NOT run; one durable
 *             notice says who would have been woken and why. An EXPLICIT request (@mention,
 *             written name, `@all`, a management instruction, a direct chat) always runs.
 * `auto` — inferred decisions run exactly as today. This is the mode a room switches to after
 *          its `observe` record looks right; the classification stays available for audit.
 */
/**
 * How a thread/task subscription came to be (S1-3).
 *
 * `round` — a user instruction fanned out to these bots; `dispatch` — work was assigned in this
 * thread/task; `manual` — a user (or a future UI action) named the owners explicitly. The stored
 * label is diagnostic only; the routing rule does not depend on it.
 */
export type ThreadSubscriptionSource = 'round' | 'dispatch' | 'manual'

/**
 * S3-1: who AUTHORIZED a thread subscription (distinct from which mechanism created it).
 * `user` outranks `leader` outranks `system`; a subscription never grants new authority.
 */
export type ThreadSubscriptionAuthority = 'user' | 'leader' | 'system'

/**
 * One thread/task OWNED by a set of bots (S1-3).
 *
 * A room message arrives as text; a subscription is the only durable statement of "this
 * conversation has an owner". Follow-ups in the same thread/task go straight to those bots
 * (before lexical inference), which is what stops a running task from being re-routed to a
 * different member on every reply. At least one of `threadId` / `taskId` is non-empty; a
 * subscription with neither would match every message in the room and is never stored.
 */
export interface ThreadSubscription {
  readonly id: string
  readonly roomId: string
  readonly threadId?: string | undefined
  readonly taskId?: string | undefined
  readonly botIds: readonly BotId[]
  readonly source: ThreadSubscriptionSource
  /**
   * S3-1: who authorized this thread's ownership. `user` (a user instruction) outranks
   * `leader` (dispatch) which outranks `system`; an event never grants new authority.
   */
  readonly authorizedBy?: ThreadSubscriptionAuthority | undefined
  readonly createdAt: number
  /** Last time the subscription resolved a message; drives the TTL refresh and the room cap. */
  readonly updatedAt: number
  readonly expiresAt: number
}

export type AdmissionMode = 'legacy' | 'observe' | 'auto'

/** A room's admission setting — see {@link AdmissionMode}. */
export interface BotRoomAdmission {
  readonly mode: AdmissionMode
}

/**
 * S2-4: the speculative-execution mode for one room. Absent/`off` is the default and behaves
 * exactly like a build without this feature.
 */
export type SpeculationMode = 'off' | 'observe' | 'on'

/** A room's speculation setting (additive; see `speculation.ts`). */
export interface BotRoomSpeculation {
  readonly mode: SpeculationMode
  readonly dailyLimit?: number | undefined
}

/**
 * S2-5: the room's semantic-admission setting (v1 skeleton — the assessor call is not wired to a
 * model yet; see `admission-assess.ts`). `rules` is user-written natural language, bounded.
 */
export interface BotRoomAssessment {
  readonly enabled: boolean
  readonly rules: string
  /** When the rules last changed (ISO); lets an operator correlate a decision with a rule set. */
  readonly updatedAt?: string | undefined
}

export interface BotRoom {
  readonly directBotId?: BotId | undefined
  readonly id: BotRoomId
  readonly name: string
  readonly imagePath?: string | undefined
  readonly memberIds: readonly BotId[]
  readonly mentionOnly: boolean
  /**
   * Whether an INFERRED request may wake anyone (S0-3). Absent means `legacy` — the pre-S0-3
   * behaviour, so an old state file needs no migration.
   */
  readonly admission?: BotRoomAdmission | undefined
  /**
   * S2-4: opt-in speculative execution. Absent = off (pre-S2-4 behaviour, no migration needed).
   */
  readonly speculation?: BotRoomSpeculation | undefined
  /**
   * S2-5: opt-in semantic admission (rules + assessor). Absent = off; old state needs no migration.
   */
  readonly admissionAssess?: BotRoomAssessment | undefined
  /**
   * S1-3: thread/task ownership, additive and capped (see `subscriptions.ts`). Absent on every
   * state file written before S1-3 and on a deployment with the feature off.
   */
  readonly subscriptions?: readonly ThreadSubscription[] | undefined
  /**
   * S1-4: each bot's CURRENT task segment (the handoff boundary), keyed by bot id. Absent when the
   * feature is off or the bot has never run an assigned task; additive, so no migration.
   */
  readonly taskSegments?: Readonly<Record<string, TaskSegmentRecord>> | undefined
  readonly policy?: BotRoomPolicy | undefined
  readonly sequence: number
  readonly connection: BotConnectionState
  readonly paused?: boolean | undefined
  readonly revision?: number | undefined
  readonly createdAt: string
  readonly updatedAt: string
  readonly team?: BotTeam | undefined
  readonly memberSessions?: Readonly<Record<string, SessionId>> | undefined
  /**
   * Legacy host-session binding.
   *
   * @deprecated Never written by any code path in this repository — the room-host dispatcher that
   * owned it was removed before this field could be populated. Retained only so a state file that
   * carries it still parses; the read in `roomForSession` is kept for the same reason.
   */
  readonly roomSessionId?: SessionId | undefined
  /**
   * Session id for the direct-chat bot agent. Absent for group rooms.
   * Isolated from memberSessions so direct history never bleeds into groups.
   */
  readonly directSessionId?: SessionId | undefined
  /**
   * A group proposal awaiting the user's answer (§5.4). Lives on the DIRECT room
   * that asked, because that is where the confirmation dialog appears; the group
   * it would create does not exist until the user confirms.
   */
  readonly pendingGroupProposal?: PendingGroupProposal | undefined
  /** This room's objective, if any — see `RoomGoal`. */
  readonly goal?: RoomGoal | undefined
  /**
   * Collaboration patterns learned from finished tasks in THIS group (OP-09).
   *
   * Additive and bounded (`mergeGroupPatterns` caps the list); rendered into later prompts as
   * `[本群经验卡]` and never shared across rooms.
   */
  readonly patternCards?: readonly GroupPatternCard[] | undefined
  /** The single editable group-memory card rendered into prompts (legacy patternCards remain). */
  readonly experienceCard?: RoomExperienceCard | undefined
  /**
   * Messages folded into a checkpoint: kept in the transcript, EXCLUDED from the prompt.
   *
   * This is what makes compaction non-destructive — the original rows stay (the panel can still
   * scroll back, the unread arithmetic is untouched) while the model stops paying for them.
   */
  readonly foldedSeqs?: readonly string[] | undefined
  /** The checkpoint row the folded region was replaced by, for the window's ordering. */
  readonly foldCheckpointId?: string | undefined
  /**
   * The room's background task board (§5.4/§6). There is no task-board UI; the
   * leader's assignments and the members' reports live here so progress survives
   * the leader's own context.
   */
  readonly taskState?: RoomTaskState | undefined
  /**
   * P2-1: the group round opened by the latest user instruction.
   *
   * Kept BESIDE `taskState` rather than inside it on purpose: the task board is rewritten
   * wholesale by versioned board transactions (`task-board.ts`), and a board write must never
   * clobber the round that is currently collecting member replies. Additive: state written by
   * older builds simply lacks it, and an absent field means "no round in flight".
   */
  readonly round?: import('./round.ts').RoundState | undefined
  /**
   * How many times this room's messages have been cleared.
   *
   * Part of the session id derivation, not bookkeeping: each clear must produce a
   * session id that has never existed, or `resume` can restore the deleted
   * conversation from the runtime's memory. Derived state, so it cannot fall out of
   * sync with the sessions it names.
   */
  readonly clearCount?: number | undefined
  /**
   * How many times this room's older history has been compacted into a summary.
   *
   * A second, independent part of the session id derivation (`generationOf` sums it with
   * `clearCount`). Compacting replaces the messages a bot would be seeded from, so the
   * pre-compaction session must not be resumable — it would restore the full transcript
   * from the runtime's own memory and the compression would be cosmetic. Kept separate
   * from `clearCount` because the two have different meanings elsewhere: `clearCount > 0`
   * marks a room whose run prompts were deliberately stripped, which is NOT what a
   * compaction does to the messages it keeps.
   */
  readonly compactCount?: number | undefined
  /**
   * Hard rules the USER stated in this room, pinned across compaction (OP-03).
   *
   * Compaction replaces older messages with a summary, and a summarising model may paraphrase
   * or drop a "必须/不要" rule; once folded, the originals are no longer sent. These fragments
   * are extracted verbatim from `sender.kind === 'user'` messages at compaction time, carried
   * on the room, and re-rendered into EVERY turn's prompt by `roomConstraintsBlock` — so a rule
   * outlives the window it was stated in. Deduped and bounded (≤20) by
   * `mergePinnedConstraints`; cleared with the messages (`clearMessages`).
   *
   * Additive: an older state file lacks it and means "no pinned constraints yet".
   */
  readonly pinnedConstraints?: readonly string[] | undefined
  /**
   * This room's durable system notices, oldest first (see {@link BotRoomNotice}).
   *
   * Additive: a state file written before this field simply lacks it, and an absent list means the
   * room has never shown one. Bounded — see `MAX_ROOM_NOTICES` in the service, which keeps the most
   * recent rows so a long-lived room cannot grow this without limit.
   */
  readonly notices?: readonly BotRoomNotice[] | undefined
}

export interface BotMessageUsage {
  /** Total prompt tokens as the provider reported them. */
  readonly inputTokens?: number | undefined
  /** Input tokens that were neither a cache read nor a cache write. */
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly cacheReadTokens?: number | undefined
  readonly cacheWriteTokens?: number | undefined
  readonly reasoningTokens?: number | undefined
  readonly routes?: readonly { readonly provider: string; readonly model: string }[] | undefined
}

/**
 * One attachment as the TRANSCRIPT shows it: a label, a size, an icon choice.
 *
 * Metadata only — never the bytes. `state.json` holds message history, and a base64
 * payload per file would multiply the size of every save to render something the bubble
 * never draws. The files themselves live in the receiving bot's workspace (see
 * `attachments.ts`); this is only what the user needs to recognise what they sent.
 */
export interface BotMessageAttachment {
  readonly name: string
  readonly size: number
  readonly mime?: string | undefined
  /** `image` only picks the icon; there is no thumbnail, because the bytes are not here. */
  readonly kind: 'image' | 'file'
}

/** One file a Bot declared as a deliverable for the user. */
export interface DeliveredFile {
  /** Canonical absolute host path; the card's open/reveal target and dedupe key. */
  readonly path: string
  /** Basename, the card's main label. */
  readonly name: string
  /** Optional one-line description supplied by the model. */
  readonly description?: string | undefined
  /** Byte size at declaration time, for the card's secondary line. */
  readonly size?: number | undefined
}

export interface BotMessage {
  readonly id: BotMessageId
  readonly roomId: BotRoomId
  readonly sender: { readonly kind: BotMessageSenderKind; readonly botId?: BotId; readonly name: string }
  /**
   * What the user typed, or the bot's reply. This is what the panel renders.
   */
  readonly text: string
  /**
   * Model-facing payload when it differs from the visible {@link text}. A `/skill`
   * expansion lands here; the bubble keeps rendering `text` alone.
   */
  readonly modelText?: string | undefined
  /**
   * Files the user attached, as the transcript draws them.
   *
   * Additive and metadata-only, so history stays portable. It exists because `text` is
   * "exactly what the user typed" by design — an attachment-only message therefore has
   * an empty `text`, and without this field its bubble rendered as an empty balloon with
   * no trace of what was sent. The `[附件]` block stays model-only (see `modelText`).
   */
  readonly attachments?: readonly BotMessageAttachment[] | undefined
  readonly mentions: readonly BotId[]
  readonly createdAt: string
  readonly runId?: BotRunId | undefined
  readonly runIds?: readonly BotRunId[] | undefined
  readonly sessionId?: SessionId | undefined
  readonly sessionSeq?: SessionSeq | undefined
  readonly reasoning?: string | undefined
  readonly toolActivity?: readonly { readonly name: string; readonly status: string; readonly detail?: string | undefined }[] | undefined
  /** Files this turn declared as deliverables; see {@link DeliveredFile}. */
  readonly deliverables?: readonly DeliveredFile[] | undefined
  readonly usage?: BotMessageUsage | undefined
  readonly durationMs?: number | undefined
  readonly sequence?: number | undefined
  readonly kind?: BotTeamMessageKind | undefined
  readonly targetNames?: readonly string[] | undefined
  /**
   * OP-14 (structured group interaction) — optional and additive.
   *
   * `replyTo` names an earlier message in the SAME room (the service drops a pointer that does not
   * resolve there), so a transcript can render a reply as part of a thread instead of an
   * unanchored bubble. `threadId` / `taskId` are opaque client labels for grouping a conversation
   * or linking it to a task; both are bounded and absent on messages that carry no threading.
   */
  readonly replyTo?: BotMessageId | undefined
  readonly threadId?: string | undefined
  readonly taskId?: string | undefined
}

/**
 * WHICH SIDE a run's failure belongs to (OP-04).
 *
 * A failure is only actionable if it names the responsible layer: a model/provider error is
 * retried differently from a harness timeout, a tool/permission problem, a memory/context
 * failure, or a room/goal orchestration stall. Recorded on the run (and inside its evidence)
 * so an evaluation can group failures without re-reading free-text errors.
 */
export type RunFaultSide = 'model' | 'harness' | 'tool' | 'memory' | 'room-goal' | 'user' | 'unknown'

/**
 * HOW a run ended, in one closed vocabulary (OP-04).
 *
 * `reply`/`finish_task` are successful deliveries; `empty` means the turn completed but said
 * nothing; `stopped` is a user stop; `timeout`/`no-progress` are the adaptive-timeout budget;
 * `failed` is an error; `unknown` covers runs that predate this record.
 */
export type RunFinishPath =
  | 'finish_task'
  | 'reply'
  | 'empty'
  | 'stopped'
  | 'timeout'
  | 'no-progress'
  | 'failed'
  | 'unknown'

/**
 * The measurable evidence of one run (OP-04): what it cost and how it ended.
 *
 * Deliberately counters and enums only — NO prompt text, reasoning or tool output — so the
 * record is small, persistent, and safe to show in the panel snapshot. Attribution (faultSide)
 * is duplicated on `BotRun.faultSide` for cheap filtering.
 */
export interface RunEvidence {
  readonly durationMs?: number | undefined
  /** Characters of the assembled prompt (not the text itself). */
  readonly promptChars?: number | undefined
  readonly toolCalls?: number | undefined
  readonly toolFailures?: number | undefined
  readonly deliverableCount?: number | undefined
  readonly contextWindowMessages?: number | undefined
  readonly approvalRequests?: number | undefined
  /** Token accounting from the provider (numbers only). */
  readonly usage?: {
    readonly uncachedInputTokens: number
    readonly outputTokens: number
    readonly totalTokens: number
  } | undefined
  readonly finishPath?: RunFinishPath | undefined
  readonly faultSide?: RunFaultSide | undefined
  /**
   * OP-15: characters per prompt section, keyed by `PROMPT_SECTION_ORDER` (currently
   * `role`/`skills`/`goal`/`constraints`/`segment`/`patterns`/`knowledge`/`recall`/`memory`/
   * `history`/`input`). Measured, not estimated, and never the text itself; the constant is the source of
   * truth, so a new section does not need this list edited twice.
   */
  readonly contextSections?: Readonly<Record<string, number>> | undefined
  /** OP-15: ROUGH prompt-token estimate (label only; see `context-cost.ts`). */
  readonly promptTokensEstimate?: number | undefined
}

/**
 * WHICH harness produced a run's results (OP-01).
 *
 * Recorded once when a run is claimed (i.e. when it really starts), and never rewritten: a
 * stored result must always be traceable to the prompt format, preset and context windows
 * that produced it. `promptContract` is the version of `prompt-contract.ts`;
 * `harnessRevision` is the hand-maintained batch marker (the git commit is not a substitute:
 * it changes for docs and UI too).
 */
export interface HarnessAttribution {
  /** The plugin package version, read from package.json at runtime; 'unknown' if unreadable. */
  readonly pluginVersion: string
  /** Hand-bumped batch marker of model-visible behaviour. */
  readonly harnessRevision: string
  /** Version of the per-turn prompt format contract. */
  readonly promptContract: number
  /** Agent preset the bot session runs under (e.g. 'bot'). */
  readonly preset: string
  /** How many recent messages the prompt window was configured for. */
  readonly historyMessages: number
  /** How many remembered entries the prompt was configured to inject. */
  readonly memoryPromptEntries: number
}

export interface BotRun {
  readonly id: BotRunId
  readonly botId: BotId
  readonly roomId: BotRoomId
  readonly sessionId: SessionId
  readonly origin: 'user' | 'routine' | 'a2a' | 'bot-message' | BotTeamRunOrigin
  /**
   * S1-1: the intake event that created this run (trace only; present when `intakeEnabled`).
   * Additive and optional — nothing reads it for behaviour.
   */
  readonly eventId?: string | undefined
  readonly prompt: string
  readonly assignment?: { readonly subject: string; readonly fromName: string } | undefined
  readonly awaitingApproval?: boolean | undefined
  readonly status: BotRunStatus
  readonly controlRevision: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly error?: string | undefined
  readonly lastError?: string | undefined
  readonly startedAt?: string | undefined
  readonly finishedAt?: string | undefined
  readonly roomSequence?: number | undefined
  readonly attempt: number
  readonly maxAttempts: number
  readonly nextRetryAt?: string | undefined
  readonly lastHeartbeatAt?: string | undefined
  readonly leaseOwner?: string | undefined
  readonly leaseExpiresAt?: string | undefined
  readonly requestId?: string | undefined
  readonly submission?: 'pending' | 'submitting' | 'submitted'
  readonly rootMessageId?: BotMessageId | undefined
  /** C4 fix: the user message this run answers, so the bot reply can carry real threading. */
  readonly originMessageId?: BotMessageId | undefined
  /**
   * C1 fix: this run is a private speculative rehearsal. Persisted so a restart cannot turn it
   * into ordinary work; delivery, memory and the task board are suppressed in `settleRun`.
   */
  readonly speculation?: boolean | undefined
  /** 2026-11-09: this run is a leader triage turn for an unaddressed group message. */
  readonly triage?: boolean | undefined
  /** 2026-11-09: a hidden turn that condenses the group experience card. */
  readonly experienceRefine?: boolean | undefined
  readonly round?: number | undefined
  /**
   * Whether this run's turn may speak in the room.
   *
   * Automatic machinery (a peer hand-off, a member report, a goal continuation) must be able
   * to run without the panel presenting it as the bot answering the user. `visible` keeps the
   * normal transcript; `internal` means the run exists but its rows are coordination only.
   * Defined here so the producer (this service) and the consumer (the ledger projection) share
   * one type; absent keeps the historical origin-based behaviour.
   */
  readonly publish?: 'visible' | 'internal' | undefined
  // ── ADAPTIVE TIMEOUT (S8) ────────────────────────────────────────────────────
  /** Wall-clock deadline derived from this deployment's history; absent = not evaluated yet. */
  readonly deadlineAt?: string | undefined
  /** Last real progress (stream frame / tool start / tool end), NOT a heartbeat. */
  readonly lastProgressAt?: string | undefined
  /** How many times the deadline was extended because the run was still progressing. */
  readonly extensions?: number | undefined
  /** Progress events observed, for the panel/diagnostics. */
  readonly progressEvents?: number | undefined
  /** Why the run failed; retry is decided from this (timeout is never retried). */
  readonly failureKind?: FailureKind | undefined
  /** Per-run deadline override from the panel; absent = derived from history. */
  readonly timeoutOverrideMs?: number | undefined
  /**
   * Who produced this run's results (OP-01): prompt contract, harness batch, preset and the
   * context-window budgets. Written once, at claim; absent on runs that never started.
   */
  readonly harness?: HarnessAttribution | undefined
  /** Measurable run evidence (OP-04): counters, finish path and failure side — no prose. */
  readonly evidence?: RunEvidence | undefined
  /** Which layer a failure belongs to (OP-04); absent on successful runs. */
  readonly faultSide?: RunFaultSide | undefined
}

/**
 * S2-3: one cross-room attention item — METADATA ONLY.
 *
 * The user can only follow a handful of rooms; this is the read-only index that says which rooms
 * need a human and why. It deliberately carries no message text or model output: a room stays an
 * isolation domain, and only its state (run status, paused flag, goal stall, task gate) leaks.
 */
export type OpenWorkKind = 'running' | 'queued' | 'awaiting-approval' | 'blocked' | 'stalled' | 'needs-review'

/** One aggregated item for a room. `count`/`botIds` describe the underlying runs when relevant. */
export interface OpenWorkItem {
  readonly kind: OpenWorkKind
  /** Epoch millis of the oldest underlying occurrence. */
  readonly since: number
  readonly count?: number | undefined
  readonly botIds?: readonly BotId[] | undefined
}

/** One room's open work. `roomName`/`directBotId` are list metadata, not room content. */
export interface OpenWorkRoom {
  readonly roomId: BotRoomId
  readonly roomName: string
  readonly directBotId?: BotId | undefined
  readonly items: readonly OpenWorkItem[]
  /** Attention-kind items only (what the row badge displays). */
  readonly attentionCount: number
}

/** 2026-11-09: manual "condense the group experience now" request. */
export interface CompactExperienceRequest {
  readonly roomId: string
}

export interface CompactExperienceResult {
  readonly ok: boolean
  readonly reason: string
}

/** The cross-room view the panel polls: rooms with open work, ordered by attention priority. */
export interface OpenWorkView {
  readonly rooms: readonly OpenWorkRoom[]
  /** Items a human should look at (awaiting-approval / needs-review / stalled / blocked). */
  readonly attentionCount: number
  readonly runningCount: number
  readonly queuedCount: number
}

export interface BotCommunitySnapshot {
  /** Deployment default for rooms with no admission setting (2026-11-09; additive). */
  readonly admissionDefault?: AdmissionMode | undefined
  readonly bots: readonly BotIdentity[]
  readonly rooms: readonly BotRoom[]
  readonly messages: readonly BotMessage[]
  readonly runs: readonly BotRun[]
  readonly mailbox: readonly BotMailboxItem[]
  /**
   * The leader's task board, flattened across rooms.
   *
   * Rides the snapshot the panel already polls (400ms while a run is live, 1500ms
   * idle) so the composer's task card is live without a second RPC. `roomId` is added
   * by the projection because the board itself is stored per room.
   */
  readonly tasks: ReadonlyArray<BotTask & { readonly roomId: string }>
  /**
   * Unread bot messages per room, keyed by room id.
   *
   * A room's count grows every time a bot posts into it and is cleared only by
   * `markRoomRead` — which the panel calls while the room is on screen. The sidebar badge per
   * room, the small dot on the Bots/群聊 tabs and the plugin entry's total all read THIS map, so
   * they can never disagree with each other. Rooms with nothing unread are absent (not zero), which
   * keeps the payload small and makes `Object.keys(unread).length === 0` the "all caught up" test.
   */
  readonly unread: Readonly<Record<string, number>>
}

/**
 * Request to clear one room's unread count.
 *
 * Sent by the panel when a room becomes visible; the badge is a view fact, not a schedule, so the
 * host never guesses when something was read.
 */
export interface MarkRoomReadRequest {
  readonly roomId: string
  /**
   * Newest message the user can have seen.
   *
   * WHAT THIS PREVENTS: without it the host marks whatever is newest WHEN THE CALL LANDS,
   * so a reply that arrives while the user is sitting in the room is marked read on the
   * next poll — the unread count never moves for the very replies the user was waiting
   * for. The caller passes the newest message that existed when it decided the room was
   * read, and everything after that stays unread.
   */
  readonly upToId?: string | undefined
}

/**
 * Record one system notice in a room's transcript.
 *
 * The panel sends the ALREADY-FORMATTED line (「已把「X」的模型设为：…」) because the wording depends on
 * what the command did; the host owns only the durability and the row. Best-effort by contract: an
 * unknown room or empty text is reported as `stored: false` rather than thrown, because a notice is
 * status feedback about something that already happened and must not fail the caller's flow.
 */
export interface NoticeRoomRequest {
  readonly roomId: string
  readonly text: string
}

/** Remove one or more bots from a room (user action from room settings). */
export interface RemoveBotsRequest {
  readonly roomId: string
  readonly botIds: readonly string[]
  readonly actorId?: string | undefined
  readonly reason?: string | undefined
}

/** Delete or confirm one learned room pattern card (OP-09 management). */
export interface RoomPatternRequest {
  readonly roomId: string
  readonly patternId: string
}

/** Save the room's one editable experience card (empty text clears it). */
export interface UpdateRoomExperienceRequest {
  readonly roomId: string
  readonly text: string
}

/**
 * The user's answer to a bot's question.
 *
 * `skip` is its own flag rather than an empty answer: "I am not choosing" and "my answer is the
 * empty string" are different instructions to the model, and the tool reports them differently.
 */
export interface AnswerBotQuestionRequest {
  readonly roomId: string
  readonly questionId: string
  readonly answer?: string | undefined
  readonly skip?: boolean | undefined
}

/** One `(room, bot)` memory partition the panel wants to show. */
export interface ListRoomMemoryRequest {
  readonly roomId: string
  readonly botId: string
}

/** What the memory panel renders: the entries plus the journal that makes revert possible. */
export interface RoomMemoryView {
  readonly entries: readonly BotMemoryEntry[]
  readonly journal: readonly MemoryJournalRow[]
}

export interface UpdateRoomMemoryRequest {
  readonly roomId: string
  readonly botId: string
  readonly entryId: string
  readonly text: string
}

export interface DeleteRoomMemoryRequest {
  readonly roomId: string
  readonly botId: string
  readonly entryId: string
}

export interface RevertRoomMemoryRequest {
  readonly roomId: string
  readonly botId: string
  readonly journalId: string
}

/** Result shape of one memory mutation: the panel shows `error` verbatim when `ok` is false. */
export interface MemoryMutationResult {
  readonly ok: boolean
  readonly error?: string | undefined
}

// ── Memory scopes (P1 second half): the bot / team partitions the panel manages ──
//
// The room partition keeps its own RPCs above (it has entry ids and a rich entry shape). The two
// long-lived scopes are simpler and line-oriented — one Markdown line per entry — so they are
// addressed by POSITION in the current file. The journal records that position too, which is what
// makes undo work without a second identity scheme (see memory-scope-store.ts).

/** Which long-lived partition an RPC addresses. `room` keeps using the memory RPCs above. */
export type ScopedMemoryScopeName = 'bot' | 'team'

/** One line of a scoped memory file, as the panel sees it. */
export interface ScopedMemoryEntryView {
  /** Zero-based position in the CURRENT file; mutations and journal rows refer to this. */
  readonly index: number
  readonly text: string
  /** ISO timestamp when the line was written; absent for hand-edited files. */
  readonly at?: string | undefined
}

/** One undoable mutation of a scoped memory file, mirroring memory-store's journal semantics. */
export interface ScopedMemoryJournalRow {
  readonly id: string
  readonly at: string
  readonly scope: ScopedMemoryScopeName
  /** The bot id for `bot` scope; `team` for the team partition. */
  readonly target: string
  readonly action: 'add' | 'update' | 'remove'
  readonly index: number
  /** Entry text before the change; absent/null for `add`. */
  readonly before?: string | null | undefined
  /** Entry text after the change; absent/null for `remove`. */
  readonly after?: string | null | undefined
}

/** One scoped partition and its undo journal. */
export interface ScopedMemoryView {
  readonly entries: readonly ScopedMemoryEntryView[]
  readonly journal: readonly ScopedMemoryJournalRow[]
}

/** Which panel tab the list is for: a bot's cross-room memory, or the team-wide rules. */
export interface ListScopedMemoryRequest {
  readonly scope: ScopedMemoryScopeName
  /** Required for `bot` scope; ignored for `team`. */
  readonly botId?: string | undefined
}

export interface UpdateScopedMemoryRequest {
  readonly scope: ScopedMemoryScopeName
  readonly botId?: string | undefined
  readonly index: number
  readonly text: string
}

export interface DeleteScopedMemoryRequest {
  readonly scope: ScopedMemoryScopeName
  readonly botId?: string | undefined
  readonly index: number
}

export interface RevertScopedMemoryRequest {
  readonly scope: ScopedMemoryScopeName
  readonly botId?: string | undefined
  readonly journalId: string
}

export interface CreateBotRequest {
  readonly name: string
  readonly description?: string | undefined
  readonly avatarSeed?: string | undefined
  readonly avatarLocked?: boolean | undefined
  readonly provider?: string | undefined
  readonly model?: string | undefined
  readonly reasoningEffort?: string | undefined
  readonly workspace?: string | undefined
  readonly systemPrompt?: string | undefined
  readonly mentionOnly?: boolean | undefined
  /** OP-18: keyword/intent labels; normalized by the service (≤20 entries, ≤40 chars each). */
  readonly subscriptions?: readonly string[] | undefined
  readonly permission?: 'read-only' | 'workspace-write' | 'full-access' | undefined
  /** S2-1: role the bot runs under; omit for the deployment's default member preset. */
  readonly agentPreset?: AgentPresetRole | undefined
  readonly profile?: Partial<BotProfileBinding>
}

export interface UpdateBotRequest {
  readonly id: string
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly avatarSeed?: string | undefined
  readonly avatarLocked?: boolean | undefined
  readonly provider?: string | undefined
  readonly model?: string | undefined
  readonly reasoningEffort?: string | undefined
  readonly workspace?: string | undefined
  readonly systemPrompt?: string | undefined
  readonly profile?: Partial<BotProfileBinding>
  readonly mentionOnly?: boolean | undefined
  /** OP-18: keyword/intent labels; omitted keeps the stored list, [] clears it. */
  readonly subscriptions?: readonly string[] | undefined
  readonly permission?: 'read-only' | 'workspace-write' | 'full-access' | undefined
  /** S2-1: role the bot runs under; omitted keeps the stored role. */
  readonly agentPreset?: AgentPresetRole | undefined
}

export interface CreateTeamRequest {
  readonly leaderBotId?: string | undefined
  readonly leaderSessionId?: string | undefined
  readonly leaderName: string
  readonly workspace?: string | undefined
}

export interface PostTeamMessageRequest {
  readonly roomId: string
  readonly sender: { readonly kind: 'leader' | 'bot' | 'user'; readonly botId?: string; readonly name: string }
  readonly text: string
  readonly kind: BotTeamMessageKind
  readonly targetBotIds: readonly string[]
  readonly targetNames: readonly string[]
  readonly origin: BotTeamRunOrigin
  readonly assignment?: { readonly subject: string; readonly fromName: string } | undefined
}

export interface TeamMessageResult {
  readonly message: BotMessage
  readonly runs: readonly BotRun[]
}

export interface DismissTeamRequest {
  readonly roomId: string
  readonly summary: string
}

export interface TeamApproval {
  readonly id: string
  readonly roomId: BotRoomId
  readonly memberName: string
  readonly sessionId: SessionId
  readonly toolName: string
  readonly reason?: string
  readonly createdAt: string
}

export interface TeamApprovalAnswer {
  readonly id: string
  readonly outcome: 'allowed-once' | 'rejected'
}

export interface TeamOverview {
  readonly room: BotRoom
  readonly members: readonly {
    readonly botId: BotId
    readonly name: string
    readonly presence: BotPresence
    readonly sessionId?: SessionId
  }[]
  readonly approvals: readonly TeamApproval[]
}

export interface BotTeamMembership {
  readonly room: BotRoom
  readonly role: 'lead' | 'member'
  readonly name: string
  readonly botId?: BotId | undefined
}

export interface CreateRoomRequest {
  readonly directBotId?: string | undefined
  readonly name: string
  readonly memberIds?: readonly string[] | undefined
  readonly imagePath?: string | undefined
  readonly mentionOnly?: boolean | undefined
  readonly paused?: boolean | undefined
  readonly team?: CreateTeamRequest | undefined
  /**
   * The calling agent's session, when a Bot is asking.
   *
   * Absent means the user (the panel, the CLI, or the group flow's own confirm step). Present and
   * owned by this plugin means a Bot, which may NOT create a group room — see `room-guard.ts`.
   */
  readonly actorSessionId?: string | undefined
}

/**
 * One file the user attached to an outgoing message.
 *
 * The bytes travel INLINE as base64. That is not laziness: the browser half cannot see
 * the host's filesystem (a `File` has no path), and the host must never accept a
 * caller-supplied path — an "attachment name" of `../../foo` would otherwise be an
 * arbitrary-write primitive. The host decodes the bytes, sanitizes the name, and stores
 * the file itself, inside the receiving bot's own workspace.
 */
export interface SendRoomMessageAttachment {
  /** Original file name. The chip label, and the (sanitized) stored name. */
  readonly name: string
  /** MIME type as reported by the browser; `undefined` when it does not know. */
  readonly mime?: string | undefined
  /** The file's bytes, base64, with no `data:` URL prefix. */
  readonly dataBase64: string
}

export interface SendRoomMessageRequest {
  readonly roomId: string
  /**
   * What the user actually typed. This is what the panel renders and what is
   * persisted, so it must stay exactly the draft — never the expanded form.
   */
  readonly text: string
  /**
   * Optional richer payload for the MODEL only, kept separate from {@link text}.
   *
   * A `/skill` gesture expands into a `<skill_content>` block that can exceed 46 KB.
   * Writing that into `text` made the panel render the entire SKILL.md plus its raw
   * XML tags inside the user's own bubble. The host draws the same distinction: the
   * bubble shows the draft, the reference expansion exists only as model input.
   */
  readonly modelText?: string | undefined
  readonly senderName?: string | undefined
  /**
   * Files the user attached to this message.
   *
   * They never enter {@link text} or {@link modelText}: the host stores each one under
   * the receiving bot's workspace and appends an `[附件]` reference block to the MODEL
   * payload only, so the user's bubble stays exactly what they typed.
   */
  readonly attachments?: readonly SendRoomMessageAttachment[] | undefined
  /** Bot ids or names mentioned via @ prefix; combined with parsed @mentions. */
  readonly mentions?: readonly string[] | undefined
  /** auto = normal routing; direct-reply = only mentioned bots respond. */
  readonly mode?: 'auto' | 'direct-reply' | undefined
  /** OP-14: optional threading/task linkage, validated by `normalizeThreading` before storing. */
  readonly replyTo?: string | undefined
  readonly threadId?: string | undefined
  readonly taskId?: string | undefined
}

/**
 * OP-12: a bot's structured "I cannot complete this piece" (the `agent_community_abstain` tool).
 *
 * Deliberately NOT a failure signal: the run continues and the task stays open. It becomes a
 * visible room notice so the USER sees the reason, what is missing, and who the bot suggests could
 * take it — exactly the information a re-plan needs. It stays out of the bot prompt and does not
 * end the run (the service records a notice, never a message).
 */
export interface AbstainRequest {
  /** Why this bot cannot do it (required: an abstention without a reason helps nobody). */
  readonly reason: string
  /** What is missing: files, data, permissions, another member's output (at most 5). */
  readonly missing?: readonly string[] | undefined
  /** A member name or role the bot suggests could take it over (at most 60 chars). */
  readonly suggestedOwner?: string | undefined
}

export interface RetryBotRunRequest {
  readonly id: string
  readonly expectedRevision: number
}

export interface ControlBotRunRequest {
  readonly id: string
  readonly action: 'steer' | 'interrupt' | 'cancel'
  readonly expectedRevision: number
  readonly text?: string | undefined
  readonly retryFromAttempt?: number | undefined
}

export interface SettleBotRunRequest {
  readonly id: string
  readonly expectedRevision: number
  readonly status: 'completed' | 'interrupted' | 'failed'
  readonly error?: string | undefined
  readonly retry?: boolean | undefined
  readonly leaseOwner?: string | undefined
  /** The failure category: decides whether a retry is allowed and is persisted on the run. */
  readonly failureKind?: FailureKind | undefined
  /** Measurable evidence of this run (OP-04); the service folds in duration/finish path. */
  readonly evidence?: RunEvidence | undefined
  readonly reply?: {
    readonly text: string
    readonly sessionSeq: SessionSeq
    readonly reasoning?: string | undefined
    readonly toolActivity?: readonly { readonly name: string; readonly status: string; readonly detail?: string | undefined }[] | undefined
    readonly deliverables?: readonly DeliveredFile[] | undefined
    readonly usage?: BotMessageUsage | undefined
  } | undefined
}

export interface DeleteRoomRequest {
  readonly id: string
}

export interface DeleteBotRequest {
  readonly id: string
}

export interface UpdateRoomRequest {
  readonly id: string
  readonly name?: string | undefined
  readonly imagePath?: string | undefined
  readonly memberIds?: readonly string[] | undefined
  readonly mentionOnly?: boolean | undefined
  readonly paused?: boolean | undefined
  /** S0-3: omitted keeps the room's current mode; `{ mode }` replaces it. */
  readonly admission?: BotRoomAdmission | undefined
  /** S2-4: omitted keeps the stored speculation setting; `{ mode, dailyLimit? }` replaces it. */
  readonly speculation?: BotRoomSpeculation | undefined
  /** S2-5: omitted keeps the stored assessment setting; `{ enabled, rules }` replaces it. */
  readonly admissionAssess?: { readonly enabled?: boolean; readonly rules?: string } | undefined
}

// ── Orchestration types (P1-2 / P1-3) ─────────────────────────────────────

export type BotTaskStatus = 'open' | 'assigned' | 'working' | 'reported' | 'done' | 'blocked' | 'cancelled'

export interface BotTask {
  readonly id: string
  readonly round: number
  readonly subject: string
  readonly detail?: string | undefined
  readonly assigneeId?: BotId | undefined
  readonly assigneeName?: string | undefined
  readonly status: BotTaskStatus
  readonly report?: {
    readonly text: string
    readonly runId?: BotRunId | undefined
    readonly at: string
  } | undefined
  readonly attempts: number
  readonly createdAt: string
  readonly updatedAt: string
}

export interface DecomposeTasksRequest {
  readonly roomId: string
  readonly leaderSessionId: string
  readonly tasks: ReadonlyArray<{
    readonly subject: string
    readonly detail?: string | undefined
    readonly assigneeName?: string | undefined
  }>
}

export interface AssignTasksRequest {
  readonly roomId: string
  readonly leaderSessionId: string
  readonly taskIds: readonly string[]
  readonly assigneeName: string
}

export interface ReportTaskRequest {
  readonly taskId: string
  readonly memberSessionId: string
  readonly text: string
  readonly status: 'working' | 'done' | 'blocked'
}

export interface PostBotMessageRequest {
  readonly roomId: string
  readonly senderSessionId: string
  readonly text: string
  readonly toBotName?: string | undefined
}

export interface SubmitFinalRequest {
  readonly roomId: string
  readonly leaderSessionId: string
  readonly summary: string
  readonly replyToUser: string
}

// ── Group proposal (P1-4) ─────────────────────────────────────────────────

export interface GroupProposal {
  readonly id: string
  readonly sourceRoomId: string
  readonly sourceMessageId: BotMessageId
  readonly suggestedName: string
  readonly suggestedMemberIds: readonly BotId[]
  readonly suggestedLeaderId?: BotId | undefined
  readonly reason: string
  readonly createdAt: string
}

export interface ProposeGroupRequest {
  readonly roomId: string
  readonly messageId: string
  /**
   * The bot's OWN proposal, when the `propose_group` tool supplies one. Omitted by
   * the panel's poll, which asks the host to have the direct-chat bot judge the
   * message instead. Either way the roster comes from the live bot list — never
   * from a count of how many bots happen to exist.
   */
  readonly name?: string | undefined
  readonly memberIds?: readonly string[] | undefined
  readonly leaderId?: string | undefined
  readonly reason?: string | undefined
  /** Run that produced the message, recorded on the pending proposal. */
  readonly runId?: string | undefined
}

export interface ConfirmGroupRequest {
  readonly proposalId: string
  readonly memberIds: readonly string[]
  readonly name?: string | undefined
  /**
   * The leader the user picked in the dialog.
   *
   * Optional and validated at confirm time (`chooseValidLeader`): it must be one of the
   * surviving members. Absent keeps the proposal's leader, which is the source bot when it
   * was still a member — the bot that holds the task's first-hand context.
   */
  readonly leaderId?: string | undefined
}

export interface DeclineGroupRequest {
  readonly proposalId: string
}

// ── Group flow + skill lifecycle increments (§6) ───────────────────────────────

/**
 * A skill pre-selection for one bot, derived from its identity (§5.3).
 *
 * `signature` is what makes this self-invalidating: it covers both the skill set
 * and the bot's own description/systemPrompt, so the profile is discarded the
 * moment either changes and no invalidation call site can be forgotten.
 */
export interface BotSkillProfile {
  readonly names: readonly string[]
  readonly signature: string
  readonly analyzedAt: string
}

/** One member's slot on a room's task board. */
export interface RoomTaskAssignment {
  readonly id: string
  readonly botId: BotId
  /** What this member is responsible for, as the leader worded it. */
  readonly task: string
  readonly at: string
  readonly status?: BotTaskStatus | undefined
  /** Written by the assignee (or the leader); a member may only edit its own row. */
  readonly report?: { readonly text: string; readonly at: string } | undefined
  // ── P2-2: DELIVERY LOOP ─────────────────────────────────────────────────────
  // Additive fields: a board written before them has none and reads as "no file
  // requirement, no declared files". They are FACTS for the prompt/adherence scorecard,
  // never a hard gate — `finish_task` still closes a task whose file is missing.
  /** The leader marked this work as requiring FILE output. */
  readonly requiresDeliverables?: boolean | undefined
  /** Files the member declared with `agent_community_deliver` when it settled; empty = none. */
  readonly deliverables?: readonly string[] | undefined
  /** What the member last reported: working while assigned, done/failed once it settled. */
  readonly reportedStatus?: 'working' | 'done' | 'failed' | undefined
}

/**
 * One piece of verifiable evidence that a group task is really delivered (OP-02).
 *
 * A `finish_task` declaration is gated on these: a file that exists on disk, a message that
 * exists in THIS room, or an assignment on this room's board that was reported/done. The three
 * variants are deliberately about things the host can CHECK — a prose claim is not evidence.
 */
export type FinishEvidence =
  | {
    readonly kind: 'file'
    /** Relative to the leader's workspace, or absolute. */
    readonly path: string
    /** Optional integrity check (hex sha256); files above 128 MB skip the hash. */
    readonly sha256?: string | undefined
  }
  | {
    readonly kind: 'message'
    readonly messageId: string
    /** When given, the message must belong to this run. */
    readonly runId?: string | undefined
  }
  | {
    readonly kind: 'task'
    /** Assignment id from this room's task board. */
    readonly taskId: string
  }

/** What the `finish_task` tool sends to the service. */
export interface FinishTaskRequest {
  readonly roomId: string
  readonly leaderId: string
  readonly report: string
  readonly evidence: readonly FinishEvidence[]
}

/**
 * Background task board for one room (§5.4: "不建任务板 UI，但后台有任务板").
 *
 * It exists because the leader's own session is the only place progress would
 * otherwise live — and that session is not visible to the members, nor to the user.
 */
export interface RoomTaskState {
  readonly round: number
  readonly maxRounds: number
  readonly assignments: readonly RoomTaskAssignment[]
  readonly finished?: {
    readonly report: string
    readonly at: string
    /** What the finish gate accepted (OP-02); absent on tasks closed before the gate. */
    readonly evidence?: readonly FinishEvidence[] | undefined
    /** `bypassed` = passed after repeated gate rejections, i.e. NOT verified. */
    readonly gate?: 'passed' | 'bypassed' | undefined
  } | undefined
  /** The user's original task, kept verbatim so a member hand-off can restate it (§24.6). */
  readonly objective?: string | undefined
  // ── OP-07: VERSIONED BOARD ──────────────────────────────────────────────────
  // Additive fields: boards written before them are valid (absent = v1 / version 0). The
  // transaction layer (`task-board.ts`) owns the bumps; converters only carry them across.
  /** Schema version of the persisted board; absent means the pre-versioning shape (v1). */
  readonly schemaVersion?: number | undefined
  /** Monotonic write version for optimistic concurrency; bumped once per applied operation. */
  readonly version?: number | undefined
  /** When the board last changed (ISO); stamped by the writer that bumped `version`. */
  readonly updatedAt?: string | undefined
  /** P2 collaboration-adherence counts/score, derived from this board at save time. */
  readonly adherence?: import('./adherence.ts').TaskAdherence | undefined
  /**
   * P3-2: the leader's task ledger (facts / plan / progress) for THIS task.
   *
   * Additive and optional: a board written before this field is empty, and a task without a
   * ledger behaves exactly as before. It lives on the board because the driver saves the board
   * on every meaningful change; a restart then re-renders the same account into the next
   * dispatch/integrate prompt instead of making the leader re-derive it.
   */
  readonly leaderLedger?: import('./leader-ledger.ts').LeaderLedger | undefined
}

/**
 * The user's grant that lets a room goal continue itself.
 *
 * AUTO-RUN IS OPT-IN, NEVER INFERRED. A goal is data a bot can write, but a continuation
 * spends the user's tokens without a new message, so the authority for it must be a separate,
 * user-only record. A bot may PROPOSE a goal (status 'proposed'); only this object — written by
 * the user's own act (panel confirm / resume) — lets `afterRunSettled` queue the next round.
 *
 * `roundsUsed` is spent by the plugin, never by a goal edit: a bot that updates its progress
 * text every round must not reset the budget (that reset was the unbounded loop this field
 * exists to stop).
 */
export interface RoomGoalAuthorization {
  readonly grantedBy: 'user'
  /** How many automatic continuation rounds the user allowed for this goal. */
  readonly maxRounds: number
  /** Automatic rounds already queued against this grant. */
  readonly roundsUsed: number
  readonly grantedAt: string
  /** Optional expiry; past it the grant is dead and the goal must be re-authorized. */
  readonly expiresAt?: string | undefined
}

/**
 * One room's objective — the thing the bots in THAT room are working toward.
 *
 * Keyed by the room and nothing else, which is what keeps the user's four isolation rules
 * true: a DM's goal cannot touch a group's, one group's cannot touch another's, and one bot's
 * DM goal cannot touch another bot's. Read `room-goal.ts` for why it is not DSH's `create_goal`.
 */
export interface RoomGoal {
  readonly text: string
  /**
   * `proposed` is a Bot's suggestion and is NOT actionable: it neither continues itself nor
   * counts as the room's active objective until the user authorizes it.
   */
  readonly status: 'active' | 'paused' | 'done' | 'proposed'
  readonly createdAt: string
  readonly updatedAt: string
  /** The bot that set it; absent means the user did. */
  readonly ownerBotId?: BotId | undefined
  /** User grant for automatic continuation; absent = no auto-run, ever. */
  readonly authorization?: RoomGoalAuthorization | undefined
  /** LEGACY counter kept for older persisted goals; new decisions use `authorization.roundsUsed`. */
  readonly continuations?: number | undefined
  /** Consecutive goal-driven rounds that produced nothing — the stall guard. */
  readonly stalledRounds?: number | undefined
}

/**
 * A group proposal awaiting the user's answer (§5.4 / §6).
 *
 * Recorded on the source direct room. Members are captured from the live bot list,
 * so a bot deleted after this record was written cannot be "confirmed" into a
 * group — `confirmGroup` filters once more for the concurrent-delete case.
 */
export interface PendingGroupProposal {
  readonly id: string
  /** The DIRECT room that asked; the new group only exists after confirmation. */
  readonly roomId: BotRoomId
  /** Run whose message produced the proposal, when the message carried one. */
  readonly runId?: BotRunId | undefined
  readonly sourceMessageId?: BotMessageId | undefined
  /** The user's original message text, replayed verbatim into the group on confirm. */
  readonly taskText: string
  readonly name: string
  readonly memberIds: readonly BotId[]
  readonly leaderId: BotId
  readonly reason: string
  readonly status: 'pending' | 'confirmed' | 'declined' | 'expired'
  readonly createdAt: string
  /** When an unanswered proposal stops counting as pending (§5.4 timeout = decline). */
  readonly expiresAt?: string | undefined
  /** Set once confirmed, so the panel can navigate to the room it created. */
  readonly createdRoomId?: BotRoomId | undefined
}

// ── Per-(room, bot) memory ────────────────────────────────────────────────────

/**
 * One thing a Bot remembers about ONE room it worked in.
 *
 * The user's rule for this feature is an isolation rule: a Bot carries what it did in a direct
 * chat and what it did in each group it belongs to, and those memories are never shared — a task
 * from one group must not surface in another, and a 1:1 task must not surface in a group. The key
 * below is therefore the PAIR, not the bot: there is no structure anywhere that holds one bot's
 * memories for two rooms at once.
 */
export interface BotMemoryEntry {
  readonly id: string
  /**
   * `task` — written automatically when a run of this bot finishes in this room.
   * `note` — written by the bot itself through the `agent_community_remember` tool.
   */
  readonly kind: 'task' | 'note'
  /** One compact line: what was asked, and what came of it. */
  readonly text: string
  /** When it was recorded (ISO). */
  readonly at: string
  /** The run that produced it, for `task` entries. */
  readonly runId?: string | undefined
  /**
   * Where the entry came from (OP-08).
   *
   * `run` — a user-driven run; `note` — the bot asked to remember it; `a2a` — a peer bot or a
   * leader's hand-off started the turn; `routine` — a timer/reminder/continuation started it;
   * `unknown` — legacy or hand-edited line. Absent means legacy (see `memory-lifecycle.ts`).
   */
  readonly source?: 'run' | 'note' | 'a2a' | 'routine' | 'unknown' | undefined
  /**
   * Lifecycle state (OP-08): `active` is injected into the main prompt, `probation` (peer/timer
   * work, unconfirmed) is searchable but not injected, `decayed` (the user corrected it) stops
   * influencing the prompt. Absent means `active` (pre-OP-08 data).
   */
  readonly status?: 'active' | 'probation' | 'decayed' | undefined
  /** How the recorded attempt ended, from the user's point of view. Absent = legacy/unknown. */
  readonly outcome?: 'positive' | 'negative' | 'unknown' | undefined
  /** 0..1 confidence; see `confidenceOf` for the default/clamp rules. */
  readonly confidence?: number | undefined
  /** When the lifecycle last touched this entry (decay/maintain). Absent on legacy lines. */
  readonly updatedAt?: string | undefined
}

/**
 * One (room, bot) pair's memory — the whole partition, bounded by the caps in `bot-memory.ts`.
 *
 * Stored as a top-level array keyed by the pair (like `roomAgentSessions`), deliberately NOT as a
 * field on the room: `snapshot()` and `listRooms()` hand room records to the browser whole and the
 * panel polls them every 400ms while a run is live, so memory stored there would be shipped to the
 * client on every tick. Here it never reaches an RPC payload.
 */
export interface BotMemoryRecord {
  readonly roomId: BotRoomId
  readonly botId: BotId
  /** Oldest first; trimmed from the front when the cap is reached. */
  readonly entries: BotMemoryEntry[]
  readonly updatedAt: string
}
