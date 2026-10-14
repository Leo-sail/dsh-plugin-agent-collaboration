/**
 * Outgoing attachments: what the panel sends, where the host puts it, and what the
 * model is told.
 *
 * The browser half hands over BYTES (base64) and nothing else — no path, and no promise
 * that the name is a name. Everything here exists to turn that untrusted pair into a
 * file that is provably inside the receiving bot's own workspace, plus the one block of
 * prose that tells the model where to read it.
 *
 * Two rules drive the shape:
 *   · the user's bubble must stay exactly what they typed, so nothing here ever touches
 *     the message `text` — the reference is appended to the model-only `modelText`;
 *   · a rejection must be loud. Silently dropping an over-limit file leaves the user
 *     believing the bot received something it never saw.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SendRoomMessageAttachment } from './types.ts'

/** At most this many files per message. */
export const MAX_ATTACHMENT_COUNT = 5
/** At most this many bytes per message, counting every attachment together. */
export const MAX_ATTACHMENT_TOTAL_BYTES = 8 * 1024 * 1024
/** How much of a name is kept. Longer names are cut, never rejected. */
const MAX_NAME_CHARS = 80

/** One attachment as it exists on disk, after decoding and sanitizing. */
export interface StoredAttachment {
  /** Sanitized name (a label — never a path). */
  readonly name: string
  readonly mime: string
  readonly bytes: number
  /** Absolute path of the stored copy. */
  readonly path: string
  /** Path relative to the workspace it was written under. */
  readonly relativePath: string
}

/** Extension → MIME, used when the browser reports nothing useful. */
const MIME_BY_EXT: Record<string, string> = {
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Turn any user-supplied string into a name that can only ever mean "a file directly
 * inside the attachments directory".
 *
 * Separators are removed by taking the last path segment, so `../../etc/passwd` becomes
 * `passwd`; leading dots go too, so `.` / `..` / dotfiles cannot survive as themselves.
 * An empty result becomes `file` rather than throwing: an unnamed attachment is still a
 * valid attachment, and refusing the message would be worse than a generic name.
 */
export function sanitizeAttachmentName(raw: string): string {
  const base = raw.split(/[\\/]/).filter(part => part !== '').pop() ?? ''
  const cleaned = base
    // Control characters would let a name break the one-per-line reference block.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    // Kept out of names on Windows; harmless to normalize everywhere.
    .replace(/[<>:"|?*]/g, '_')
    // ".", "..", and hidden files all start here.
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim()
  const cut = cleaned.slice(0, MAX_NAME_CHARS).trim()
  return cut === '' ? 'file' : cut
}

function decodeBase64(rawName: string, data: string): Buffer {
  if (typeof data !== 'string' || data === '') return Buffer.alloc(0)
  // `Buffer.from(x, 'base64')` ignores invalid characters instead of failing, which
  // would quietly truncate a corrupt transfer into a plausible-looking file.
  if (!/^[A-Za-z0-9+/=\s]*$/.test(data)) {
    throw new Error(`附件「${rawName}」的数据无效（不是合法的 base64）`)
  }
  return Buffer.from(data, 'base64')
}

function resolveMime(mime: string | undefined, name: string): string {
  const given = typeof mime === 'string' ? mime.trim() : ''
  if (given !== '' && given !== 'application/octet-stream') return given
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
  return MIME_BY_EXT[ext] ?? (given !== '' ? given : 'application/octet-stream')
}

function stampOf(at: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}`
    + `-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`
}

/**
 * Decode, validate, and write every attachment under `<workspaceDir>/attachments`.
 *
 * All validation happens BEFORE the first write: a message that trips a cap must not
 * leave half of its files behind in a workspace the user never sees.
 */
export async function storeAttachments(
  workspaceDir: string,
  attachments: readonly SendRoomMessageAttachment[],
  at: Date,
): Promise<StoredAttachment[]> {
  if (attachments.length === 0) return []
  if (attachments.length > MAX_ATTACHMENT_COUNT) {
    throw new Error(`附件数量超出上限：最多 ${MAX_ATTACHMENT_COUNT} 个，本条消息有 ${attachments.length} 个`)
  }

  const decoded = attachments.map((a, index) => {
    const name = sanitizeAttachmentName(typeof a.name === 'string' ? a.name : '')
    return {
      index,
      name,
      mime: resolveMime(a.mime, name),
      bytes: decodeBase64(typeof a.name === 'string' ? a.name : '', a.dataBase64),
    }
  })

  const total = decoded.reduce((sum, d) => sum + d.bytes.byteLength, 0)
  if (total > MAX_ATTACHMENT_TOTAL_BYTES) {
    throw new Error(
      `附件总大小超出上限：最多 ${formatBytes(MAX_ATTACHMENT_TOTAL_BYTES)}，`
      + `本条消息为 ${formatBytes(total)}`,
    )
  }

  const dir = join(workspaceDir, 'attachments')
  await mkdir(dir, { recursive: true })
  const stamp = stampOf(at)
  const stored: StoredAttachment[] = []
  for (const d of decoded) {
    // The index keeps two same-named files in one message apart; `path` is built from
    // the sanitized name only, so it cannot escape `dir`.
    const fileName = `${stamp}-${d.index + 1}-${d.name}`
    const path = join(dir, fileName)
    await writeFile(path, d.bytes)
    stored.push({
      name: d.name,
      mime: d.mime,
      bytes: d.bytes.byteLength,
      path,
      relativePath: `attachments/${fileName}`,
    })
  }
  return stored
}

/**
 * The block appended to the MODEL payload.
 *
 * `absolutePaths` is for a direct room, where exactly one bot receives the message and
 * a full path leaves the model no room to guess. A group writes a copy into every
 * member's workspace, so the same file has a different absolute path per bot — there the
 * workspace-relative path plus the explicit "under your cwd" wording is the only form
 * that is true for all of them.
 */
export function renderAttachmentReference(
  stored: readonly StoredAttachment[],
  opts: { readonly absolutePaths: boolean },
): string {
  if (stored.length === 0) return ''
  const lines = stored.map(s =>
    `- ${opts.absolutePaths ? s.path : s.relativePath}（${s.mime}, ${formatBytes(s.bytes)}）`,
  )
  const block = [
    '[附件]',
    opts.absolutePaths
      ? `用户随本条消息上传了 ${stored.length} 个文件，已保存到磁盘，可用文件工具读取：`
      // A group stores one copy per member, so the same file has a different absolute
      // path in each workspace; only the workspace-relative form is true for all of them.
      : `用户随本条消息上传了 ${stored.length} 个文件，已保存到你的工作目录（cwd）下，可用文件工具读取（下面是从你的工作目录算起的相对路径）：`,
    ...lines,
  ]
  if (stored.some(s => s.mime.startsWith('image/'))) {
    // Honest, because it changes what the bot can do: the file tools can read the PNG,
    // but nothing in this pipeline turns it into something the model can see.
    block.push('其中图片同样只以文件形式保存：本会话没有图像输入，请用文件工具处理，不要凭文件名猜测画面内容。')
  }
  return `\n\n${block.join('\n')}\n`
}
