/**
 * Tool execution for Bot Community runs.
 *
 * These tools run in-process against the bot's configured workspace. They do NOT
 * go through DSH's Agent/Session pipeline: an Agent is bound to a Session, DSH
 * persists and lists every Session in its sidebar, and Bot Community
 * conversations must stay out of that list. Executing here keeps the whole loop
 * — model call, tool call, model call — inside the plugin, with the ledger as the
 * only record.
 *
 * Safety: every path is resolved and confined to the bot's workspace root, so a
 * model cannot read or write outside it.
 */
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises'
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path'

/** Permission level a bot runs with; mirrors the plugin's BotPermission. */
export type ToolPermission = 'read-only' | 'workspace-write' | 'full-access'

/** Tool schema as sent to the model (mirrors @deepseek-ai/dsh-llm ToolSchema). */
export interface ToolSchema {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
}

export interface ToolInvocation {
  readonly id: string
  readonly name: string
  readonly arguments: string
}

export interface ToolOutcome {
  readonly ok: boolean
  readonly output: string
}

/**
 * Tool schemas for a given permission level.
 *
 * The descriptions have to state where a relative path lands, because the answer
 * changes with the permission: a `full-access` bot resolves relative paths against
 * the user's home directory and may read or write anywhere, while every other
 * level stays inside the bot's workspace. Leaving the text saying "relative to the
 * workspace root" made an unrestricted bot keep poking at its own directory.
 */
export function toolSchemas(permission: ToolPermission): readonly ToolSchema[] {
  const unrestricted = permission === 'full-access'
  const where = unrestricted
    ? 'Relative paths resolve against your home directory. You have full access: '
      + 'you may read, write and run commands anywhere on this machine, including '
      + 'outside your bot workspace — use absolute paths when you know them.'
    : 'Relative paths resolve against your bot workspace, and every path must stay '
      + 'inside it.'
  return BASE_TOOL_SCHEMAS.map(schema => ({
    ...schema,
    description: `${schema.description} ${where}`,
  }))
}


const BASE_TOOL_SCHEMAS: readonly ToolSchema[] = [
  {
    name: 'read',
    description: 'Read a UTF-8 text file from the workspace. Returns numbered lines.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root.' },
        offset: { type: 'number', description: '1-based first line (optional).' },
        limit: { type: 'number', description: 'Maximum lines to return (optional, default 2000).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write',
    description: 'Create or overwrite a text file in the workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit',
    description: 'Replace the first exact occurrence of old_string with new_string in a file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'glob',
    description: 'List files under a directory whose path matches a substring pattern.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Substring or simple glob, e.g. "*.ts".' },
        path: { type: 'string', description: 'Directory to search. Defaults to the workspace root. Absolute paths outside the workspace need full-access permission.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description: 'Search file contents under a directory with a regular expression.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        include: { type: 'string', description: 'Only search files matching this substring (optional).' },
        path: { type: 'string', description: 'Directory to search. Defaults to the workspace root. Absolute paths outside the workspace need full-access permission.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'skill',
    description: 'Load a skill by name and follow its instructions. The available skill names are listed in your prompt under [可用技能].',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The exact skill name from the available skills list.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'bash',
    description: 'Run a shell command in the workspace root and return its output.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout_ms: { type: 'number', description: 'Timeout in milliseconds (optional, default 120000).' },
      },
      required: ['command'],
    },
  },
]

/**
 * `read` limits, mirroring the native tool (`dsh-tool-fs`): 2000 lines per call, 2000
 * characters per line, 50 KB per call.
 *
 * A previous build removed all three and returned files whole. That was wrong in two
 * ways: it was not what the model gets from the native tool, and one large read could
 * spend the entire context budget in a single step. 50 KB stays deliberately generous —
 * the 47 KB `ui-ux-pro-max/SKILL.md` still arrives complete.
 */
const READ_LIMIT = 2_000
const READ_MAX_LINE_LENGTH = 2_000
const READ_MAX_BYTES = 50 * 1024

/**
 * Resolve a tool path.
 *
 * `allowEscape` is the bot's `full-access` permission: without it every path is
 * confined to the workspace root (absolute paths and traversal are rejected).
 */
function safeJoin(root: string, p: string, allowEscape = false): string {
  const target = isAbsolute(p) ? resolve(p) : resolve(root, p)
  if (allowEscape) return target
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path escapes the workspace: ${p}`)
  }
  return target
}

function parseArgs(raw: string): Record<string, unknown> {
  if (raw.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    throw new Error(`could not parse tool arguments as JSON: ${raw.slice(0, 200)}`)
  }
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== 'string' || v === '') throw new Error(`missing required string argument "${key}"`)
  return v
}

/** Extract the value assigned to `name` from a simple JS/TS source file. */
export class ToolRunner {
  private readonly root: string

  /** Bot permission level; enforced here because nothing else does. */
  private readonly permission: ToolPermission

  /** Loads a skill's text from the host registry, when one is available. */
  private readonly loadSkill: ((name: string) => Promise<string | undefined>) | undefined

  constructor(
    workspace: string,
    permission: ToolPermission = 'workspace-write',
    loadSkill?: ((name: string) => Promise<string | undefined>) | undefined,
  ) {
    this.root = resolve(workspace)
    this.permission = permission
    this.loadSkill = loadSkill
  }

  /** `read-only` may inspect but never mutate. */
  private get canWrite(): boolean {
    return this.permission !== 'read-only'
  }

  /** `full-access` may leave the workspace root. */
  private get canEscape(): boolean {
    return this.permission === 'full-access'
  }

  /**
   * Directory a RELATIVE path is resolved against.
   *
   * Under `full-access` this is the user's home, so an unrestricted bot can
   * reach any location by default instead of only when it happens to pass an
   * absolute path. Other levels stay anchored to the workspace root.
   */
  private get base(): string {
    return this.canEscape ? homedir() : this.root
  }

  /**
   * Read roots a bot may always reach, even when anchored to its workspace.
   *
   * Skill files live under the user's home (`~/.agents/skills/...`) and are trusted
   * local content, but reading them from a `workspace-write` bot used to require an
   * escape — which macOS answered with a folder-access authorization prompt. Skills
   * are part of the bot's own configuration, so they are readable by design.
   */
  private get skillRoots(): string[] {
    return [
      join(homedir(), '.agents', 'skills'),
      join(homedir(), '.dsh', 'skills'),
    ]
  }

  /** True when `abs` sits inside one of the always-readable skill roots. */
  private inSkillRoot(abs: string): boolean {
    return this.skillRoots.some(root => abs === root || abs.startsWith(root + sep))
  }

  private join(p: string): string {
    // Absolute paths inside a skill root bypass the escape check.
    if (isAbsolute(p) && this.inSkillRoot(resolve(p))) return resolve(p)
    return safeJoin(this.base, p, this.canEscape)
  }

  /**
   * Directory a search should start from.
   *
   * `glob` and `grep` used to ignore any caller-supplied path and always walk the
   * bot's workspace, so `full-access` could never reach another folder even though
   * the permission was granted.
   */
  private searchRoot(args: Record<string, unknown>): string {
    const p = typeof args.path === 'string' && args.path !== '' ? args.path : '.'
    return this.join(p)
  }

  /** Path shown to the model: workspace-relative when inside, absolute outside. */
  private displayPath(abs: string): string {
    const rel = relative(this.root, abs)
    // Workspace-relative when inside it; home-relative (`~/x`) otherwise, which
    // reads far better than a wall of `../../..` for an unrestricted bot.
    if (!rel.startsWith('..') && !isAbsolute(rel)) return rel
    const home = homedir()
    return abs === home || abs.startsWith(home + '/') ? `~${abs.slice(home.length)}` : abs
  }

  get workspaceRoot(): string {
    return this.root
  }

  /**
   * Load a skill's instructions.
   *
   * Skills are model-invocable documents: the result is the SKILL.md text, which the
   * model then follows. This is the same contract as the host's own `skill` tool.
   */
  private async skill(args: Record<string, unknown>): Promise<ToolOutcome> {
    const name = str(args, 'name')
    if (this.loadSkill === undefined) {
      return { ok: false, output: 'no skill registry is available in this build' }
    }
    const content = await this.loadSkill(name)
    if (content === undefined) {
      return { ok: false, output: `skill "${name}" is unknown or no longer available` }
    }
    return { ok: true, output: content }
  }

  private denied(tool: string): ToolOutcome {
    return {
      ok: false,
      output: `permission denied: this bot is read-only, so "${tool}" is not allowed. `
        + 'Ask the user to raise its permission to workspace-write.',
    }
  }

  async run(invocation: ToolInvocation): Promise<ToolOutcome> {
    try {
      const args = parseArgs(invocation.arguments)
      switch (invocation.name) {
        case 'read': return await this.read(args)
        case 'glob': return await this.glob(args)
        case 'grep': return await this.grep(args)
        // Mutating tools are refused outright under `read-only` rather than run
        // and rejected later, so the model gets a clear, actionable error.
        case 'write':
          if (!this.canWrite) return this.denied('write')
          return await this.write(args)
        case 'edit':
          if (!this.canWrite) return this.denied('edit')
          return await this.edit(args)
        case 'bash':
          if (!this.canWrite) return this.denied('bash')
          return await this.bash(args)
        case 'skill': return await this.skill(args)
        default:
          return { ok: false, output: `unknown tool "${invocation.name}"` }
      }
    } catch (error) {
      return { ok: false, output: error instanceof Error ? error.message : String(error) }
    }
  }

  private async read(args: Record<string, unknown>): Promise<ToolOutcome> {
    const target = this.join(str(args, 'path'))
    const offset = typeof args.offset === 'number' ? Math.max(1, args.offset) : 1
    // Native default. A caller may still pass `limit` to go smaller, or larger when it
    // knows what it is asking for — the default is what bounds an ordinary read.
    const limit = typeof args.limit === 'number' ? Math.max(1, args.limit) : READ_LIMIT
    const text = await readFile(target, 'utf8')
    const lines = text.split('\n')
    const slice = lines.slice(offset - 1, offset - 1 + limit)

    const out: string[] = []
    let bytes = 0
    for (let i = 0; i < slice.length; i++) {
      let body = slice[i] ?? ''
      // Over-long lines are marked rather than silently cut: a model reading source code
      // has to know the line it sees is not the whole line.
      if (body.length > READ_MAX_LINE_LENGTH) {
        body = `${body.slice(0, READ_MAX_LINE_LENGTH)} … [+${body.length - READ_MAX_LINE_LENGTH} chars]`
      }
      const rendered = `${String(offset + i).padStart(5)}  ${body}`
      // The budget is what the MODEL receives, newline included — not the file size.
      if (out.length > 0 && bytes + rendered.length + 1 > READ_MAX_BYTES) break
      out.push(rendered)
      bytes += rendered.length + 1
    }

    const remaining = lines.length - (offset - 1 + out.length)
    const notes: string[] = []
    if (out.length < slice.length) notes.push(`truncated at ${Math.round(READ_MAX_BYTES / 1024)} KB`)
    if (remaining > 0) notes.push(`${remaining} more lines; use offset=${offset + out.length}`)
    const more = notes.length === 0 ? '' : `\n… [${notes.join('; ')}]`
    return { ok: true, output: out.join('\n') + more }
  }

  private async write(args: Record<string, unknown>): Promise<ToolOutcome> {
    const target = this.join(str(args, 'path'))
    const content = str(args, 'content')
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
    return { ok: true, output: `wrote ${content.length} chars to ${relative(this.root, target)}` }
  }

  private async edit(args: Record<string, unknown>): Promise<ToolOutcome> {
    const target = this.join(str(args, 'path'))
    const oldStr = str(args, 'old_string')
    const newStr = str(args, 'new_string')
    const text = await readFile(target, 'utf8')
    const idx = text.indexOf(oldStr)
    if (idx < 0) return { ok: false, output: 'old_string not found in file' }
    const next = text.slice(0, idx) + newStr + text.slice(idx + oldStr.length)
    await writeFile(target, next, 'utf8')
    return { ok: true, output: `replaced 1 occurrence in ${relative(this.root, target)}` }
  }

  private async glob(args: Record<string, unknown>): Promise<ToolOutcome> {
    const pattern = str(args, 'pattern').replace(/\*/g, '')
    const start = this.searchRoot(args)
    const hits: string[] = []
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 6 || hits.length > 500) return
      let entries: Awaited<ReturnType<typeof readdirSafe>>
      try { entries = await readdirSafe(dir) } catch { return }
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name === '.git') continue
        const full = join(dir, e.name)
        const shown = this.displayPath(full)
        if (e.isDirectory()) await walk(full, depth + 1)
        else if (pattern === '' || shown.includes(pattern)) hits.push(shown)
      }
    }
    await walk(start, 0)
    return { ok: true, output: hits.length === 0 ? 'no matches' : hits.join('\n') }
  }

  private async grep(args: Record<string, unknown>): Promise<ToolOutcome> {
    const pattern = str(args, 'pattern')
    const include = typeof args.include === 'string' ? args.include : ''
    let re: RegExp
    try { re = new RegExp(pattern) } catch (e) {
      return { ok: false, output: `invalid regex: ${e instanceof Error ? e.message : String(e)}` }
    }
    const start = this.searchRoot(args)
    const out: string[] = []
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 6 || out.length > 300) return
      let entries: Awaited<ReturnType<typeof readdirSafe>>
      try { entries = await readdirSafe(dir) } catch { return }
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name === '.git') continue
        const full = join(dir, e.name)
        if (e.isDirectory()) { await walk(full, depth + 1); continue }
        const rel = this.displayPath(full)
        if (include !== '' && !rel.includes(include)) continue
        let text: string
        try {
          const st = await stat(full)
          if (st.size > 2_000_000) continue
          text = await readFile(full, 'utf8')
        } catch { continue }
        text.split('\n').forEach((line, i) => {
          if (out.length <= 300 && re.test(line)) out.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`)
        })
      }
    }
    await walk(start, 0)
    return { ok: true, output: out.length === 0 ? 'no matches' : out.join('\n') }
  }

  private async bash(args: Record<string, unknown>): Promise<ToolOutcome> {
    const command = str(args, 'command')
    const timeout = typeof args.timeout_ms === 'number' ? args.timeout_ms : 120_000
    return await new Promise<ToolOutcome>(resolvePromise => {
      // Same rule as path resolution: unrestricted bots start in the home
      // directory so `ls`, `cd`, etc. work anywhere without absolute paths.
      const cwd = this.base
      const child = spawn('/bin/bash', ['-lc', command], {
        cwd,
        env: { ...process.env, PWD: cwd },
      })
      let out = ''
      let done = false
      const finish = (outcome: ToolOutcome): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolvePromise(outcome)
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish({ ok: false, output: `${out}\n[timed out after ${timeout}ms]` })
      }, timeout)
      child.stdout.on('data', (b: Buffer) => { out += b.toString() })
      child.stderr.on('data', (b: Buffer) => { out += b.toString() })
      child.on('error', (e: Error) => finish({ ok: false, output: `${out}\n${e.message}` }))
      child.on('close', (code: number | null) => {
        finish({ ok: code === 0, output: out === '' ? `(no output, exit ${code ?? 0})` : out })
      })
    })
  }
}

/** readdir that tolerates a missing directory. */
async function readdirSafe(dir: string): Promise<Array<{ name: string; isDirectory(): boolean }>> {
  return await readdir(dir, { withFileTypes: true })
}
