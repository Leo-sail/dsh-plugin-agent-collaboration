import { useLatchedStreaming, useProcessDisclosure } from './disclosure.ts'
import { ReasoningBlock } from './reasoning.tsx'
import type { TurnGroup } from './turns.ts'
import {
  ResponseItem, RunningItem, TailItem, TurnFlow, ProcessItem,
  type SettledReason, type TurnFlowItem } from './turnFlow.tsx'
import { processKindOf } from './processSteps.tsx'
import { avatarStyle, nameLabel, botEmoji, mutedText } from './styles.ts'
import { DeliverableGroup } from './DeliverableCard.tsx'
import { ThreadBadge, ThreadQuote } from './ThreadQuote.tsx'
import type { ThreadQuoteData } from './threadView.ts'
import type { CommunityRemote } from '../community/types.ts'
import type { DeliveredFile } from './types.ts'

// The user row lives next to the turn modules; re-exported so `TranscriptArea`
// keeps its single import site.
export { UserMessage } from './userMessage.tsx'

// ── BotTurn ───────────────────────────────────────────────────────────────────

export function BotTurn({ group, bots, onFork, live = false, runDurationMs, runStartedAtMs, stopped = false, remote, replyQuote, onReply }: {
  group: TurnGroup
  /**
   * Duration computed from the host's run record (finishedAt - startedAt).
   *
   * This is the authoritative source and does not depend on the ledger at all: it
   * arrives with the same snapshot that reports the run as finished, so it needs no
   * settle event, no poll window, and no cursor. The ledger copy remains a fallback.
   */
  runDurationMs?: number | undefined
  /**
   * Epoch ms this turn's run started, from the host's run record (`startedAt`,
   * stamped when the run leaves the queue).
   *
   * The deep-diving timer MUST key off this rather than the ledger: while the model
   * thinks, the turn has no entry at all, so `entries[0]` is undefined and the timer
   * simply did not render — the whale swam for a minute with no 用时 on screen. The
   * ledger's first `at` remains the fallback when the run record is missing.
   */
  runStartedAtMs?: number | undefined
  /** The run was interrupted by the user — native labels that 已停止 and hides the duration. */
  stopped?: boolean | undefined
  /**
   * The host reports this turn's run as running/queued. This — not the text
   * streaming flag — is what makes a turn live: during the tool phase there is
   * no text yet, so the whale and its timer must key off the run itself.
   */
  live?: boolean | undefined
  /** Room members, so the turn renders the bot's own avatar seed. */
  bots?: ReadonlyArray<{ id: string; name: string; avatarSeed?: string | undefined }> | undefined
  /** Fork FROM a message: receives that message's id. */
  onFork?: ((messageId: string) => void) | undefined
  /** Host RPCs for the deliverable cards (preview, OS open/reveal). */
  remote?: CommunityRemote | undefined
  /** OP-14: the message this turn's answer replies to, resolved to a display snippet. */
  replyQuote?: ThreadQuoteData | undefined
  /** OP-14: reply to this turn's answer (sets the composer's reply target). */
  onReply?: (() => void) | undefined
}) {
  // ── DELIVERED FILES ────────────────────────────────────────────────────────
  //
  // The deliver tool's own call/result rows are replaced by the card group below:
  // keeping them in the process section would show the same delivery twice (one raw
  // "工具执行" row plus the file cards). The tool name is the only thing filtered —
  // every other tool still renders its normal step.
  const deliverCallIds = new Set(
    group.entries
      .filter(e => e.type === 'tool-call' && e.name === 'agent_community_deliver')
      .map(e => e.callId),
  )
  const toolCalls = group.entries.filter(e => e.type === 'tool-call' && e.name !== 'agent_community_deliver')
  const toolResults = group.entries.filter(
    e => e.type === 'tool-result' && (e.callId === undefined || !deliverCallIds.has(e.callId)),
  )
  const deliverables: DeliveredFile[] = group.entries
    .filter(e => e.type === 'deliverable')
    .flatMap(e => e.files ?? [])
  const deliverableEntry = group.entries.find(e => e.type === 'deliverable')
  const approvals = group.entries.filter(e => e.type === 'approval')
  const questions = group.entries.filter(e => e.type === 'question')
  const textEntries = group.entries.filter(e => e.type === 'bot-text')
  const textEntry = textEntries[0]

  // One shared thinking section per turn. A multi-round run emits one
  // bot-reasoning entry per round; concatenating them keeps the turn to the
  // native shape — avatar / name, thinking, work steps, answer — instead of a
  // stack of "已思考 N 字" headers that each look like their own block.
  const reasoningText = group.entries
    .filter(e => e.type === 'bot-reasoning')
    .map(e => e.text ?? '')
    .filter(t => t !== '')
    .join('\n\n')
  const hasReasoning = reasoningText !== ''

  // The turn is still live iff any of its bot-text entries is streaming. This
  // single value drives every auto-expand / auto-collapse decision below, the
  // deep-diving indicator, and the `data-actions-reveal` state of the tail.
  const rawStreaming = textEntries.some(e => e.streaming === true)
  const ledgerDurationMs = group.entries.find(e => e.type === 'bot-text' && e.durationMs !== undefined)?.durationMs
  const durationMs = ledgerDurationMs ?? runDurationMs
  // Native switch: aborted → 已停止, error → 处理失败, timed → 已完成，用时 …, else 已完成.
  //
  // The ledger only proves "failed" (an error entry) and "timed" (a duration). An
  // interrupted run also leaves no duration, so absence alone cannot distinguish a
  // stop from an unknown reason — defaulting to 已停止 printed "已停止" on every
  // turn whose duration had not been recorded yet. Stay neutral in that case.
  const failed = group.entries.some(e => e.type === 'error')
  // A turn carrying a duration is finished, full stop: the duration is written
  // exactly once, when the run closes.
  const provenSettled = durationMs !== undefined

  // SETTLED IS PROVEN BY THE DURATION, not by the `streaming` flag.
  //
  // Native has no mutable streaming flag at all: it reads
  // `turn?.status !== "closed"`, and a closed turn is final — it cannot reopen, so the
  // running indicator can never be left on screen by a stale boolean.
  //
  // Our `streaming` flag is mutable and did get stuck (a settle that no poll
  // observed left the whale and its live timer on screen indefinitely). The duration
  // is written exactly once, when the turn closes, so its presence IS the proof:
  // a turn carrying a duration is finished, full stop.
  // Latched: once the turn shows as settled it cannot flash back to live.
  // Live = the RUN is active, which covers the tool phase before any text exists.
  //
  // `live` comes from the authoritative run list. `rawStreaming` is the ledger's
  // copy of the same fact, and it can go stale: the panel once held a row flagged
  // `streaming: true` for a run that had already finished, so the whale and its
  // timer stayed on screen while the finished answer never appeared. A ledger flag
  // is therefore only trusted to KEEP a turn open — never to open one — once the run
  // list has confirmed the run is gone.
  const isLive = useLatchedStreaming(live || (rawStreaming && !provenSettled))
  const isStreaming = isLive

  const hasProcess = toolCalls.length > 0 || approvals.length > 0 || questions.length > 0
  const doneToolCount = toolResults.length

  // Live activity for the process-group title: the call that has not produced a
  // result yet is the one being worked on; otherwise the most recent call.
  // One index instead of a nested scan per call site: `toolCalls.find(tc => !toolResults.some(...))`
  // plus a `find` inside a `map` below was O(calls × results) on every render — ~1 600 comparisons
  // for a 40-tool turn, repeated on each ledger tick.
  const resultByCallId = new Map(toolResults.map(r => [r.callId, r] as const))
  const runningCall = toolCalls.find(tc => !resultByCallId.has(tc.callId))
  const activitySource = runningCall ?? toolCalls[toolCalls.length - 1]
  const liveActivity = activitySource === undefined ? undefined : processKindOf(activitySource.name ?? '')

  const [processOpen, toggleProcess] = useProcessDisclosure(isLive)

  // ── settled turn state (native reason switch) ──────────────────────────────
  //
  // Native computes `elapsedMs = Math.max(1000, end - start)` and hides the duration
  // for aborted/error turns, labelling them instead. The ledger only carries the
  // duration, so an absent value means the turn did not finish normally.

  // `stopped` is an explicit signal from the run record (`status: interrupted`),
  // because absence of a duration cannot tell a user stop from a turn that simply
  // has not been stamped yet — see the note above.
  const settledReason: SettledReason =
    failed ? 'error' : stopped ? 'aborted' : durationMs !== undefined ? 'timed' : 'other'

  // A turn with nothing to show is omitted entirely. This happens when a bot
  // chose not to speak, or when a run failed before producing text — rendering an
  // empty bubble there only adds noise to the room.
  const hasText = (textEntry?.text ?? '').trim() !== ''
  // A turn whose only output was delivered files still has something to show: without
  // this arm the whole row vanished, taking the cards with it.
  if (!hasText && !isLive && !hasReasoning && !hasProcess && deliverables.length === 0) return null

  // Native `TurnTailNodeView` (§2.2): the action row only exists once the turn
  // has a closing event — i.e. **not** while it still streams (`closing === null`
  // → tail slot only) — and its reveal mode is `always` when the turn ends with a
  // visible response, `hover` otherwise.
  const endsWithResponse = !isLive && hasText
  const showTail = !isLive && (hasText || hasReasoning || hasProcess)

  // Deep-diving timer origin (§2.16: the mount condition is the live run, so the
  // origin must be that run's start).
  //
  // The host's run record wins: it is stamped the moment the run leaves the queue, so
  // the timer exists from the turn's FIRST render — including the thinking phase,
  // where the group has no entries at all and the ledger cannot say when it began.
  // The ledger's first `at` stays as the fallback for a turn whose run record is gone
  // (history restored from persisted messages, a run list that has not polled yet).
  const ledgerStartedAt = group.entries[0] !== undefined ? Date.parse(group.entries[0].at) : Number.NaN
  const startedAt = runStartedAtMs !== undefined && Number.isFinite(runStartedAtMs)
    ? runStartedAtMs
    : ledgerStartedAt

  // ── flow items, each with the native gap that precedes it ──────────────────
  const items: TurnFlowItem[] = []

  if (hasReasoning) {
    items.push({
      kind: 'reasoning',
      node: <ReasoningBlock text={reasoningText} isStreaming={isStreaming} />,
    })
  }

  // A stopped turn must still report itself. `hasProcess` is false for a turn that
  // only ever produced text, and a stop stamps no duration, so without the `stopped`
  // arm the row vanished and the reader got no signal that the turn was cut short.
  if (hasProcess || durationMs !== undefined || stopped) {
    items.push({
      kind: 'process',
      node: (
        <ProcessItem
          toolCalls={toolCalls}
          resultByCallId={resultByCallId}
          doneToolCount={doneToolCount}
          approvals={approvals}
          questions={questions}
          hasProcess={hasProcess}
          isLive={isLive}
          settledReason={settledReason}
          durationMs={durationMs}
          open={processOpen}
          onToggle={toggleProcess}
          liveActivity={liveActivity}
        />
      ),
    })
  }

  // Main text — skipped entirely when there is nothing to show yet: during the
  // tool phase the run is live but no answer exists, and an empty block here
  // pushed the whale down and printed a placeholder the native transcript never
  // shows.
  if (textEntry !== undefined && (hasText || !isLive)) {
    items.push({
      kind: 'response',
      node: <ResponseItem text={textEntry.text ?? ''} hasText={hasText} isLive={isLive} />,
    })
  }

  // ── THE ANSWER ROW THAT IS NOT HERE ────────────────────────────────────────
  //
  // A run reserves its `bot-text` row when it STARTS, so a tool-heavy turn keeps the
  // answer row before the rows the panel's newest page holds — 「回复被隐藏，点加载
  // 更早才出现」. The panel now walks backwards itself when that happens; if the row
  // is still absent, the reply is beyond the history this client was willing to read
  // (or the page walk failed). A settled turn showing work steps and no reply reads
  // as "the bot said nothing", so say what happened and name the one action that can
  // still find it. A live turn keeps the "processing" affordance instead.
  if (textEntry === undefined && !isLive && (hasProcess || hasReasoning)) {
    items.push({
      kind: 'response',
      node: (
        <div>
          <span style={mutedText}>
            （该回合的回复不在已加载的历史中：可点上方「加载更早」继续查找）
          </span>
        </div>
      ),
    })
  }

  // Delivery cards sit between the reply and the action tail — the same place DSH puts
  // them, so the reading order is answer → files → actions.
  if (deliverables.length > 0) {
    items.push({
      kind: 'deliverable',
      node: (
        <DeliverableGroup
          files={deliverables}
          roomId={group.entries[0]?.roomId ?? ''}
          runId={group.runId ?? deliverableEntry?.runId ?? ''}
          remote={remote}
        />
      ),
    })
  }

  if (showTail && textEntry !== undefined) {
    items.push({
      kind: 'tail',
      node: (
        <TailItem
          text={textEntry.text ?? ''}
          at={textEntry.at}
          usage={textEntry.usage}
          messageId={textEntry.id}
          onFork={onFork}
          branchUnavailable={!endsWithResponse}
          {...(onReply !== undefined ? { onReply } : {})}
        />
      ),
    })
  }

  // Native `RunningStatus` (§2.16): the deep-diving row is the turn's last flow
  // item and replaces the old "思考中…" label while the run is live.
  if (isLive) {
    items.push({ kind: 'running', node: <RunningItem startedAt={startedAt} /> })
  }

  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <div style={avatarStyle}>
        {/* `avatar.seed` IS the avatar glyph (the native field stores the emoji
            character, e.g. "🤖"), so it must be rendered as-is. Hashing it through
            botEmoji produced a DIFFERENT emoji than the bot list showed, which is
            why group members appeared under someone else's avatar. */}
        {bots?.find(b => b.id === group.botId)?.avatarSeed ?? botEmoji(group.botId)}
      </div>
      <div
        style={{ minWidth: 0, flex: 1 }}
        data-actions-reveal={endsWithResponse ? 'always' : 'hover'}
      >
        {/* OP-14: what this answer replies to. One quote strip, above the name row — the
            transcript stays chronological and the thread is a fact about the turn, not a
            second conversation column. */}
        {replyQuote !== undefined && (
          <div style={{ marginBottom: 6 }}>
            <ThreadQuote data={replyQuote} />
          </div>
        )}
        {/* Header — one avatar plus one name row. Native assistant chrome carries
            no clock here (the clock lives in the action tail, §2.1) and no separate
            streaming dot: liveness is the deep-diving line's job (§2.16). */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={nameLabel}>{group.botName}</span>
          {textEntry?.threadId !== undefined && <ThreadBadge threadId={textEntry.threadId} />}
        </div>

        <TurnFlow items={items} />
      </div>
    </div>
  )
}
