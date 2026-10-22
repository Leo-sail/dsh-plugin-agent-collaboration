/**
 * Approval–execution binding helpers (OP-06).
 *
 * THE PROBLEM. The host's approval request (`approval/request`) carries `agent`, `toolName`,
 * `callId` and `reason` — and NO arguments. The tool's arguments only exist on the
 * `tools/pre-execute` execution (`exec.arguments`), which runs BEFORE the approval. A user who
 * approves "run bash" is therefore approving a tool identity, not the concrete command they were
 * shown; if anything between the approval and the execution could change what runs, the approval
 * would no longer describe the execution.
 *
 * The host pipeline is, in order:
 *
 *   tools/pre-execute ──▶ (ask?) approval/request ──▶ ctx.tools.guard() ──▶ execute
 *
 * so the plugin can capture the frozen arguments in `tools/pre-execute` (keyed by `callId`), bind
 * them to the user's `allowed-once`, and — in a synchronous `tools.guard()` that runs after the
 * approval — refuse to execute if the tool, its arguments, or the binding window no longer match.
 * That is the strongest form available at plugin level without host changes.
 *
 * Everything here is pure and clock-injectable so the rules are testable without a host. The
 * one-shot consumption lives in {@link consumeApproval}: the token is deleted on EVERY outcome,
 * so an approval can never authorise two executions, and a mismatch consumes the token too
 * (a retry needs a new user decision).
 *
 * @module
 */

import { createHash } from 'node:crypto'

/** How long an approval stays executable after the user clicked Allow once. */
export const APPROVAL_BINDING_TTL_MS = 10 * 60_000

/** Whether the binding could be verified against captured arguments or only against identity/time. */
export type ApprovalBindingMode = 'verified-args' | 'args-unavailable'

/**
 * One user grant, bound to the tool call it was given for.
 *
 * `argsHash` is absent exactly when the host did not offer the arguments at approval time
 * (`args-unavailable`): the guard then checks tool name and expiry, never arguments — refusing
 * such a call outright would break every approval on a host that does not expose them.
 */
export interface ApprovalBinding {
  readonly callId: string
  readonly toolName: string
  /** sha256 of {@link canonicalArgsHash} output, when the arguments could be captured. */
  readonly argsHash?: string | undefined
  /** What the binding can be verified against. */
  readonly binding: ApprovalBindingMode
  readonly issuedAt: number
  /** Epoch ms after which the grant must not execute anything. */
  readonly expiresAt: number
  /** Grants are one-shot by construction. */
  readonly scope: 'once'
}

/** The executable side the guard sees: the same shape `tools/pre-execute` receives. */
export interface ApprovalExecView {
  readonly name?: string | undefined
  readonly callId?: string | undefined
  readonly args?: unknown
}

export type ApprovalCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/**
 * Canonical JSON for arbitrary argument values, then its sha256.
 *
 * Key order must not matter (`{a,b}` and `{b,a}` are the same call) while array order must
 * (`[a,b]` and `[b,a]` are different calls). `undefined`, non-finite numbers and other values JSON
 * cannot represent are encoded as explicit tags instead of being dropped, so
 * `{a:undefined}` never collides with `{}`.
 */
export function canonicalArgsString(args: unknown, seen: WeakSet<object> = new WeakSet()): string {
  switch (typeof args) {
    case 'undefined': return '{"$":"undefined"}'
    case 'string': return JSON.stringify(args)
    case 'boolean': return args ? 'true' : 'false'
    case 'number':
      if (Number.isNaN(args)) return '{"$":"nan"}'
      if (args === Infinity) return '{"$":"infinity"}'
      if (args === -Infinity) return '{"$":"-infinity"}'
      if (Object.is(args, -0)) return '{"$":"-0"}'
      return JSON.stringify(args)
    case 'bigint': return `{"$":"bigint","v":${JSON.stringify(args.toString())}}`
    case 'symbol': return `{"$":"symbol","v":${JSON.stringify(String(args.description ?? ''))}}`
    case 'function': return '{"$":"function"}'
    case 'object': return canonicalArgsObject(args, seen)
    default: return '{"$":"unknown"}'
  }
}

function canonicalArgsObject(value: object | null, seen: WeakSet<object>): string {
  if (value === null) return 'null'
  if (seen.has(value)) return '{"$":"cycle"}'
  seen.add(value)
  try {
    if (value instanceof Date) {
      return `{"$":"date","v":${JSON.stringify(Number.isNaN(value.getTime()) ? 'invalid' : value.toISOString())}}`
    }
    if (value instanceof RegExp) {
      return `{"$":"regexp","v":${JSON.stringify(value.source)},"flags":${JSON.stringify(value.flags)}}`
    }
    if (Array.isArray(value)) {
      const items: string[] = []
      for (let i = 0; i < value.length; i += 1) {
        items.push(i in value ? canonicalArgsString(value[i], seen) : '{"$":"hole"}')
      }
      return `[${items.join(',')}]`
    }
    if (value instanceof Map) {
      // A map's own order must not matter for a call's identity; entries are canonicalised and
      // sorted by their encoded key/value pair.
      const entries = [...value.entries()]
        .map(([key, item]) => `[${canonicalArgsString(key, seen)},${canonicalArgsString(item, seen)}]`)
        .sort()
      return `{"$":"map","v":[${entries.join(',')}]}`
    }
    if (value instanceof Set) {
      const items = [...value.values()].map(item => canonicalArgsString(item, seen)).sort()
      return `{"$":"set","v":[${items.join(',')}]}`
    }
    if (ArrayBuffer.isView(value)) {
      const items = Array.from(value as unknown as ArrayLike<number>, item => canonicalArgsString(item, seen))
      return `{"$":"view","ctor":${JSON.stringify(value.constructor.name)},"v":[${items.join(',')}]}`
    }
    const keys = Object.keys(value).sort()
    const prototype = Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null
    const ctor = prototype?.constructor?.name
    const fields = keys.map((key) => {
      const item = (value as Record<string, unknown>)[key]
      return `${JSON.stringify(key)}:${canonicalArgsString(item, seen)}`
    })
    const ctorTag = ctor !== undefined && ctor !== 'Object' ? `"$ctor":${JSON.stringify(ctor)},` : ''
    return `{${ctorTag}${fields.join(',')}}`
  } finally {
    // Only the CURRENT path is a cycle; the same object appearing twice in a tree must encode
    // identically both times, so it leaves the path when its own encoding is done.
    seen.delete(value)
  }
}

/** Stable sha256 (hex) of the canonical argument encoding. */
export function canonicalArgsHash(args: unknown): string {
  return createHash('sha256').update(canonicalArgsString(args), 'utf8').digest('hex')
}

export interface CreateApprovalBindingInput {
  readonly callId: string
  readonly toolName: string
  /** The captured arguments, when `tools/pre-execute` offered them. */
  readonly args?: unknown
  /** A hash already computed at capture time — avoids hashing the same args twice. */
  readonly argsHash?: string | undefined
  /** Injected clock (epoch ms). */
  readonly now?: number | undefined
}

/**
 * Build the binding a user's Allow is recorded against.
 *
 * `argsHash` wins over `args` so the capture path can hash once; passing neither (or explicitly
 * `argsHash: undefined` with no args) produces the `args-unavailable` mode, which the guard keeps
 * usable for tool/expiry checks instead of rejecting a call it cannot verify.
 */
export function createApprovalBinding(
  input: CreateApprovalBindingInput,
  ttlMs: number = APPROVAL_BINDING_TTL_MS,
): ApprovalBinding {
  const issuedAt = input.now ?? Date.now()
  const hash = input.argsHash
    ?? (input.args === undefined ? undefined : canonicalArgsHash(input.args))
  return {
    callId: input.callId,
    toolName: input.toolName,
    ...(hash !== undefined ? { argsHash: hash } : {}),
    binding: hash !== undefined ? 'verified-args' : 'args-unavailable',
    issuedAt,
    expiresAt: issuedAt + Math.max(0, ttlMs),
    scope: 'once',
  }
}

/**
 * Check one execution against a binding. Does NOT consume anything — consumption is the guard's
 * job (see {@link consumeApproval}), so a caller can decide policy without spending the grant.
 */
export function checkApprovalBinding(
  binding: ApprovalBinding,
  exec: ApprovalExecView,
  now: number = Date.now(),
): ApprovalCheck {
  if (exec.callId === undefined || exec.callId !== binding.callId) {
    return { ok: false, reason: `调用的 callId 与审批绑定的不一致（审批 ${binding.callId}，执行 ${exec.callId ?? '未知'}）` }
  }
  if (exec.name === undefined || exec.name !== binding.toolName) {
    return { ok: false, reason: `工具不匹配（审批绑定 ${binding.toolName}，执行 ${exec.name ?? '未知'}）` }
  }
  if (now > binding.expiresAt) {
    return { ok: false, reason: '审批绑定已过期，需重新确认' }
  }
  if (binding.binding === 'verified-args' && binding.argsHash !== undefined) {
    let actual: string
    try {
      actual = canonicalArgsHash(exec.args)
    } catch (error: unknown) {
      return { ok: false, reason: `无法计算本次执行的参数指纹（${String(error)}）` }
    }
    if (actual !== binding.argsHash) {
      return { ok: false, reason: '参数与审批时不一致' }
    }
  }
  return { ok: true }
}

export type ApprovalDecision =
  /** No grant was given for this execution — not an approval-gated call. */
  | { readonly kind: 'none' }
  /** The grant matched and has been spent: execute. */
  | { readonly kind: 'allowed' }
  /** A grant existed but did not match; it has been spent, the call must be refused. */
  | { readonly kind: 'denied'; readonly reason: string }

/**
 * One-shot consumption of an approval token for this execution.
 *
 * The token is deleted whenever it is FOUND — allowed or denied — so:
 *   · one Allow can never authorise two executions (the second call sees `none` and is a normal,
 *     non-approved call again);
 *   · a mismatch can never leave a token behind for a corrected retry (the user decides again).
 *
 * A call with no token is `none`, which callers map to "do not intervene": the guard must never
 * deny an execution merely because it was not approval-gated.
 */
export function consumeApproval(input: {
  readonly tokens: Map<string, ApprovalBinding>
  readonly exec: ApprovalExecView
  readonly now?: number | undefined
}): ApprovalDecision {
  const callId = input.exec.callId
  if (callId === undefined) return { kind: 'none' }
  const binding = input.tokens.get(callId)
  if (binding === undefined) return { kind: 'none' }
  input.tokens.delete(callId)
  const checked = checkApprovalBinding(binding, input.exec, input.now ?? Date.now())
  return checked.ok ? { kind: 'allowed' } : { kind: 'denied', reason: checked.reason }
}

/** Drop tokens whose window has passed; returns how many were removed. */
export function pruneExpiredApprovals(tokens: Map<string, ApprovalBinding>, now: number = Date.now()): number {
  let removed = 0
  for (const [callId, binding] of tokens) {
    if (now <= binding.expiresAt) continue
    tokens.delete(callId)
    removed += 1
  }
  return removed
}
