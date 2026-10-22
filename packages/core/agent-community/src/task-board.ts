/**
 * The room task board as a VERSIONED, ROLE-CONTRACTED state machine (OP-07).
 *
 * WHY THIS MODULE EXISTS. The board used to be edited by scattered service code: a method
 * looked up the room, mutated `room.taskState` inline, saved it, and each caller was trusted
 * to have checked leadership/permission itself. That makes three properties impossible to
 * guarantee:
 *
 *   · STRUCTURE — a partially-written board (missing botId, duplicate assignment id, an
 *     unknown status) could reach state.json and break every later reader;
 *   · AUTHORITY — "a member may only write its own row" lived in one method, while other
 *     writers did their own checks (or none);
 *   · ATOMICITY — a mutation happening between read and save could silently overwrite the
 *     board from a stale copy.
 *
 * So the board is now a small PURE state machine:
 *
 *   validateTaskBoard(state)                      — the persisted shape, against a schema version
 *   applyTaskBoardOperation(state, op, context)   — one role-checked, version-checked transition
 *   applyTaskBoardTransaction(state, ops, context)— all-or-nothing application of many
 *
 * Every successful operation bumps `version` and stamps `updatedAt`; a writer that supplies
 * `expectedVersion` is refused with `stale-version` instead of clobbering a newer board.
 * Nothing here touches storage, the clock or ids beyond the injected `now`/`actor` — the
 * service ports save the ONE resulting state.
 *
 * @module
 */
import type { BotTaskStatus, FinishEvidence, RoomTaskAssignment, RoomTaskState } from './types.ts'

/**
 * Schema version of the persisted board.
 *
 * Bump when the SHAPE changes (a new required field, a changed status vocabulary). Readers
 * accept older/absent versions (see `validateTaskBoard`) and refuse future ones, so an old
 * process cannot mangle a board written by a newer one.
 */
export const TASK_BOARD_SCHEMA_VERSION = 1

/** Who is writing: the leader, a member (own row only), the system itself, or a user. */
export type TaskBoardActor = 'leader' | 'member' | 'system' | 'user'

/** Assignment statuses the persisted schema allows (the shared `BotTaskStatus` vocabulary). */
const ASSIGNMENT_STATUSES: ReadonlyArray<BotTaskStatus> = [
  'open', 'assigned', 'working', 'reported', 'done', 'blocked', 'cancelled',
]

const ASSIGNMENT_STATUS_SET: ReadonlySet<BotTaskStatus> = new Set(ASSIGNMENT_STATUSES)

/**
 * Allowed status transitions for one assignment.
 *
 * The promised flow is `assigned → working → reported → done`, with failure expressed as
 * `blocked`; going BACKWARDS from `done` is what this table forbids (a completed row silently
 * becoming "working" again is exactly how a board lies about its progress). `cancelled` is
 * terminal too. Only the system may cancel, and only through `validateTaskBoard`-legal writes.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<BotTaskStatus, readonly BotTaskStatus[]>> = {
  open: ['assigned', 'working', 'reported', 'done', 'blocked', 'cancelled'],
  assigned: ['working', 'reported', 'done', 'blocked', 'cancelled'],
  working: ['working', 'reported', 'done', 'blocked', 'cancelled'],
  reported: ['reported', 'done', 'blocked', 'cancelled'],
  done: ['done'],
  blocked: ['blocked', 'working', 'reported', 'done', 'cancelled'],
  cancelled: ['cancelled'],
}

/** Statuses that close an assignment for good (no transition out). */
const TERMINAL_STATUSES: ReadonlySet<BotTaskStatus> = new Set(['done', 'cancelled'])

/** The operation vocabulary. Each one is a single atomic board write. */
export type TaskBoardOperation =
  | { readonly kind: 'assign'; readonly botId: string; readonly task: string }
  | {
    readonly kind: 'report'
    readonly taskId: string
    readonly botId: string
    readonly text: string
    readonly status?: 'working' | 'reported' | 'done' | 'failed' | undefined
  }
  | { readonly kind: 'advance' }
  | {
    readonly kind: 'finish'
    readonly report: string
    readonly evidence?: readonly FinishEvidence[] | undefined
    readonly gate?: 'passed' | 'bypassed' | undefined
  }
  | { readonly kind: 'fail'; readonly reason?: string | undefined }

/** Everything a writer may not supply from ambient state: its role, the clock, its version. */
export interface TaskBoardContext {
  readonly actor: TaskBoardActor
  /** The writing bot (leader/member); absent for system/user. */
  readonly actorBotId?: string | undefined
  /** The room's members, when the caller knows them: assign only targets a member. */
  readonly memberIds?: readonly string[] | undefined
  /** Optimistic concurrency: the version the writer read; a mismatch is `stale-version`. */
  readonly expectedVersion?: number | undefined
  /** ISO clock, injected so the state machine stays pure/testable. */
  readonly now: string
}

/** Machine-readable refusal reasons. */
export type TaskBoardErrorCode =
  | 'invalid-board'
  | 'stale-version'
  | 'finished'
  | 'forbidden'
  | 'invalid-operation'
  | 'not-found'
  | 'invalid-transition'

/** One audit event per applied operation. */
export type TaskBoardEvent =
  | { readonly kind: 'assign'; readonly at: string; readonly taskId: string; readonly botId: string; readonly task: string }
  | { readonly kind: 'report'; readonly at: string; readonly taskId: string; readonly botId: string; readonly status: BotTaskStatus }
  | { readonly kind: 'advance'; readonly at: string; readonly round: number; readonly finished: boolean }
  | { readonly kind: 'finish'; readonly at: string; readonly gate?: 'passed' | 'bypassed' | undefined }
  | { readonly kind: 'fail'; readonly at: string; readonly reason?: string | undefined }

export type TaskBoardApplyResult =
  | { readonly ok: true; readonly state: RoomTaskState; readonly events: readonly TaskBoardEvent[] }
  | { readonly ok: false; readonly reason: string; readonly code: TaskBoardErrorCode }

export type TaskBoardTransactionResult =
  | { readonly ok: true; readonly state: RoomTaskState; readonly events: readonly TaskBoardEvent[] }
  | { readonly ok: false; readonly reason: string; readonly code: TaskBoardErrorCode }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * Validate a persisted board against the schema.
 *
 * Returns every problem found (empty array = valid), so a diagnostic/log line can name all of
 * them. `schemaVersion` ABSENT is accepted as v1 (boards written before this field existed);
 * a version NEWER than this build is refused — that board was written by a newer process and
 * silently editing it would mangle fields this code does not know about.
 */
export function validateTaskBoard(state: RoomTaskState | undefined): string[] {
  const errors: string[] = []
  if (state === undefined) return ['任务板不存在']
  const schemaVersion = (state as { schemaVersion?: unknown }).schemaVersion
  if (schemaVersion !== undefined) {
    if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
      errors.push(`schemaVersion 非法：${String(schemaVersion)}`)
    } else if (schemaVersion > TASK_BOARD_SCHEMA_VERSION) {
      errors.push(`不支持的 schemaVersion ${schemaVersion}（本版本最高 ${TASK_BOARD_SCHEMA_VERSION}）`)
    }
  }
  const version = (state as { version?: unknown }).version
  if (version !== undefined && (typeof version !== 'number' || !Number.isInteger(version) || version < 0)) {
    errors.push(`version 非法：${String(version)}`)
  }
  if (typeof state.round !== 'number' || !Number.isInteger(state.round) || state.round < 0) {
    errors.push(`round 非法：${String(state.round)}`)
  }
  if (typeof state.maxRounds !== 'number' || !Number.isInteger(state.maxRounds) || state.maxRounds < 0) {
    errors.push(`maxRounds 非法：${String(state.maxRounds)}`)
  }
  if (!Array.isArray(state.assignments)) {
    errors.push('assignments 必须是数组')
  } else {
    const ids = new Set<string>()
    for (const [index, assignment] of state.assignments.entries()) {
      const label = `第 ${index + 1} 个 assignment`
      if (!isPlainObject(assignment)) {
        errors.push(`${label} 不是对象`)
        continue
      }
      if (!nonEmptyString(assignment.id)) errors.push(`${label} 缺少 id`)
      else if (ids.has(assignment.id)) errors.push(`assignment id 重复：${assignment.id}`)
      else ids.add(assignment.id)
      if (!nonEmptyString(assignment.botId)) errors.push(`${label} 缺少 botId`)
      if (!nonEmptyString(assignment.task)) errors.push(`${label} 缺少 task`)
      if (!nonEmptyString(assignment.at)) errors.push(`${label} 缺少 at`)
      if (assignment.status !== undefined && !ASSIGNMENT_STATUS_SET.has(assignment.status as BotTaskStatus)) {
        errors.push(`${label} 的 status 非法：${String(assignment.status)}`)
      }
      if (assignment.report !== undefined) {
        if (!isPlainObject(assignment.report)
          || typeof assignment.report.text !== 'string'
          || !nonEmptyString(assignment.report.at)) {
          errors.push(`${label} 的 report 形状非法`)
        }
      }
    }
  }
  if (state.finished !== undefined) {
    const finished = state.finished as unknown
    if (!isPlainObject(finished)) {
      errors.push('finished 不是对象')
    } else {
      if (!nonEmptyString(finished.report)) errors.push('finished 缺少 report')
      if (!nonEmptyString(finished.at)) errors.push('finished 缺少 at')
      if (finished.evidence !== undefined && !Array.isArray(finished.evidence)) {
        errors.push('finished.evidence 必须是数组')
      }
      if (finished.gate !== undefined && finished.gate !== 'passed' && finished.gate !== 'bypassed') {
        errors.push(`finished.gate 非法：${String(finished.gate)}`)
      }
    }
  }
  if (state.objective !== undefined && typeof state.objective !== 'string') {
    errors.push('objective 必须是字符串')
  }
  return errors
}

function refusal(code: TaskBoardErrorCode, reason: string): TaskBoardApplyResult {
  return { ok: false, code, reason }
}

/** Fail unless the actor may make leader-level writes (assign/advance/finish/fail). */
function leaderOnly(actor: TaskBoardActor, action: string): TaskBoardApplyResult | undefined {
  if (actor === 'leader' || actor === 'system') return undefined
  return refusal('forbidden', `${action} 只能由 leader/system 执行（当前 actor=${actor}）`)
}

/** The status an assignment ends up in for a requested report status. */
function targetStatus(requested: 'working' | 'reported' | 'done' | 'failed' | undefined): BotTaskStatus {
  // `failed` is expressed in the persisted vocabulary as `blocked` (the same status the
  // scheduler already understands); everything else maps one-to-one.
  if (requested === undefined) return 'working'
  return requested === 'failed' ? 'blocked' : requested
}

/** Stamp a successful transition: schema version, monotonic version, timestamp. */
function nextState(state: RoomTaskState, patch: Partial<RoomTaskState>, context: TaskBoardContext): RoomTaskState {
  return {
    ...state,
    ...patch,
    schemaVersion: TASK_BOARD_SCHEMA_VERSION,
    version: (state.version ?? 0) + 1,
    updatedAt: context.now,
  }
}

/**
 * Apply ONE operation: validate → check version → check role → transition → version bump.
 *
 * Pure: the same (state, operation, context) always yields the same result, and the input
 * state is never mutated. A refusal carries a machine code plus a human reason.
 */
export function applyTaskBoardOperation(
  state: RoomTaskState,
  operation: TaskBoardOperation,
  context: TaskBoardContext,
): TaskBoardApplyResult {
  const invalid = validateTaskBoard(state)
  if (invalid.length > 0) return refusal('invalid-board', invalid.join('；'))
  if (context.expectedVersion !== undefined && context.expectedVersion !== (state.version ?? 0)) {
    return refusal('stale-version', `任务板已变化：期望 version=${context.expectedVersion}，实际 ${state.version ?? 0}`)
  }
  if (state.finished !== undefined) {
    return refusal('finished', '任务板已收尾，不能再写入（新任务应先创建新任务板）')
  }
  // A user ACTS on the board through the system path (a panel action becomes a system write);
  // it may never write the internal board directly, so the role contract has one owner.
  if (context.actor === 'user') {
    return refusal('forbidden', '用户不能直接写内部任务板，请通过 system 路径执行')
  }

  switch (operation.kind) {
    case 'assign': {
      const forbidden = leaderOnly(context.actor, 'assign')
      if (forbidden !== undefined) return forbidden
      if (!nonEmptyString(operation.botId)) return refusal('invalid-operation', 'assign 缺少 botId')
      if (!nonEmptyString(operation.task)) return refusal('invalid-operation', 'assign 的 task 不能为空')
      if (context.memberIds !== undefined && !context.memberIds.includes(operation.botId)) {
        return refusal('forbidden', `Bot "${operation.botId}" 不是本房间成员，不能分派任务`)
      }
      const assignment: RoomTaskAssignment = {
        // Deterministic and unique inside one board: the writer's id factory is not part of the
        // contract, and a pure function must not reach for randomUUID.
        id: `${operation.botId}:${context.now}:${state.assignments.length}`,
        botId: operation.botId as RoomTaskAssignment['botId'],
        task: operation.task,
        at: context.now,
        status: 'assigned',
      }
      const next = nextState(state, { assignments: [...state.assignments, assignment] }, context)
      return {
        ok: true,
        state: next,
        events: [{
          kind: 'assign',
          at: context.now,
          taskId: assignment.id,
          botId: operation.botId,
          task: operation.task,
        }],
      }
    }

    case 'report': {
      const index = state.assignments.findIndex(assignment => assignment.id === operation.taskId)
      if (index < 0) return refusal('not-found', `任务 "${operation.taskId}" 不存在`)
      const entry = state.assignments[index]!
      if (!nonEmptyString(operation.botId)) return refusal('invalid-operation', 'report 缺少 botId')
      if (typeof operation.text !== 'string') return refusal('invalid-operation', 'report 缺少 text')
      if (operation.botId !== entry.botId) {
        // The row's owner is part of its identity: moving it would rewrite history.
        return refusal('forbidden', `任务 "${entry.id}" 的归属是 "${entry.botId}"，所有者不可变更`)
      }
      if (context.actor === 'member') {
        if (context.actorBotId === undefined || context.actorBotId !== entry.botId) {
          return refusal(
            'forbidden',
            `Bot "${context.actorBotId ?? 'unknown'}" 只能写自己的任务，不能编辑 "${entry.botId}" 的行`,
          )
        }
      }
      const requested = operation.status
      if (requested !== undefined
        && requested !== 'working' && requested !== 'reported' && requested !== 'done' && requested !== 'failed') {
        return refusal('invalid-operation', `report 的 status 非法：${String(requested)}`)
      }
      const from = entry.status ?? 'open'
      const to = targetStatus(requested)
      const allowed = ALLOWED_TRANSITIONS[from] ?? []
      if (!allowed.includes(to)) {
        return refusal('invalid-transition', `任务 "${entry.id}" 不能从 ${from} 变为 ${to}`)
      }
      if (TERMINAL_STATUSES.has(from) && from !== to) {
        return refusal('invalid-transition', `任务 "${entry.id}" 已是终态 ${from}`)
      }
      const assignments = [...state.assignments]
      assignments[index] = {
        ...entry,
        status: to,
        report: { text: operation.text, at: context.now },
      }
      const next = nextState(state, { assignments }, context)
      return {
        ok: true,
        state: next,
        events: [{ kind: 'report', at: context.now, taskId: entry.id, botId: entry.botId, status: to }],
      }
    }

    case 'advance': {
      const forbidden = leaderOnly(context.actor, 'advance')
      if (forbidden !== undefined) return forbidden
      const round = state.round + 1
      // EXHAUSTING THE BUDGET FINALISES THE BOARD — the existing round-limit semantics: the
      // round is still recorded, and the board closes with the same report wording.
      if (round > state.maxRounds) {
        const finished = {
          report: `已达轮次上限 ${state.maxRounds}，收尾`,
          at: context.now,
        }
        const next = nextState(state, { round, finished }, context)
        return {
          ok: true,
          state: next,
          events: [{ kind: 'advance', at: context.now, round, finished: true }],
        }
      }
      const next = nextState(state, { round }, context)
      return { ok: true, state: next, events: [{ kind: 'advance', at: context.now, round, finished: false }] }
    }

    case 'finish': {
      const forbidden = leaderOnly(context.actor, 'finish')
      if (forbidden !== undefined) return forbidden
      if (!nonEmptyString(operation.report)) return refusal('invalid-operation', 'finish 的 report 不能为空')
      const finished = {
        report: operation.report,
        at: context.now,
        ...(operation.evidence !== undefined ? { evidence: operation.evidence } : {}),
        ...(operation.gate !== undefined ? { gate: operation.gate } : {}),
      }
      const next = nextState(state, { finished }, context)
      return {
        ok: true,
        state: next,
        events: [{
          kind: 'finish',
          at: context.now,
          ...(operation.gate !== undefined ? { gate: operation.gate } : {}),
        }],
      }
    }

    case 'fail': {
      const forbidden = leaderOnly(context.actor, 'fail')
      if (forbidden !== undefined) return forbidden
      const reason = operation.reason !== undefined && operation.reason.trim() !== ''
        ? operation.reason.trim()
        : '任务板已失败收尾'
      const next = nextState(state, { finished: { report: reason, at: context.now } }, context)
      return {
        ok: true,
        state: next,
        events: [{ kind: 'fail', at: context.now, reason }],
      }
    }

    default: {
      // Exhaustive over the union; only reachable from untyped callers.
      const unknown: never = operation
      return refusal('invalid-operation', `未知操作：${String((unknown as { kind?: unknown }).kind)}`)
    }
  }
}

/**
 * Apply several operations as ONE transaction: all succeed, or none are applied.
 *
 * The caller holds the original state and saves only `result.state`, so a failure halfway
 * through cannot leave a partially-mutated board on disk. `expectedVersion` is checked against
 * the ORIGINAL state once (each operation inside the transaction then bumps the version).
 */
export function applyTaskBoardTransaction(
  state: RoomTaskState,
  operations: readonly TaskBoardOperation[],
  context: TaskBoardContext,
): TaskBoardTransactionResult {
  let current = state
  const events: TaskBoardEvent[] = []
  for (const [index, operation] of operations.entries()) {
    const operationContext: TaskBoardContext = index === 0
      ? context
      : {
          ...context,
          expectedVersion: undefined,
        }
    const result = applyTaskBoardOperation(current, operation, operationContext)
    if (!result.ok) {
      return refusal(result.code, `第 ${index + 1} 个操作失败：${result.reason}`)
    }
    current = result.state
    events.push(...result.events)
  }
  return { ok: true, state: current, events }
}
