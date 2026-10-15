/**
 * Tool-mask regression suite — 「为什么 Bot 还能看到被禁用的工具」.
 *
 * DSH's `tools.restrict()` validates the WHOLE filter before applying it: one unknown name
 * throws and NOTHING is restricted. The plugin used to call it once inside a bare
 * `catch {}`, which is how a real bot session ended up with `ask_user_question` and `skill`
 * in its catalog while both sat in `botDeniedTools` — the whole mask was discarded because
 * of one name the scope did not know (the plugin registers its own tool of that name later).
 *
 * This suite drives the REAL `restrictGlobalTools` against a fake registry that mimics those
 * rules: unknown names throw, scope-local names throw, and restrictions append.
 *
 * Usage: node tests/tool-mask.mjs
 */
import { restrictGlobalTools, DEFAULT_DENIED_TOOLS }
  from '../packages/core/agent-community/src/session-runner.ts'

let pass = 0
let total = 0
const check = (ok, label, detail = '') => {
  total += 1
  if (ok) pass += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

/** A registry with DSH's documented rules. `denied` accumulates: restrictions intersect. */
function makeRegistry({ global, scopeLocal = [] }) {
  const denied = new Set()
  return {
    denied,
    calls: [],
    restrict(filter) {
      const names = [...(filter.allow ?? []), ...(filter.deny ?? [])]
      const unknown = names.filter(n => !global.includes(n))
      // DSH: "Empty filters, unknown names, scope-local names ... fail".
      if (names.length === 0) throw new Error('tools.restrict({}) is a no-op')
      if (unknown.length > 0) throw new Error(`names unknown global tool ${unknown.join(', ')}`)
      const local = names.filter(n => scopeLocal.includes(n))
      if (local.length > 0) throw new Error(`cannot restrict scope-local tool ${local.join(', ')}`)
      this.calls.push(names)
      for (const n of filter.deny ?? []) denied.add(n)
      // "Restrictions intersect; scoped registrations remain visible."
      return () => { for (const n of filter.deny ?? []) denied.delete(n) }
    },
  }
}
const ctxWith = (registry) => ({ get: (n) => (n === 'tools' ? registry : undefined) })
const visible = (registry, name) => !registry.denied.has(name)

// ── 1. 全部名字都合法 ────────────────────────────────────────────────────────
const full = makeRegistry({ global: [...DEFAULT_DENIED_TOOLS] })
const r1 = restrictGlobalTools(ctxWith(full), DEFAULT_DENIED_TOOLS)
check(r1.applied.length === DEFAULT_DENIED_TOOLS.length && r1.skipped.length === 0,
  '全部名字合法 → 全部生效', `applied=${r1.applied.length}`)
check(DEFAULT_DENIED_TOOLS.every(n => visible(full, n) === false),
  '每个名字都被真的禁掉了')

// ── 2. 一个未知名字不再毁掉整张表（这就是那个 bug） ──────────────────────────
const known = DEFAULT_DENIED_TOOLS.filter(n => n !== 'workflow')
const partial = makeRegistry({ global: known })
const r2 = restrictGlobalTools(ctxWith(partial), DEFAULT_DENIED_TOOLS)
check(r2.skipped.join(',') === 'workflow', '未知名字被单独跳过', `skipped=${r2.skipped.join(',')}`)
check(r2.applied.length === DEFAULT_DENIED_TOOLS.length - 1, '其余名字照常生效', `applied=${r2.applied.length}`)
check(visible(partial, 'create_goal') === false && visible(partial, 'subagent') === false,
  '关键条目仍然被禁（旧实现这里整张表失效）')

// ── 3. 作用域内工具：禁不掉，但也不影响其它名字 ──────────────────────────────
// `ask_user_question` / `skill` are registered by the plugin itself in the agent scope;
// DSH keeps scoped registrations visible through a global deny.
const scoped = makeRegistry({ global: [...DEFAULT_DENIED_TOOLS], scopeLocal: ['ask_user_question', 'skill'] })
const r3 = restrictGlobalTools(ctxWith(scoped), DEFAULT_DENIED_TOOLS)
check(r3.skipped.includes('ask_user_question') && r3.skipped.includes('skill'),
  '插件自己注册的同名工具被记为 skipped（DSH 不允许遮蔽作用域内注册）',
  `skipped=${r3.skipped.join(',')}`)
check(r3.applied.includes('workflow') && r3.applied.includes('create_goal'),
  '同一张表里其它名字仍然生效')

// ── 4. 没有 tools 服务时不能崩 ───────────────────────────────────────────────
const none = restrictGlobalTools({}, DEFAULT_DENIED_TOOLS)
check(none.applied.length === 0 && none.skipped.length === DEFAULT_DENIED_TOOLS.length,
  '没有 tools 服务 → 全部记为 skipped，不抛异常')

// ── 5. 空表 ──────────────────────────────────────────────────────────────────
const empty = restrictGlobalTools(ctxWith(makeRegistry({ global: [] })), [])
check(empty.applied.length === 0 && empty.skipped.length === 0, '空 deny 表 → 什么都不做')

console.log(`\n[tool-mask] ${pass}/${total} 通过`)
process.exit(pass === total ? 0 : 1)
