/**
 * Turn grouping — folding a room's ledger rows into one entry per user/bot turn.
 *
 * Pure: the grouping is decided by user rows and run ids, with no React and no DOM involved, which is
 * exactly why it lives outside the transcript renderer.
 *
 * @module
 */
import type { LedgerEntry } from './types.ts'

export interface TurnGroup {
  runId: string | undefined
  botId: string
  botName: string
  entries: LedgerEntry[]
}

/**
 * Fold the flat ledger into render rows.
 *
 * A turn is the unit that renders as *one* message — one avatar, one name row.
 * Everything a single run emits (reasoning, tool cards, the streamed answer) has
 * to land in the same group, otherwise "思考过程" and "工具调用" show up as
 * separate bot messages instead of collapsible sections inside the reply.
 */

export function groupIntoTurns(entries: LedgerEntry[]): Array<LedgerEntry | TurnGroup> {
  const result: Array<LedgerEntry | TurnGroup> = []
  // runId (`${botId}\0${runId}`) → the turn already emitted for that run.
  const turnsByRun = new Map<string, TurnGroup>()
  let currentTurn: TurnGroup | undefined

  for (const e of entries) {
    if (e.type === 'user' || e.type === 'dispatch' || e.type === 'error') {
      // A standalone row ends the adjacency run: the next entry starts a fresh
      // turn unless it belongs to a run that already owns one (see below).
      currentTurn = undefined
      result.push(e)
      continue
    }

    const runId = e.runId
    const botId = e.botId ?? ''
    const botName = e.botName ?? botId
    // An entry is only mergeable across an interruption when it carries a real
    // turn identity; legacy/seed entries without one stay adjacency-grouped.
    const mergeable = runId !== undefined && runId !== ''
    const key = `${botId}\u0000${runId ?? ''}`

    let turn: TurnGroup | undefined
    if (mergeable) {
      // Same run seen again → reuse its turn even if unrelated rows (a dispatch
      // line, another bot in a group room, an error) were interleaved. Creating a
      // second group here is what made reasoning / tool calls render as their own
      // bot messages with their own avatar.
      turn = turnsByRun.get(key)
    } else if (
      currentTurn !== undefined
      && currentTurn.runId === runId
      && currentTurn.botId === botId
    ) {
      turn = currentTurn
    }

    if (turn === undefined) {
      turn = { runId, botId, botName, entries: [] }
      result.push(turn)
      if (mergeable) turnsByRun.set(key, turn)
    }
    currentTurn = turn
    turn.entries.push(e)
  }

  // Every turn was emitted into `result` the moment it was created, so a resumed
  // turn is never duplicated and there is nothing left to flush here.
  // Entries of one run are appended in arrival order; a stable sort by sequence
  // keeps a resumed turn chronological even if the page arrived out of order.
  for (const row of result) {
    if ('entries' in row) row.entries.sort((a, b) => a.sequence - b.sequence)
  }
  return result
}

/**
 * The turn's flow items, laid out in the native vertical order (§1.2):
 *
 * ```
 * [reasoning] → [turn-process] → [response] → [turn-tail] → [running]
 * ```
 *
 * Each item `margin-top` equals the native `--dsh-chat-flow-gap` of the item
 * before it (6 / 12 after a response / 16 after the process block).
 */
