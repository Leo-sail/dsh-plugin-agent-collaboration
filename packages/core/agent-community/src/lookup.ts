/**
 * Pure lookups over persisted state.
 *
 * Every call site used to hand-roll `state.bots.find(...)` plus its own
 * `if (x === undefined) throw new Error(...)`, which is how one "not found" message
 * drifted into a dozen slightly different copies. These helpers take the state slice
 * rather than the service, so they stay pure — no `this`, no `Context`, no I/O — and
 * can be used from any module.
 *
 * Message text is preserved verbatim from the original call sites: the helper builds the
 * message from the id it was given, so a caller that used to interpolate `input.roomId`
 * passes that same expression and gets byte-identical text.
 *
 * @module
 */
import type { BotIdentity, BotRoom, BotRun } from './types.ts'

/**
 * A lookup by id (or name) found nothing.
 *
 * `name` is deliberately not overridden: these sites threw a plain `Error` before, and
 * `Error.prototype.name` is what any consumer reading `error.name` still sees. Only the
 * class identity is new.
 */
export class NotFoundError extends Error {}

/** The bot with this id, or a `NotFoundError`. */
export function requireBot(state: { readonly bots: readonly BotIdentity[] }, id: string): BotIdentity {
  const bot = state.bots.find(b => b.id === id)
  if (bot === undefined) throw new NotFoundError(`Bot "${id}" not found`)
  return bot
}

/** The room with this id, or a `NotFoundError`. */
export function requireRoom(state: { readonly rooms: readonly BotRoom[] }, id: string): BotRoom {
  const room = state.rooms.find(r => r.id === id)
  if (room === undefined) throw new NotFoundError(`Room "${id}" not found`)
  return room
}

/** The run with this id, or a `NotFoundError`. */

/**
 * The first bot with this display name, or `undefined`.
 *
 * A find, not a require: callers either report their own message or treat a missing
 * name as "no such assignee" rather than an error. Display names are not unique, so the
 * first match wins — the same rule the hand-rolled `find` used.
 */
export function findBotByName(
  state: { readonly bots: readonly BotIdentity[] },
  name: string,
): BotIdentity | undefined {
  return state.bots.find(b => b.name === name)
}
