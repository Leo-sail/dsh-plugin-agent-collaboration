/**
 * Question-card suite — 「选中」不等于「提交」.
 *
 * The card used to answer the moment an option was clicked. Two consequences, one of them a real
 * dead end: a mis-click was final, and a question whose options ARE the answer had no submit
 * control at all (the button only rendered for questions that allowed free text), so immediate
 * submission was the only way it could work.
 *
 * The submit rule lives in `answerSelection.ts` precisely so it can be tested without a DOM.
 *
 * Usage: node tests/question-card.mjs
 */
import { readFileSync } from 'node:fs'
import { resolveAnswer, canSubmit }
  from '../packages/ui/ui-agent-community/src/client/conversation/answerSelection.ts'

let pass = 0
let total = 0
const check = (ok, label, detail = '') => {
  total += 1
  if (ok) pass += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

// ── 1. 选中但没有提交 → 什么都不发 ──────────────────────────────────────────
// (The component holds the pick in state; submitting is the only caller of resolveAnswer, and it
// is wired to the button — so "picked but not submitted" is expressed by never calling this.)
check(canSubmit({ picked: undefined, text: '' }) === false, '什么都没选没填 → 提交按钮不可用')
check(resolveAnswer({ picked: undefined, text: '   ' }) === undefined, '空白文本不算回答')

// ── 2. 选中选项 → 提交时发送该选项 ─────────────────────────────────────────
check(resolveAnswer({ picked: '方案 A', text: '' }) === '方案 A', '选中选项 → 提交发送选项')
check(canSubmit({ picked: '方案 A', text: '' }) === true, '选中后提交按钮可用')

// ── 3. 手写文本优先于选项（用户明确写的字优先）────────────────────────────────
check(resolveAnswer({ picked: '方案 A', text: '用方案 C' }) === '用方案 C',
  '既选又写 → 以手写为准')
check(resolveAnswer({ picked: undefined, text: '  自定义  ' }) === '自定义', '手写内容去空格')
check(canSubmit({ picked: '方案 A', text: '   ' }) === true, '只有空白文本时仍算选中')

// ── 4. 取消选中 → 回到不可提交 ──────────────────────────────────────────────
check(resolveAnswer({ picked: undefined, text: '' }) === undefined, '取消选中且无文本 → 无内容可提交')

// ── 5. 选项里的特殊内容原样传递 ─────────────────────────────────────────────
check(resolveAnswer({ picked: 'A/B 或 C（二选一）', text: '' }) === 'A/B 或 C（二选一）',
  '选项文本原样传递，不做任何加工')

console.log(`\n[question-card] ${pass}/${total} 通过`)

// ── 导出转写必须真的有入口 ───────────────────────────────────────────────────
//
// 实测（2026-10-16）：`exportTranscript.ts` 写好了、被 ConversationArea import 了，却从没被调用
// —— 面板里没有任何"导出"控件，全仓也搜不到"导出"二字。功能存在但用户够不到。这条断言把
// "接线"钉住：import 之外必须至少有一次真实调用，且面板里必须有那个按钮。
{
  const area = readFileSync(new URL('../packages/ui/ui-agent-community/src/client/community/ConversationArea.tsx', import.meta.url), 'utf8')
  const panel = readFileSync(new URL('../packages/ui/ui-agent-community/src/client/conversation/BotConversationPanel.tsx', import.meta.url), 'utf8')
  const calls = (area.match(/exportTranscript\(/g) ?? []).length
  if (calls === 0) { console.error('FAIL 导出转写没有任何调用点（死功能）'); process.exitCode = 1 }
  else console.log('PASS 导出转写有真实调用点')
  if (!/onExport/.test(panel) || !/导出/.test(panel)) { console.error('FAIL 面板里没有导出按钮'); process.exitCode = 1 }
  else console.log('PASS 面板里有导出按钮')
}
process.exit(pass === total ? 0 : 1)

