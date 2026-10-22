/**
 * Tests for the approval–execution binding (OP-06).
 *
 * Layer 1 — the pure rules (`approval-binding.ts`): canonical argument hashing, binding creation
 * with an injectable clock, the tool/args/expiry check, and one-shot consumption.
 *
 * Layer 2 — the bridge wiring (`approval-bridge.ts`) against a fake host: a member tool call is
 * captured at `tools/pre-execute` (which must still pass `next()` through), the approval dialog
 * binds that capture, and the global `tools.guard()` refuses an execution whose arguments differ
 * from the approved ones while leaving every non-approved call untouched.
 *
 * Run with: node --test tests/approval-binding.test.ts  (Node v26 runs TypeScript directly)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  APPROVAL_BINDING_TTL_MS,
  canonicalArgsHash,
  canonicalArgsString,
  checkApprovalBinding,
  consumeApproval,
  createApprovalBinding,
  pruneExpiredApprovals,
} from '../packages/core/agent-community/src/approval-binding.ts'
import type { ApprovalBinding } from '../packages/core/agent-community/src/approval-binding.ts'
import { ApprovalBridge } from '../packages/core/agent-community/src/approval-bridge.ts'

const NOW = Date.parse('2026-10-22T00:00:00.000Z')

// ── canonical arguments ─────────────────────────────────────────────────────

test('object key order does not change the hash', () => {
  assert.equal(
    canonicalArgsHash({ a: 1, b: { c: [1, 2], d: 'x' } }),
    canonicalArgsHash({ b: { d: 'x', c: [1, 2] }, a: 1 }),
  )
})

test('array order DOES change the hash', () => {
  assert.notEqual(canonicalArgsHash([1, 2, 3]), canonicalArgsHash([3, 2, 1]))
  assert.equal(canonicalArgsHash([1, 2, 3]), canonicalArgsHash([1, 2, 3]))
})

test('undefined is distinct from absent, and from null', () => {
  assert.notEqual(canonicalArgsHash({ a: undefined }), canonicalArgsHash({}))
  assert.notEqual(canonicalArgsHash({ a: undefined }), canonicalArgsHash({ a: null }))
  assert.equal(canonicalArgsHash({ a: undefined }), canonicalArgsHash({ a: undefined }))
})

test('special values hash stably and distinctly', () => {
  const values = [undefined, null, NaN, Infinity, -Infinity, -0, 0, 10n, new Date(NOW), [undefined], new Map([['a', 1]]), new Set([1, 2])]
  const hashes = values.map(value => canonicalArgsHash(value))
  assert.equal(new Set(hashes).size, values.length, 'each special value must be distinguishable')
  for (const hash of hashes) assert.match(hash, /^[0-9a-f]{64}$/u)
})

test('a cyclic value is encoded, never thrown', () => {
  const cyclic: Record<string, unknown> = { a: 1 }
  cyclic['self'] = cyclic
  const hash = canonicalArgsHash(cyclic)
  assert.match(hash, /^[0-9a-f]{64}$/u)
  assert.match(canonicalArgsString(cyclic), /"cycle"/u)
})

// ── binding creation + check ────────────────────────────────────────────────

test('the binding carries the TTL from the injected clock', () => {
  const binding = createApprovalBinding(
    { callId: 'c1', toolName: 'bash', args: { cmd: 'ls' }, now: NOW },
    60_000,
  )
  assert.equal(binding.callId, 'c1')
  assert.equal(binding.toolName, 'bash')
  assert.equal(binding.issuedAt, NOW)
  assert.equal(binding.expiresAt, NOW + 60_000)
  assert.equal(binding.scope, 'once')
  assert.equal(binding.binding, 'verified-args')
  assert.equal(binding.argsHash, canonicalArgsHash({ cmd: 'ls' }))
  // Default TTL is the documented window.
  const def = createApprovalBinding({ callId: 'c2', toolName: 'bash', args: 1, now: NOW })
  assert.equal(def.expiresAt, NOW + APPROVAL_BINDING_TTL_MS)
})

test('no captured arguments produce the args-unavailable mode', () => {
  const binding = createApprovalBinding({ callId: 'c1', toolName: 'bash', now: NOW })
  assert.equal(binding.binding, 'args-unavailable')
  assert.equal(binding.argsHash, undefined)
})

test('checkApprovalBinding accepts the approved execution', () => {
  const binding = createApprovalBinding({ callId: 'c1', toolName: 'bash', args: { cmd: 'ls' }, now: NOW })
  assert.deepEqual(
    checkApprovalBinding(binding, { callId: 'c1', name: 'bash', args: { cmd: 'ls' } }, NOW + 1),
    { ok: true },
  )
})

test('checkApprovalBinding rejects tool / callId / args / expiry mismatches', () => {
  // A short window here so the expiry case can be reached without waiting 10 minutes.
  const binding = createApprovalBinding({ callId: 'c1', toolName: 'bash', args: { cmd: 'ls' }, now: NOW }, 60_000)

  const tool = checkApprovalBinding(binding, { callId: 'c1', name: 'write', args: { cmd: 'ls' } }, NOW)
  assert.equal(tool.ok, false)
  assert.match(tool.ok === false ? tool.reason : '', /工具不匹配/u)

  const call = checkApprovalBinding(binding, { callId: 'c2', name: 'bash', args: { cmd: 'ls' } }, NOW)
  assert.equal(call.ok, false)
  assert.match(call.ok === false ? call.reason : '', /callId/u)

  const args = checkApprovalBinding(binding, { callId: 'c1', name: 'bash', args: { cmd: 'rm -rf /' } }, NOW)
  assert.equal(args.ok, false)
  assert.match(args.ok === false ? args.reason : '', /参数/u)

  const expired = checkApprovalBinding(binding, { callId: 'c1', name: 'bash', args: { cmd: 'ls' } }, NOW + 60_001)
  assert.equal(expired.ok, false)
  assert.match(expired.ok === false ? expired.reason : '', /过期/u)
})

test('an args-unavailable binding checks identity and time but never arguments', () => {
  const binding = createApprovalBinding({ callId: 'c1', toolName: 'bash', now: NOW })
  assert.deepEqual(
    checkApprovalBinding(binding, { callId: 'c1', name: 'bash', args: { cmd: 'anything' } }, NOW + 1),
    { ok: true },
  )
  const expired = checkApprovalBinding(binding, { callId: 'c1', name: 'bash', args: 1 }, NOW + APPROVAL_BINDING_TTL_MS + 1)
  assert.equal(expired.ok, false)
})

// ── one-shot consumption ────────────────────────────────────────────────────

test('a matching grant is spent by the first execution', () => {
  const binding = createApprovalBinding({ callId: 'c1', toolName: 'bash', args: { cmd: 'ls' }, now: NOW })
  const tokens = new Map<string, ApprovalBinding>([['c1', binding]])
  assert.deepEqual(
    consumeApproval({ tokens, exec: { callId: 'c1', name: 'bash', args: { cmd: 'ls' } }, now: NOW + 1 }),
    { kind: 'allowed' },
  )
  assert.equal(tokens.size, 0, 'the token is one-shot')
  assert.deepEqual(
    consumeApproval({ tokens, exec: { callId: 'c1', name: 'bash', args: { cmd: 'ls' } }, now: NOW + 2 }),
    { kind: 'none' },
  )
})

test('a mismatched grant is spent too, so a retry needs a new decision', () => {
  const binding = createApprovalBinding({ callId: 'c1', toolName: 'bash', args: { cmd: 'ls' }, now: NOW })
  const tokens = new Map<string, ApprovalBinding>([['c1', binding]])
  const decision = consumeApproval({ tokens, exec: { callId: 'c1', name: 'bash', args: { cmd: 'rm' } }, now: NOW + 1 })
  assert.equal(decision.kind, 'denied')
  assert.equal(tokens.size, 0)
})

test('no token means "not an approval call": never denied', () => {
  assert.deepEqual(
    consumeApproval({ tokens: new Map(), exec: { callId: 'ordinary', name: 'read', args: {} }, now: NOW }),
    { kind: 'none' },
  )
  assert.deepEqual(
    consumeApproval({ tokens: new Map(), exec: { name: 'read', args: {} }, now: NOW }),
    { kind: 'none' },
  )
})

test('pruneExpiredApprovals drops only expired grants', () => {
  const fresh = createApprovalBinding({ callId: 'fresh', toolName: 'bash', args: 1, now: NOW })
  const stale = createApprovalBinding({ callId: 'stale', toolName: 'bash', args: 1, now: NOW - APPROVAL_BINDING_TTL_MS - 1 })
  const tokens = new Map<string, ApprovalBinding>([['fresh', fresh], ['stale', stale]])
  assert.equal(pruneExpiredApprovals(tokens, NOW), 1)
  assert.deepEqual([...tokens.keys()], ['fresh'])
})

// ── the bridge wiring, against a fake host ──────────────────────────────────

interface FakeLedgerEntry { readonly id: string; readonly [key: string]: unknown }

interface BridgeHarness {
  readonly bridge: ApprovalBridge
  readonly entries: FakeLedgerEntry[]
  readonly patches: Array<{ id: string; patch: Record<string, unknown> }>
  /** `tools/pre-execute` listener registered by the bridge. */
  preExecute(exec: unknown): unknown
  /** `approval/request` listener registered by the bridge. */
  request(req: unknown): Promise<unknown>
  /** The guard registered by the bridge, or undefined when the host has no tools service. */
  guard(exec: unknown): string | undefined
  stats(): { captured: number; bound: number; mismatch: number; approved: number }
}

/**
 * A fake Cordis host with exactly the seams the bridge consumes.
 *
 * `tools.get` is used because `optionalService` prefers `ctx.get(name)`; the guard is captured at
 * install time. `approval.on` is the waterfall registration the bridge already relied on.
 */
function makeHarness(options: { readonly withTools?: boolean | undefined } = {}): BridgeHarness {
  const entries: FakeLedgerEntry[] = []
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = []
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  let guardFn: ((exec: unknown) => string | undefined) | undefined
  let seq = 0
  const ledger = {
    push: (entry: Record<string, unknown>) => {
      const full = { id: `entry-${++seq}`, ...entry }
      entries.push(full)
      return full
    },
    patch: (id: string, _roomId: string, patch: Record<string, unknown>) => {
      patches.push({ id, patch })
    },
    botName: () => 'Bot One',
  }
  const tools = options.withTools === false
    ? undefined
    : {
        guard: (check: (exec: unknown) => string | undefined) => {
          guardFn = check
          return () => { guardFn = undefined }
        },
      }
  const fakeCtx = {
    get: (name: string) => (name === 'tools' ? tools : undefined),
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      listeners.set(event, handler)
      return () => { listeners.delete(event) }
    },
    approval: {
      on: (event: string, handler: (...args: unknown[]) => unknown) => {
        listeners.set(event, handler)
        return () => { listeners.delete(event) }
      },
    },
    logger: { info: () => undefined, warn: () => undefined },
  }
  const accessor = {
    memberRoomId: (sessionId: string) => (sessionId === 'member-session'
      ? { roomId: 'room-1' as never, botId: 'bot-1' as never }
      : undefined),
  }
  const bridge = new ApprovalBridge(fakeCtx as never, ledger as never, accessor)
  bridge.install()
  return {
    bridge,
    entries,
    patches,
    preExecute: (exec) => listeners.get('tools/pre-execute')?.(exec, () => 'CONTINUE'),
    request: (req) => {
      const handler = listeners.get('approval/request')
      assert.ok(handler !== undefined, 'the bridge registered an approval listener')
      return Promise.resolve(handler(req, () => Promise.resolve('UNAVAILABLE'))) as Promise<unknown>
    },
    guard: (exec) => {
      if (guardFn === undefined) return undefined
      return guardFn(exec)
    },
    stats: () => bridge.bindingStats(),
  }
}

const memberExec = (callId: string, args: unknown, name = 'bash') => ({
  callId,
  name,
  arguments: args,
  agent: { session: { id: 'member-session' } },
})

test('pre-execute capture keeps the waterfall decision (it must return next())', () => {
  const h = makeHarness()
  assert.equal(h.preExecute(memberExec('call-1', { cmd: 'ls' })), 'CONTINUE')
  assert.equal(h.stats().captured, 1)
})

test('a non-member call is not captured, and its approval is left to the native UI', async () => {
  const h = makeHarness()
  h.preExecute({ callId: 'call-x', name: 'bash', arguments: { cmd: 'ls' }, agent: { session: { id: 'user-session' } } })
  assert.equal(h.stats().captured, 0)
  const outcome = await h.request({ agent: { session: { id: 'user-session' } }, toolName: 'bash', callId: 'call-x' })
  assert.equal(outcome, 'UNAVAILABLE')
})

test('the approval row records the captured args fingerprint', async () => {
  const h = makeHarness()
  const args = { cmd: 'ls', cwd: '/tmp' }
  h.preExecute(memberExec('call-1', args))
  void h.request({ agent: { session: { id: 'member-session' } }, toolName: 'bash', callId: 'call-1' })
  h.bridge.resolveApproval('call-1', 'allowed-once')
  const entry = h.entries.at(0)
  assert.ok(entry !== undefined)
  assert.equal(entry['binding'], 'verified-args')
  assert.equal(entry['argsHash'], canonicalArgsHash(args))
  assert.equal(entry['callId'], 'call-1')
  assert.ok(Date.parse(String(entry['expiresAt'])) > Date.now() - 1)
})

test('the guard lets the approved execution through, once', async () => {
  const h = makeHarness()
  const args = { cmd: 'ls' }
  h.preExecute(memberExec('call-1', args))
  const outcome = h.request({ agent: { session: { id: 'member-session' } }, toolName: 'bash', callId: 'call-1' })
  h.bridge.resolveApproval('call-1', 'allowed-once')
  assert.equal(await outcome, 'allowed-once')

  assert.equal(h.guard({ callId: 'call-1', name: 'bash', arguments: args }), undefined)
  assert.equal(h.stats().bound, 1)
  assert.equal(h.stats().approved, 0, 'the grant is spent')
  // A second execution cannot ride the same Allow.
  assert.equal(h.guard({ callId: 'call-1', name: 'bash', arguments: args }), undefined)
  assert.equal(h.stats().bound, 1)
})

test('the guard refuses an execution whose arguments differ from the approved ones', async () => {
  const h = makeHarness()
  h.preExecute(memberExec('call-2', { cmd: 'ls' }))
  const outcome = h.request({ agent: { session: { id: 'member-session' } }, toolName: 'bash', callId: 'call-2' })
  h.bridge.resolveApproval('call-2', 'allowed-once')
  await outcome

  const denial = h.guard({ callId: 'call-2', name: 'bash', arguments: { cmd: 'rm -rf /' } })
  assert.ok(denial !== undefined)
  assert.match(denial, /审批绑定校验失败/u)
  assert.match(denial, /参数/u)
  assert.equal(h.stats().mismatch, 1)
  // The mismatched token was consumed: a later call is ordinary traffic again.
  assert.equal(h.guard({ callId: 'call-2', name: 'bash', arguments: { cmd: 'rm -rf /' } }), undefined)
})

test('a rejection leaves nothing executable behind', async () => {
  const h = makeHarness()
  h.preExecute(memberExec('call-3', { cmd: 'ls' }))
  const outcome = h.request({ agent: { session: { id: 'member-session' } }, toolName: 'bash', callId: 'call-3' })
  h.bridge.resolveApproval('call-3', 'rejected')
  assert.equal(await outcome, 'rejected')
  assert.equal(h.stats().approved, 0)
  assert.equal(h.guard({ callId: 'call-3', name: 'bash', arguments: { cmd: 'ls' } }), undefined)
  assert.equal(h.stats().bound, 0)
})

test('no capture at all → args-unavailable, and the approved call is not falsely denied', async () => {
  const h = makeHarness()
  // No pre-execute before the dialog (host variation): the binding cannot verify arguments.
  const outcome = h.request({ agent: { session: { id: 'member-session' } }, toolName: 'write', callId: 'call-4' })
  h.bridge.resolveApproval('call-4', 'allowed-once')
  await outcome
  const entry = h.entries.at(0)
  assert.equal(entry?.['binding'], 'args-unavailable')
  assert.equal(entry?.['argsHash'], undefined)
  assert.equal(h.guard({ callId: 'call-4', name: 'write', arguments: { anything: true } }), undefined)
  assert.equal(h.stats().bound, 1)
})

test('without tools.guard the bridge still records approvals (degraded, no post-check)', async () => {
  const h = makeHarness({ withTools: false })
  h.preExecute(memberExec('call-5', { cmd: 'ls' }))
  const outcome = h.request({ agent: { session: { id: 'member-session' } }, toolName: 'bash', callId: 'call-5' })
  h.bridge.resolveApproval('call-5', 'allowed-once')
  assert.equal(await outcome, 'allowed-once')
  assert.equal(h.guard({ callId: 'call-5', name: 'bash', arguments: { cmd: 'ls' } }), undefined)
  assert.equal(h.entries.length, 1)
})

test('ordinary calls with no grant are never touched by the guard', () => {
  const h = makeHarness()
  assert.equal(h.guard({ callId: 'never-approved', name: 'read', arguments: { path: '/etc/passwd' } }), undefined)
  assert.equal(h.guard({ name: 'read', arguments: {} }), undefined)
  assert.equal(h.guard(null), undefined)
})
