// The bot agent preset is a CONFIGURATION file, so nothing type-checks it: a typo'd module name or
// a re-added `tool-subagent` row would only show up as a bot with the wrong tools at runtime —
// exactly the defect this preset exists to fix. These assertions are cheap and catch that.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'packages/bundle/agent-collaboration/agent-presets/bot')
const yml = readFileSync(join(dir, 'agent.cordis.yml'), 'utf8')
const meta = readFileSync(join(dir, 'preset.yml'), 'utf8')
const indexSrc = readFileSync(join(root, 'packages/core/agent-community/src/index.ts'), 'utf8')
// THIS deployment declares presets as plugin rows, not as .agent-presets directories: the row in
// the bundle patch is what the roster actually sees, so the fixture has to judge it too.
const patch = readFileSync(join(root, 'packages/bundle/agent-collaboration/cordis.patch.yml'), 'utf8')
const patchRow = patch.slice(patch.indexOf('id: preset-bot'))

let pass = 0
const check = (ok, label, extra) => {
  if (!ok) { console.error(`FAIL ${label}${extra === undefined ? '' : ' — ' + extra}`); process.exitCode = 1 }
  else pass += 1
}

// ── what a bot MUST keep ────────────────────────────────────────────────────
for (const name of [
  '@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-tool-fs-search',
  '@deepseek-ai/dsh-tool-skill', '@deepseek-ai/dsh-skill-filesystem', '@deepseek-ai/dsh-tool-todo',
  '@deepseek-ai/dsh-tool-web', '@deepseek-ai/dsh-compaction-basic',
]) check(yml.includes(name), `保留 ${name}`)

// ── what a bot must NOT get (this is the whole point of the file) ───────────
for (const name of [
  '@deepseek-ai/dsh-tool-goal', '@deepseek-ai/dsh-command-goal', '@deepseek-ai/dsh-plan-mode',
  '@deepseek-ai/dsh-tool-subagent', '@deepseek-ai/dsh-tool-subagent-control',
  '@deepseek-ai/dsh-tool-workflow', '@deepseek-ai/dsh-workflow-worker-thread',
  '@deepseek-ai/dsh-tool-ralph',
  // the plugin registers its own ask_user_question that draws the question card: a second
  // registration of that name is the collision that silently dropped tools earlier
  '@deepseek-ai/dsh-tool-ask-user',
]) check(!yml.includes(name), `不含 ${name}`)

// A service row outside an isolate realm publishes process-globally, which the roster rejects at
// mount time — the preset would simply not load.
const groups = (yml.match(/isolate:/g) ?? []).length
check(groups >= 1, 'compaction 组带 isolate realm', String(groups))

// The name a session is created with must be the directory the roster will find.
check(/order:\s*\d+/.test(meta), 'preset.yml 有 order')
check(meta.includes('name:'), 'preset.yml 有展示名')
check(/agentPreset:\s*config\.botAgentPreset \?\? 'bot'/.test(indexSrc), "插件默认 agentPreset = 'bot'")
// A SCHEMA default always supplies a value, so the runtime fallback is dead code without this:
// the preset switch is the schema default, and it silently stayed 'standard' until measured.
check(/botAgentPreset:\s*z\.string\(\)\.default\('bot'\)/.test(indexSrc), "配置 schema 默认 = 'bot'")
check(!/botAgentPreset:\s*z\.string\(\)\.default\('standard'\)/.test(indexSrc), "schema 默认不再是 'standard'")
check(!/agentPreset:\s*config\.botAgentPreset \?\? 'standard'/.test(indexSrc), "不再默认 'standard'")

// ── the row the HOST reads ──────────────────────────────────────────────────
check(patchRow.length > 0, 'bundle patch 里有 preset-bot 行')
check(/id:\s*bot\b/.test(patchRow), "行内 id 为 bot")
check(/name:\s*'@deepseek-ai\/dsh-agent-preset'/.test(patchRow), '用 dsh-agent-preset 声明')
for (const name of [
  '@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-tool-fs-search',
  '@deepseek-ai/dsh-tool-skill', '@deepseek-ai/dsh-skill-filesystem', '@deepseek-ai/dsh-tool-todo',
  '@deepseek-ai/dsh-tool-web', '@deepseek-ai/dsh-compaction-basic',
]) check(patchRow.includes(name), `行内保留 ${name}`)
for (const name of [
  '@deepseek-ai/dsh-tool-goal', '@deepseek-ai/dsh-command-goal', '@deepseek-ai/dsh-plan-mode',
  '@deepseek-ai/dsh-tool-subagent', '@deepseek-ai/dsh-tool-subagent-control',
  '@deepseek-ai/dsh-tool-workflow', '@deepseek-ai/dsh-tool-ralph', '@deepseek-ai/dsh-tool-ask-user',
]) check(!patchRow.includes(name), `行内不含 ${name}`)
check(/isolate:/.test(patchRow), '行内 compaction 组带 isolate realm')

console.log(`[bot-preset] ${pass} 通过`)
