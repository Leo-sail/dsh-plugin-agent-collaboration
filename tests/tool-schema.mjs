/**
 * Tool-schema suite for the TOOLS package — 模型看不到回复的那种坏。
 *
 * Measured on a live bot (2026-10-15): the provider rejected a request outright because ONE
 * tool's parameters were not valid JSON Schema —
 *
 *   Invalid schema for function 'agent_community_recall': true is not of type "array"
 *
 * — the run settled as `completed` in 200ms without ever calling the model, and the room showed
 * NO reply. Every tool travels with every request, so a single malformed schema silences the
 * agent. This suite registers the tools package's real definitions and checks the model-facing
 * parameters against JSON Schema's rules, including nested `items`.
 *
 * Usage: node tests/tool-schema.mjs
 */
import { apply } from '../packages/tools/tool-agent-community/src/index.ts'

let pass = 0
let total = 0
const check = (ok, label, detail = '') => {
  total += 1
  if (ok) pass += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

// Register for real, with a ctx that captures definitions and a service stub.
const registered = []
const ctx = {
  tools: { register: (definition) => registered.push(definition) },
  agentCommunity: new Proxy({}, { get: () => () => undefined }),
}
apply(ctx, {})

check(registered.length > 0, '工具都注册上了', `${registered.length} 个`)

const VALID_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const bad = { type: [], shorthand: [], notArray: [], orphan: [], untyped: [] }
const walk = (node, where) => {
  if (node === null || typeof node !== 'object') return
  if (typeof node.type === 'string' && !VALID_TYPES.has(node.type) && node.type !== 'json') {
    bad.type.push(`${where}:${node.type}`)
  }
  // `json` is tolerated only in OUTPUT schemas; inside parameters it is not a JSON Schema type.
  if (typeof node.type === 'string' && node.type === 'json') bad.type.push(`${where}:json`)
  if ('required' in node && !Array.isArray(node.required)) bad.notArray.push(where)
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    if (child !== null && typeof child === 'object' && 'required' in child) bad.shorthand.push(`${where}.${key}`)
    if (child === null || typeof child !== 'object' || typeof child.type !== 'string') bad.untyped.push(`${where}.${key}`)
    walk(child, `${where}.${key}`)
  }
  if (node.items !== undefined) walk(node.items, `${where}[]`)
}
for (const def of registered) {
  const params = def.parameters ?? {}
  walk(params, def.name)
  if (params.type !== 'object') bad.notArray.push(`${def.name}(root)`)
  for (const key of params.required ?? []) {
    if (!(key in (params.properties ?? {}))) bad.orphan.push(`${def.name}.${key}`)
  }
  // The output schema may use the host's `json` convention; it is not sent to the model.
  check(def.output?.schema !== undefined && typeof def.output.render === 'function',
    `${def.name} 带 output.schema + render`)
}
check(bad.type.length === 0, '参数里没有非法 JSON Schema type', bad.type.join(','))
check(bad.shorthand.length === 0, '属性里没有 required 简写', bad.shorthand.join(','))
check(bad.notArray.length === 0, 'required 一律是数组', bad.notArray.join(','))
check(bad.untyped.length === 0, '每个属性都声明了 type', bad.untyped.join(','))
check(bad.orphan.length === 0, 'required 的键都在 properties 里', bad.orphan.join(','))

const decompose = registered.find(d => d.name === 'agent_community_task_decompose')
check(decompose.parameters.properties.tasks.items.type === 'object',
  'task_decompose 的 items 用真实类型（原来是 json）',
  String(decompose.parameters.properties.tasks.items.type))

console.log(`\n[tool-schema] ${pass}/${total} 通过`)
process.exit(pass === total ? 0 : 1)
