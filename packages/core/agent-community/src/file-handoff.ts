/**
 * File-first handoff (OP-22): move a produced artifact from one bot's workspace to another's.
 *
 * WHY FILES FIRST. The group flow already lets members talk (`message_member`), but a member's
 * actual deliverable usually IS a file — a draft, a dataset, a cover image. Passing its PATH in a
 * chat message only works when both bots run in the same directory; in this host every bot has
 * its own workspace, so a path in an a2a message points at a file the recipient cannot open.
 * "Here is the deck, please illustrate it" therefore degraded into the leader re-describing the
 * content in prose.
 *
 * THIS MODULE IS THE SAFETY BOUNDARY, not the transport:
 *
 *   · the source is resolved to a CANONICAL absolute path (realpath, so symlinks cannot be used
 *     to escape) and must live INSIDE the sender's workspace — a handoff is not a read primitive
 *     for `/etc`, `~/.ssh`, or another bot's files;
 *   · it must be a regular, non-empty file of at most 32 MB (the copy is bounded before any byte
 *     is touched);
 *   · the destination is always `<target workspace>/handoffs/<UTC timestamp>-<safe name>`; the
 *     name is sanitized so it can neither traverse nor collide with a reserved device name.
 *
 * `planFileHandoff` is pure apart from an injectable filesystem (stat/realpath), so every rule is
 * testable without touching a disk; `copyHandoffFile` is the (also injectable) copy step. Nothing
 * here deletes or moves the source — a handoff is a copy by definition.
 *
 * @module
 */

import {
  copyFile as nodeCopyFile,
  mkdir as nodeMkdir,
  realpath as nodeRealpath,
  stat as nodeStat,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

/** Hard ceiling on one handoff: the copy is refused before any byte is read. */
export const MAX_HANDOFF_BYTES = 32 * 1024 * 1024
/** Every handoff lands in this subdirectory of the receiver's workspace. */
export const HANDOFF_DIR = 'handoffs'
/** Bounded file name, extension included. */
export const MAX_HANDOFF_NAME_LENGTH = 120

/** The minimal file facts the planner needs (structural, so `fs.Stats` is assignable). */
export interface HandoffStatLike {
  isFile(): boolean
  size: number
}

/** Injectable filesystem seam for the pure planning step. */
export interface HandoffPlanFs {
  realpath(path: string): Promise<string>
  stat(path: string): Promise<HandoffStatLike>
}

/** Injectable filesystem seam for the copy step. */
export interface HandoffCopyFs {
  mkdir(path: string, options: { readonly recursive: boolean }): Promise<unknown>
  copyFile(source: string, target: string): Promise<void>
}

const defaultPlanFs: HandoffPlanFs = {
  realpath: path => nodeRealpath(path),
  stat: async path => nodeStat(path),
}

const defaultCopyFs: HandoffCopyFs = {
  mkdir: (path, options) => nodeMkdir(path, options),
  copyFile: (source, target) => nodeCopyFile(source, target),
}

/** Windows device names that cannot be used as a file name (even with an extension). */
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

/** Characters that would either traverse (`/`, `\`) or are illegal on common filesystems. */
const UNSAFE_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/gu

/**
 * Make one client/model-supplied file name safe to place in a directory.
 *
 * A path-shaped input keeps only its LAST segment (a name should never contain separators),
 * control characters are removed, leading/trailing dots and spaces are stripped (Windows silently
 * drops a trailing dot, which can change the name mid-copy), reserved device names are prefixed,
 * the extension is kept, and the whole result is clamped to {@link MAX_HANDOFF_NAME_LENGTH}. An
 * empty or dot-only name becomes `handoff-file` — the plan must always have something to write.
 */
export function sanitizeHandoffName(name: string): string {
  // A NAME may arrive from a path-shaped string (`../../draft.docx`, `C:\out\draft.docx`).
  // Keep only the last segment first: separators never belong to a file name, and taking the
  // basename is less surprising than turning a whole path into underscores.
  const segment = basename(name.replace(/\\/gu, '/'))
  const cleaned = segment
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .replace(UNSAFE_NAME_CHARS, '_')
    .replace(/\s+/gu, ' ')
    .trim()
  // Split a plausible extension (short last segment) so truncation keeps it.
  const dot = cleaned.lastIndexOf('.')
  const hasExt = dot > 0 && dot < cleaned.length - 1 && cleaned.length - dot <= 21
  let base = hasExt ? cleaned.slice(0, dot) : cleaned
  const extension = hasExt ? cleaned.slice(dot) : ''
  base = base.replace(/^[.\s]+|[.\s]+$/gu, '')
  if (base === '') base = 'handoff-file'
  if (RESERVED_NAMES.has(base.toLowerCase())) base = `_${base}`
  const budget = MAX_HANDOFF_NAME_LENGTH - extension.length
  const clipped = base.length > budget ? base.slice(0, Math.max(1, budget)) : base
  const result = `${clipped}${extension}`
  if (result === '') return 'handoff-file'
  return result.length > MAX_HANDOFF_NAME_LENGTH
    ? result.slice(0, MAX_HANDOFF_NAME_LENGTH)
    : result
}

/** UTC `YYYYMMDDTHHMMSSmmmZ` stamp — sortable, filesystem-safe, no colons. */
export function handoffTimestamp(date: Date): string {
  const iso = date.toISOString()
  return iso.replace(/[-:]/gu, '').replace(/\.(\d{3})Z$/u, '$1Z')
}

export interface PlanFileHandoffInput {
  /** The sending bot's workspace directory (absolute). */
  readonly senderWorkspace: string
  /** The receiver's workspace directory (absolute). */
  readonly targetWorkspace: string
  /** File the sender produced: relative to its workspace, or absolute inside it. */
  readonly sourcePath: string
  /** Optional display name to use instead of the source's basename. */
  readonly targetName?: string | undefined
  /** Injected clock for the destination timestamp (default: now). */
  readonly now?: Date | undefined
  /** Injected filesystem (default: node fs/promises). */
  readonly fs?: HandoffPlanFs | undefined
}

export type PlannedHandoff = {
  readonly ok: true
  readonly sourcePath: string
  readonly targetPath: string
  readonly size: number
}

export type FileHandoffPlan = PlannedHandoff | { readonly ok: false; readonly reason: string }

function refuse(reason: string): FileHandoffPlan {
  return { ok: false, reason }
}

/**
 * Decide whether this handoff is allowed, and where the copy would land.
 *
 * Pure apart from `input.fs`. Returns a refusal reason (never throws) for: non-absolute
 * workspaces, a workspace or file that does not exist, a source outside the sender's workspace
 * (including via a symlink), a non-regular file, an empty file, a file over 32 MB, and a name
 * that sanitizes to nothing usable.
 */
export async function planFileHandoff(input: PlanFileHandoffInput): Promise<FileHandoffPlan> {
  const fs = input.fs ?? defaultPlanFs
  const senderWorkspace = input.senderWorkspace.trim()
  const targetWorkspace = input.targetWorkspace.trim()
  if (senderWorkspace === '' || targetWorkspace === '') return refuse('发送方或接收方的工作区为空')
  if (!isAbsolute(senderWorkspace) || !isAbsolute(targetWorkspace)) {
    return refuse('工作区必须是绝对路径')
  }

  let realSender: string
  try {
    realSender = await fs.realpath(senderWorkspace)
  } catch {
    return refuse('发送方工作区不存在')
  }

  // Resolve relative paths against the sender's workspace (the same base the bot's tools use),
  // then canonicalize: containment is checked on the REAL path, so `../` and symlinked escapes
  // are refused alike.
  const candidate = isAbsolute(input.sourcePath)
    ? resolve(input.sourcePath)
    : resolve(senderWorkspace, input.sourcePath)
  let realSource: string
  try {
    realSource = await fs.realpath(candidate)
  } catch {
    return refuse('要交接的文件不存在或无法读取')
  }
  const relToSender = relative(realSender, realSource)
  if (relToSender === '' || relToSender.startsWith('..') || isAbsolute(relToSender)) {
    return refuse('只能交接发送方工作区内的文件')
  }

  let info: HandoffStatLike
  try {
    info = await fs.stat(realSource)
  } catch {
    return refuse('要交接的文件不存在或无法读取')
  }
  if (!info.isFile()) return refuse('只能交接普通文件（目录、链接或其他类型都不行）')
  const size = info.size
  if (!Number.isFinite(size) || size <= 0) return refuse('文件为空，没有可交接的内容')
  if (size > MAX_HANDOFF_BYTES) {
    const limitMb = Math.round(MAX_HANDOFF_BYTES / (1024 * 1024))
    return refuse(`文件超过 ${limitMb}MB 上限，拒绝交接`)
  }

  const name = sanitizeHandoffName(input.targetName ?? basename(realSource))
  const targetDir = resolve(targetWorkspace, HANDOFF_DIR)
  const targetPath = join(targetDir, `${handoffTimestamp(input.now ?? new Date())}-${name}`)
  // Defence in depth: the sanitizer already removed separators, but a target outside the
  // handoff directory must never be planned, whatever produced the name.
  const relToTarget = relative(targetDir, targetPath)
  if (relToTarget === '' || relToTarget.startsWith('..') || isAbsolute(relToTarget)) {
    return refuse('目标文件名非法')
  }
  return { ok: true, sourcePath: realSource, targetPath, size }
}

/** The copy step of a planned handoff; never removes or moves the source. */
export async function copyHandoffFile(
  plan: Pick<PlannedHandoff, 'sourcePath' | 'targetPath'>,
  fs: HandoffCopyFs = defaultCopyFs,
): Promise<{ readonly ok: true; readonly targetPath: string } | { readonly ok: false; readonly reason: string }> {
  try {
    await fs.mkdir(dirname(plan.targetPath), { recursive: true })
    await fs.copyFile(plan.sourcePath, plan.targetPath)
    return { ok: true, targetPath: plan.targetPath }
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `复制文件失败：${detail}` }
  }
}
