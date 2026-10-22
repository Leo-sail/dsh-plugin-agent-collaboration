/**
 * S5-A: a stop must reach the turn BEFORE the model is asked to run.
 *
 * The full abort path (cancel a live agent mid-request) needs the host's Agent, which the
 * repository cannot construct in a unit test. What IS testable without a host is the rule the
 * executor relies on: a signal that is already aborted makes `run()` return a `stopped`
 * outcome — no followup, no repair round, no "model produced no answer" failure — and it does
 * so before any agent/accessor method is called. That is the boundary between "user pressed
 * stop" (interrupted, no retry) and "the turn failed" (failed, retried).
 *
 * Run with: node --test tests/session-runner-abort.test.ts  (Node v26 runs TypeScript directly)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SessionRunner } from '../packages/core/agent-community/src/session-runner.ts'

/**
 * A hostile accessor: every method throws, so any call before the abort check fails the test
 * loudly instead of being masked by a stub returning an empty value.
 */
function forbiddenAccessor(): never {
  return new Proxy({}, {
    get(_target, property) {
      throw new Error(`accessor.${String(property)} must not be called for an aborted run`)
    },
  }) as never
}

test('an already-aborted signal returns a stopped outcome before any agent work', async () => {
  const runner = new SessionRunner({} as never, forbiddenAccessor(), {})
  const controller = new AbortController()
  controller.abort(new Error('user pressed stop'))
  const outcome = await runner.run('room-1', 'bot-1', 'do the thing', undefined, true, controller.signal)
  assert.equal(outcome.stopped, true)
  assert.equal(outcome.stopReason, 'aborted')
  assert.equal(outcome.text, '')
  assert.equal(outcome.textChannelFailed, false)
  assert.equal(outcome.repairs, 0)
})

test('a live signal is accepted as the 6th argument and the run still needs an agent', async () => {
  // Not aborted: the run proceeds to the agent path, which the hostile accessor refuses.
  // What this pins is the SIGNATURE (backwards compatible) and that the abort listener is
  // cleaned up after the failure — a leaked listener would throw on the proxy later.
  const runner = new SessionRunner({} as never, forbiddenAccessor(), {})
  const controller = new AbortController()
  await assert.rejects(
    () => runner.run('room-2', 'bot-2', 'hello', undefined, true, controller.signal),
    /must not be called|ensureSlot/u,
  )
  // Firing the (removed) listener must not reach the accessor/agent.
  controller.abort(new Error('late stop'))
})
