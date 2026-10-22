/**
 * OP-02: a group task is complete only when its EVIDENCE checks out.
 *
 * The failure this prevents: a leader calls `finish_task` with a convincing report and the
 * room marks the task delivered, while the file it names does not exist, the message it cites
 * was never posted, or the assignment is still running. These tests exercise the gate directly
 * — real temp files for the file cases, injected lookups for messages/tasks, and an injected
 * file system for the >128 MB hash-skip path — with no DSH host involved.
 *
 * Run with: node --test tests/finish-gate.test.ts  (Node v26 runs TypeScript directly)
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  checkFinishEvidence,
  FINISH_EVIDENCE_MAX,
  FINISH_HASH_MAX_BYTES,
  type FinishGateDeps,
  type FinishGateFs,
} from '../packages/core/agent-community/src/finish-gate.ts'
import { GroupTaskDriver } from '../packages/core/agent-community/src/group-task.ts'
import type { GroupTaskState } from '../packages/core/agent-community/src/group-task.ts'
import type { FinishEvidence } from '../packages/core/agent-community/src/types.ts'

const ROOM = 'room-1'

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** A throwaway workspace with one real file of known content. */
async function workspaceFixture(): Promise<{ root: string; file: string; content: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'finish-gate-'))
  await mkdir(join(root, 'out'), { recursive: true })
  const content = '# 报告\n完成内容\n'
  const file = join(root, 'out', 'report.md')
  await writeFile(file, content, 'utf8')
  return { root, file, content, cleanup: async () => { await rm(root, { recursive: true, force: true }) } }
}

/** Lookups a service would supply; messages/tasks are plain data here. */
function lookups(overrides: Partial<Pick<FinishGateDeps, 'lookupMessage' | 'listAssignments'>> = {}): FinishGateDeps {
  return {
    lookupMessage: overrides.lookupMessage ?? ((messageId) => (
      messageId === 'msg-1'
        ? { roomId: ROOM, runId: 'run-1' }
        : messageId === 'msg-other-room' ? { roomId: 'room-2' }
          : undefined
    )),
    listAssignments: overrides.listAssignments ?? (() => [
      { id: 'task-done', status: 'done' },
      { id: 'task-reported', status: 'reported' },
      { id: 'task-working', status: 'working' },
    ]),
  }
}

async function check(evidence: readonly FinishEvidence[], deps: FinishGateDeps = lookups(), root = '/tmp/workspace') {
  return await checkFinishEvidence({ roomId: ROOM, workspaceRoot: root, evidence }, deps)
}

/** Narrow the result to a failure so assertions can read `failures`. */
function failuresOf(result: Awaited<ReturnType<typeof checkFinishEvidence>>): readonly string[] {
  return result.ok ? [] : result.failures
}

// ── file evidence (real temp directory) ────────────────────────────────────

test('a real relative file passes, with and without a matching sha256', async () => {
  const ws = await workspaceFixture()
  try {
    const plain = await check([{ kind: 'file', path: 'out/report.md' }], lookups(), ws.root)
    assert.deepEqual(plain, { ok: true })
    const withHash = await check(
      [{ kind: 'file', path: 'out/report.md', sha256: sha256(ws.content) }],
      lookups(),
      ws.root,
    )
    assert.deepEqual(withHash, { ok: true })
  } finally {
    await ws.cleanup()
  }
})

test('an absolute file path is accepted as-is', async () => {
  const ws = await workspaceFixture()
  try {
    assert.deepEqual(await check([{ kind: 'file', path: ws.file }], lookups(), ws.root), { ok: true })
  } finally {
    await ws.cleanup()
  }
})

test('a missing file is a named failure', async () => {
  const ws = await workspaceFixture()
  try {
    const failures = failuresOf(await check([{ kind: 'file', path: 'out/missing.md' }], lookups(), ws.root))
    assert.equal(failures.length, 1)
    assert.match(failures[0]!, /文件不存在或不可访问/u)
  } finally {
    await ws.cleanup()
  }
})

test('a directory and an empty file are not evidence', async () => {
  const ws = await workspaceFixture()
  try {
    const dir = await check([{ kind: 'file', path: 'out' }], lookups(), ws.root)
    assert.equal(dir.ok, false)
    assert.match(failuresOf(dir)[0]!, /不是普通文件/u)

    await writeFile(join(ws.root, 'empty.txt'), '')
    const empty = await check([{ kind: 'file', path: 'empty.txt' }], lookups(), ws.root)
    assert.equal(empty.ok, false)
    assert.match(failuresOf(empty)[0]!, /文件为空/u)
  } finally {
    await ws.cleanup()
  }
})

test('a sha256 mismatch is rejected', async () => {
  const ws = await workspaceFixture()
  try {
    const result = await check([{ kind: 'file', path: 'out/report.md', sha256: '0'.repeat(64) }], lookups(), ws.root)
    assert.equal(result.ok, false)
    assert.match(failuresOf(result)[0]!, /sha256 不匹配/u)
  } finally {
    await ws.cleanup()
  }
})

test('a file above the hash limit keeps its existence check and skips hashing', async () => {
  const bigSize = FINISH_HASH_MAX_BYTES + 1
  let readCalls = 0
  const fs: FinishGateFs = {
    stat: async () => ({ isFile: true, size: bigSize }),
    readFile: async () => { readCalls += 1; throw new Error('must not read a huge file') },
    sha256Hex: () => 'unused',
  }
  const result = await check(
    [{ kind: 'file', path: 'huge.bin', sha256: 'f'.repeat(64) }],
    { ...lookups(), fs },
  )
  assert.deepEqual(result, { ok: true }) // existence + non-empty proven; hash intentionally skipped
  assert.equal(readCalls, 0)
})

test('an unreadable file with a hash is a failure (existence passed, integrity unknown)', async () => {
  const fs: FinishGateFs = {
    stat: async () => ({ isFile: true, size: 10 }),
    readFile: async () => { throw new Error('EACCES') },
    sha256Hex: () => 'unused',
  }
  const result = await check([{ kind: 'file', path: 'locked.bin', sha256: 'a'.repeat(64) }], { ...lookups(), fs })
  assert.equal(result.ok, false)
  assert.match(failuresOf(result)[0]!, /无法读取文件以校验 sha256/u)
})

// ── message evidence ───────────────────────────────────────────────────────

test('a message in this room passes; a runId must match when given', async () => {
  assert.deepEqual(await check([{ kind: 'message', messageId: 'msg-1' }]), { ok: true })
  assert.deepEqual(await check([{ kind: 'message', messageId: 'msg-1', runId: 'run-1' }]), { ok: true })
  const wrongRun = await check([{ kind: 'message', messageId: 'msg-1', runId: 'run-2' }])
  assert.equal(wrongRun.ok, false)
  assert.match(failuresOf(wrongRun)[0]!, /不属于 run run-2/u)
})

test('a missing message or one from another room is rejected', async () => {
  const missing = await check([{ kind: 'message', messageId: 'msg-nope' }])
  assert.equal(missing.ok, false)
  assert.match(failuresOf(missing)[0]!, /找不到消息/u)

  const otherRoom = await check([{ kind: 'message', messageId: 'msg-other-room' }])
  assert.equal(otherRoom.ok, false)
  assert.match(failuresOf(otherRoom)[0]!, /不属于本房间/u)
})

test('message evidence without a messageId or with no lookup available is a failure', async () => {
  const noId = await check([{ kind: 'message' } as unknown as FinishEvidence])
  assert.equal(noId.ok, false)
  assert.match(failuresOf(noId)[0]!, /缺少 messageId/u)

  const noLookup: FinishGateDeps = { lookupMessage: undefined }
  const result = await check([{ kind: 'message', messageId: 'msg-1' }], noLookup)
  assert.equal(result.ok, false)
  assert.match(failuresOf(result)[0]!, /无法校验消息/u)
})

// ── task evidence ──────────────────────────────────────────────────────────

test('only reported/done assignments count as task evidence', async () => {
  assert.deepEqual(await check([{ kind: 'task', taskId: 'task-done' }]), { ok: true })
  assert.deepEqual(await check([{ kind: 'task', taskId: 'task-reported' }]), { ok: true })

  const working = await check([{ kind: 'task', taskId: 'task-working' }])
  assert.equal(working.ok, false)
  assert.match(failuresOf(working)[0]!, /尚未回报完成/u)

  const unknown = await check([{ kind: 'task', taskId: 'task-nope' }])
  assert.equal(unknown.ok, false)
  assert.match(failuresOf(unknown)[0]!, /找不到任务/u)
})

test('task evidence without an id is a failure', async () => {
  const result = await check([{ kind: 'task' } as unknown as FinishEvidence])
  assert.equal(result.ok, false)
  assert.match(failuresOf(result)[0]!, /缺少 taskId/u)
})

// ── shape rules ────────────────────────────────────────────────────────────

test('empty or missing evidence is rejected with an explanatory reason', async () => {
  for (const evidence of [[], undefined] as const) {
    const result = await checkFinishEvidence({ roomId: ROOM, workspaceRoot: '/tmp/workspace', evidence })
    assert.equal(result.ok, false)
    assert.match(failuresOf(result)[0]!, /至少 1 条/u)
  }
})

test('more than the maximum evidence items is rejected', async () => {
  const many: FinishEvidence[] = Array.from({ length: FINISH_EVIDENCE_MAX + 1 }, (_v, i) => (
    { kind: 'message', messageId: `msg-${i}` }
  ))
  const result = await check(many)
  assert.equal(result.ok, false)
  assert.match(failuresOf(result)[0]!, new RegExp(`最多 ${FINISH_EVIDENCE_MAX} 条`, 'u'))
})

test('duplicate evidence, unknown kinds and malformed items are rejected', async () => {
  const duplicate = await check([
    { kind: 'message', messageId: 'msg-1' },
    { kind: 'message', messageId: 'msg-1' },
  ])
  assert.equal(duplicate.ok, false)
  assert.match(failuresOf(duplicate).join('|'), /重复的完成证据/u)

  const unknownKind = await check([{ kind: 'screenshot' } as unknown as FinishEvidence])
  assert.equal(unknownKind.ok, false)
  assert.match(failuresOf(unknownKind).join('|'), /未知证据类型/u)

  const notObject = await check([null as unknown as FinishEvidence])
  assert.equal(notObject.ok, false)
  assert.match(failuresOf(notObject).join('|'), /不是对象/u)
})

test('every failure is reported at once, so one retry can fix them all', async () => {
  const result = await check([
    { kind: 'message', messageId: 'msg-nope' },
    { kind: 'task', taskId: 'task-working' },
  ])
  assert.equal(result.ok, false)
  const failures = failuresOf(result)
  assert.equal(failures.length, 2)
  assert.match(failures[0]!, /找不到消息/u)
  assert.match(failures[1]!, /尚未回报完成/u)
})

test('a mixed valid set passes', async () => {
  const ws = await workspaceFixture()
  try {
    const result = await check([
      { kind: 'file', path: 'out/report.md' },
      { kind: 'message', messageId: 'msg-1' },
      { kind: 'task', taskId: 'task-done' },
    ], lookups(), ws.root)
    assert.deepEqual(result, { ok: true })
  } finally {
    await ws.cleanup()
  }
})

// ── the driver records the gate outcome (OP-02 persistence) ────────────────

test('GroupTaskDriver.finish stores evidence + gate on the finished task', async () => {
  const saved: GroupTaskState[] = []
  const reports: Array<{ roomId: string; leaderId: string; report: string }> = []
  const driver = new GroupTaskDriver({
    enqueueRun: () => true,
    roomById: () => ({ memberIds: ['leader-1'] }),
    leaderOf: () => 'leader-1',
    botName: id => id,
    hasLiveRun: () => false,
    isCompacting: () => false,
    postReport: (roomId, leaderId, report) => { reports.push({ roomId, leaderId, report }) },
    saveTaskState: (_roomId, state) => { saved.push(state) },
    lastUserMessageAt: () => undefined,
    loadTaskState: () => undefined,
  })
  const evidence: FinishEvidence[] = [
    { kind: 'file', path: 'out/report.md' },
    { kind: 'message', messageId: 'msg-1' },
  ]
  await driver.finish({ roomId: ROOM, report: '做完了', evidence, gate: 'passed' })
  const finished = saved.at(-1)?.finished
  assert.ok(finished !== undefined)
  assert.equal(finished.report, '做完了')
  assert.deepEqual(finished.evidence, evidence) // the audit trail survives the close
  assert.equal(finished.gate, 'passed')
  // The final report is still posted exactly once (postReport owns the message row).
  assert.equal(reports.length, 1)
  assert.equal(reports[0]!.report, '做完了')
  assert.equal(driver.isFinished(ROOM), true)
})

test('a bypassed finish is recorded as bypassed, not as passed', async () => {
  const saved: GroupTaskState[] = []
  const driver = new GroupTaskDriver({
    enqueueRun: () => true,
    roomById: () => ({ memberIds: ['leader-1'] }),
    leaderOf: () => 'leader-1',
    botName: id => id,
    hasLiveRun: () => false,
    isCompacting: () => false,
    postReport: () => undefined,
    saveTaskState: (_roomId, state) => { saved.push(state) },
    lastUserMessageAt: () => undefined,
    loadTaskState: () => undefined,
  })
  await driver.finish({ roomId: ROOM, report: '放行', evidence: [], gate: 'bypassed' })
  assert.equal(saved.at(-1)?.finished?.gate, 'bypassed')
})
