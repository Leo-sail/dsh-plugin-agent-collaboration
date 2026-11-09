/**
 * The finish gate (OP-02): a group task is complete only when it can show EVIDENCE.
 *
 * WHY THIS MODULE EXISTS. `finish_task` used to be a declaration: any leader could call it
 * with a report and the room treated the task as delivered. Observed failure mode: a report
 * that describes work nobody can find — a file path that does not exist, a member message
 * that was never posted, an assignment that is still running. The user then has "done" in the
 * transcript and nothing in hand.
 *
 * So finishing is now gated on 1–8 pieces of verifiable evidence, each one of:
 *
 *   · `file`    — a regular, non-empty file (relative paths resolve against the LEADER's
 *                 workspace; an absolute path is allowed), optionally with a sha256;
 *   · `message` — a message that exists IN THIS ROOM, optionally tied to a run id;
 *   · `task`    — an assignment on this room's task board that has been reported/done.
 *
 * EVERYTHING HERE IS INJECTABLE: the file system, the hasher and the two lookups. That keeps
 * the rule testable without a host (real temp files for the file cases), and it is also the
 * safety boundary: this module never runs a shell command and never trusts the model with a
 * path outside the checks below.
 *
 * A rejection returns ALL failures (not just the first) so the model can fix the evidence in
 * one retry instead of discovering the problems one at a time.
 *
 * @module
 */
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { FinishEvidence } from './types.ts'

/** At least one piece of evidence is required to finish. */
export const FINISH_EVIDENCE_MIN = 1

/** Upper bound: eight verifiable items is a delivery, more is usually padding. */
export const FINISH_EVIDENCE_MAX = 8

/**
 * Files above this size keep their existence/size check but skip the hash comparison.
 *
 * Hashing a multi-gigabyte artefact inside a tool call would block the turn for no gain: the
 * model already gave us a path that exists and is non-empty, which is what the gate promises.
 */
export const FINISH_HASH_MAX_BYTES = 128 * 1024 * 1024

/** The minimal file system the gate needs (injected in tests). */
export interface FinishGateFs {
  stat(path: string): Promise<{ readonly isFile: boolean; readonly size: number }>
  readFile(path: string): Promise<Uint8Array>
  sha256Hex(bytes: Uint8Array): string
}

/** Real node implementations of {@link FinishGateFs}. */
export const defaultFinishGateFs: FinishGateFs = {
  async stat(path) {
    const info = await stat(path)
    return { isFile: info.isFile(), size: info.size }
  },
  async readFile(path) {
    return new Uint8Array(await readFile(path))
  },
  sha256Hex(bytes) {
    return createHash('sha256').update(bytes).digest('hex')
  },
}

/** What the gate may know about a message id. */
export interface FinishGateMessage {
  readonly roomId: string
  readonly runId?: string | undefined
}

/** One row of the room's task board, as the gate sees it. */
export interface FinishGateAssignment {
  readonly id: string
  readonly status?: string | undefined
}

/** Injectable dependencies: the service supplies lookups, tests may supply all of it. */
export interface FinishGateDeps {
  /** Defaults to the real file system. */
  readonly fs?: FinishGateFs | undefined
  /** A message in the whole community; the gate checks it belongs to this room. */
  lookupMessage?(messageId: string): FinishGateMessage | undefined
  /** The room's task-board assignments. */
  listAssignments?(): readonly FinishGateAssignment[]
  /** Path resolver seam (defaults to `path.resolve`, absolute paths kept as-is). */
  resolvePath?(workspaceRoot: string, path: string): string
}

export interface FinishGateInput {
  readonly roomId: string
  /** The leader's workspace: relative evidence paths resolve against this. */
  readonly workspaceRoot: string
  readonly evidence: readonly FinishEvidence[] | undefined
}

export type FinishGateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly failures: readonly string[] }

/** Resolve one evidence path, relative to the leader's workspace unless already absolute. */
export function resolveEvidencePath(
  workspaceRoot: string,
  path: string,
  resolvePath?: ((workspaceRoot: string, path: string) => string) | undefined,
): string {
  const trimmed = path.trim()
  if (resolvePath !== undefined) return resolvePath(workspaceRoot, trimmed)
  return isAbsolute(trimmed) ? trimmed : resolve(workspaceRoot, trimmed)
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Statuses on the task board that mean "this assignment produced something". */
const REPORTED_STATUSES = new Set(['done', 'reported'])

/**
 * Check a finish declaration's evidence.
 *
 * Pure in the sense that matters: no ambient state, no shell, all inputs injected; the async
 * file checks are the only IO and they are replaceable. Returns every failure it finds.
 */
export async function checkFinishEvidence(
  input: FinishGateInput,
  deps: FinishGateDeps = {},
): Promise<FinishGateResult> {
  const failures: string[] = []
  const evidence = Array.isArray(input.evidence) ? input.evidence : []
  if (evidence.length < FINISH_EVIDENCE_MIN) {
    return {
      ok: false,
      failures: [
        `完成证据至少 ${FINISH_EVIDENCE_MIN} 条（文件 path / 房间消息 messageId / 已完成任务 taskId），当前 ${evidence.length} 条`,
      ],
    }
  }
  if (evidence.length > FINISH_EVIDENCE_MAX) {
    return {
      ok: false,
      failures: [`完成证据最多 ${FINISH_EVIDENCE_MAX} 条，当前 ${evidence.length} 条`],
    }
  }

  const fs = deps.fs ?? defaultFinishGateFs
  const seen = new Set<string>()

  for (const [index, raw] of evidence.entries()) {
    const label = `第 ${index + 1} 条证据`
    if (raw === null || typeof raw !== 'object') {
      failures.push(`${label}：不是对象`)
      continue
    }
    const kind = stringField((raw as { kind?: unknown }).kind)
    if (kind === undefined) {
      failures.push(`${label}：缺少 kind（file / message / task）`)
      continue
    }

    if (kind === 'file') {
      const path = stringField((raw as { path?: unknown }).path)
      if (path === undefined) {
        failures.push(`${label}（file）：缺少 path`)
        continue
      }
      const resolved = resolveEvidencePath(input.workspaceRoot, path, deps.resolvePath)
      const duplicateKey = `file:${resolved}`
      if (seen.has(duplicateKey)) {
        failures.push(`${label}（file）：重复的完成证据 ${path}`)
        continue
      }
      seen.add(duplicateKey)
      let info: { readonly isFile: boolean; readonly size: number }
      try {
        info = await fs.stat(resolved)
      } catch {
        failures.push(`${label}（file）：文件不存在或不可访问 ${path}`)
        continue
      }
      if (!info.isFile) {
        failures.push(`${label}（file）：不是普通文件 ${path}`)
        continue
      }
      if (info.size <= 0) {
        failures.push(`${label}（file）：文件为空 ${path}`)
        continue
      }
      const expectedHash = stringField((raw as { sha256?: unknown }).sha256)
      if (expectedHash !== undefined) {
        if (info.size > FINISH_HASH_MAX_BYTES) {
          // Existence + non-empty already proven; hashing this would block the turn.
        } else {
          try {
            const actual = fs.sha256Hex(await fs.readFile(resolved)).toLowerCase()
            if (actual !== expectedHash.toLowerCase()) {
              failures.push(`${label}（file）：sha256 不匹配 ${path}`)
            }
          } catch {
            failures.push(`${label}（file）：无法读取文件以校验 sha256 ${path}`)
          }
        }
      }
      continue
    }

    if (kind === 'message') {
      const messageId = stringField((raw as { messageId?: unknown }).messageId)
      if (messageId === undefined) {
        failures.push(`${label}（message）：缺少 messageId`)
        continue
      }
      const duplicateKey = `message:${messageId}`
      if (seen.has(duplicateKey)) {
        failures.push(`${label}（message）：重复的完成证据 ${messageId}`)
        continue
      }
      seen.add(duplicateKey)
      if (deps.lookupMessage === undefined) {
        failures.push(`${label}（message）：无法校验消息（未提供房间消息查询）`)
        continue
      }
      const message = deps.lookupMessage(messageId)
      if (message === undefined) {
        failures.push(`${label}（message）：本房间找不到消息 ${messageId}`)
        continue
      }
      if (message.roomId !== input.roomId) {
        failures.push(`${label}（message）：消息 ${messageId} 不属于本房间`)
        continue
      }
      const runId = stringField((raw as { runId?: unknown }).runId)
      if (runId !== undefined && message.runId !== runId) {
        failures.push(`${label}（message）：消息 ${messageId} 不属于 run ${runId}`)
      }
      continue
    }

    if (kind === 'task') {
      const taskId = stringField((raw as { taskId?: unknown }).taskId)
      if (taskId === undefined) {
        failures.push(`${label}（task）：缺少 taskId`)
        continue
      }
      const duplicateKey = `task:${taskId}`
      if (seen.has(duplicateKey)) {
        failures.push(`${label}（task）：重复的完成证据 ${taskId}`)
        continue
      }
      seen.add(duplicateKey)
      const assignments = deps.listAssignments?.() ?? []
      const assignment = assignments.find(candidate => candidate.id === taskId)
      if (assignment === undefined) {
        failures.push(`${label}（task）：本房间任务板找不到任务 ${taskId}`)
        continue
      }
      const status = assignment.status ?? ''
      if (!REPORTED_STATUSES.has(status)) {
        failures.push(`${label}（task）：任务尚未回报完成（status=${status === '' ? 'unknown' : status}）`)
      }
      continue
    }

    failures.push(`${label}：未知证据类型 ${kind}（只支持 file / message / task）`)
  }

  return failures.length === 0 ? { ok: true } : { ok: false, failures }
}
