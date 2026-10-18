/**
 * ComposerArea — full input area with slash commands, @mention, attachments,
 * queue dock, approval takeover, and send button.
 */
import { useState, useRef, useCallback, useEffect } from 'react'
import { clearDraft, getDraft, setDraft } from '../drafts.ts'
import type { ReactNode } from 'react'
import type { AttachmentItem, InFlightMessage } from './types.ts'
import type { LedgerEntry } from './types.ts'
import { IconSendOutlineRegular, IconPlusOutlineMedium } from './NativeIcons.tsx'
import { Tooltip } from './Tooltip.tsx'
import { renderHighlighted } from './highlight.tsx'
import { AttachmentBar } from './AttachmentBar.tsx'
import { SlashMenu, buildSlashCommands } from './SlashMenu.tsx'
import type { SlashCommand } from './SlashMenu.tsx'
import { MentionMenu } from './MentionMenu.tsx'
import { QueueDock } from './QueueDock.tsx'
import { ApprovalCard } from './ApprovalCard.tsx'

export interface BotInfo { id: string; name: string }

export interface ComposerProps {
  roomId: string
  isGroup: boolean
  bots: BotInfo[]
  isRunning: boolean
  pendingApproval?: LedgerEntry | undefined
  queue: InFlightMessage[]
  modelGroups: Array<{ id: string; name?: string; label?: string; models: Array<{ id: string; name?: string }> }>
  /** Re-read Settings' model catalog when the model menu opens. */
  onRefreshModels: () => void
  /** Skills available to the room's bot. */
  skills?: ReadonlyArray<{ id: string; name: string; description: string; path: string }> | undefined
  /** Load a skill's full text for direct invocation. */
  onLoadSkill: (name: string) => Promise<{ name: string; content: string } | undefined>
  /** Shallow listing of a skill directory, to avoid filesystem exploration. */
  onListSkillFiles: (dir: string) => Promise<Array<{ path: string; isDir: boolean }>>
  /** Why the skill list is empty, when the RPC failed. */
  skillsError?: string | undefined
  /**
   * `text` is exactly what the user typed; `modelPayload` additionally carries the
   * expanded `/skill` bodies. They are kept apart so the panel can render the draft
   * while the model still receives the instructions.
   */
  onSend: (text: string, modelPayload: string, attachments: AttachmentItem[], mentions: string[]) => void
  onStop: () => void
  onApprove: (callId: string) => void
  onReject: (callId: string) => void
  onEditQueue: (id: string, text: string) => void
  onRemoveQueue: (id: string) => void
  onSteerQueue: (id: string) => void
  onCommand: (cmdId: string, subId?: string) => void
}




/**
 * Cap the skill body handed to the model.
 *
 * The number is the native `read` ceiling (50 KB / 2000 lines), per §21.6 decision 1:
 * a skill the host would happily read back in full must not be silently halved when
 * the user invokes it by name. The previous 24 KB cap cut
 * `ui-ux-pro-max/SKILL.md` (47,257 bytes) roughly in half — which is exactly what the
 * user reported as "the skill gets truncated". The cause was this constant, not the
 * read tool.
 *
 * A cap stays because an unbounded injection lets a very large skill crowd out the
 * user's own request, and the resource listing above still tells the model which
 * files to read when it needs the remainder. The panel always shows the full skill;
 * only the model-facing copy is bounded.
 */
const MAX_SKILL_BODY_CHARS = 50_000

/**
 * Attachment caps, mirrored from the host (`packages/core/agent-community/src/attachments.ts`):
 * at most 5 files totalling 8 MB per message. Enforced here as well so the composer can SAY
 * what is wrong — the host rejects an over-limit message after the draft and the chips have
 * already been cleared, which to the user looks like the message simply vanished.
 */
const MAX_ATTACH_FILES = 5
const MAX_ATTACH_TOTAL_BYTES = 8 * 1024 * 1024

/** Image formats the chip row can preview. Any other image rides as a plain file. */
const PREVIEWABLE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${Math.round(bytes / (1024 * 1024))} MB`
}

function clipSkillBody(body: string): string {
  if (body.length <= MAX_SKILL_BODY_CHARS) return body
  const dropped = body.length - MAX_SKILL_BODY_CHARS
  return `${body.slice(0, MAX_SKILL_BODY_CHARS)}\n\n… [技能正文已截断 ${dropped} 字符；如需其余内容，从上面的技能目录读取对应文件]`
}

/**
 * Expand `/skill` gestures into the host's canonical `<skill_content>` block.
 *
 * Timing matters: this runs at SUBMIT, in one synchronous pass, so the skill body
 * travels with the message instead of costing the bot an extra `skill` tool round
 * trip. Observed on a real turn, letting the model fetch the skill itself took
 * 127s across five tool rounds versus ~3s for an ordinary reply.
 *
 * Token rules copied from the conversation bundle's `scanTextRefs`:
 *   · the `/` must start the draft or follow whitespace (`x/name` never matches)
 *   · the name is `[\w-]+` and never crosses a newline
 *   · the token must end at whitespace or the draft end, so `/plan.md` is prose
 *   · the name must be an exact member of the known-skill list
 */
const SKILL_GESTURE_RE = /(^|\s)(\/)([\w-]+)/g

export function expandSkillGestures(
  draft: string,
  skills: ReadonlyArray<{ id: string; name: string }>,
  bodies: ReadonlyMap<string, string>,
  /** Absolute directory of each skill, so the hint is a real path. */
  dirs: ReadonlyMap<string, string> = new Map(),
  /** Shallow listing of each skill directory, so no exploration is needed. */
  listings: ReadonlyMap<string, string> = new Map(),
): string {
  const listingOf = (n: string): string => listings.get(n) ?? ''
  if (draft === '' || skills.length === 0) return draft
  const known = new Set(skills.map(sk => sk.name))
  const found: string[] = []
  SKILL_GESTURE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SKILL_GESTURE_RE.exec(draft)) !== null) {
    const name = m[3] ?? ''
    if (!known.has(name)) continue
    const after = draft.slice(m.index + m[0].length)
    if (after !== '' && !/^\s/.test(after)) continue
    if (!found.includes(name)) found.push(name)
  }
  if (found.length === 0) return draft

  const blocks: string[] = []
  for (const name of found) {
    const content = bodies.get(name)
    if (content === undefined) continue
    blocks.push(
      `<skill_content name="${escapeXmlAttr(name)}">\n`
      + '<skill_resources>\n'
      // The REAL directory, never the skill name: emitting the name made the model
      // resolve it as a relative path, so it searched outside its workspace and
      // tripped a macOS folder-access prompt.
      + `Base directory for this skill: ${escapeXmlText(dirs.get(name) ?? name)}\n`
      + 'Resolve any referenced path against that absolute directory.\n'
      + listingOf(name)
      + '</skill_resources>\n\n'
      + '<skill_instructions>\n'
      + clipSkillBody(content)
      + '\n</skill_instructions>\n'
      + '</skill_content>',
    )
  }
  if (blocks.length === 0) return draft
  return `${blocks.join('\n\n')}\n\n${draft}`
}

/** Escape text for an XML-ish body (not an attribute). */
function escapeXmlText(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeXmlAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}


export function ComposerArea({
  roomId, isGroup, bots, isRunning, pendingApproval, queue,
  modelGroups, onRefreshModels, onSend, onStop, onApprove, onReject,
  onEditQueue, onRemoveQueue, onSteerQueue, onCommand, skills = [], onLoadSkill, onListSkillFiles, skillsError,
}: ComposerProps) {
  // The draft belongs to the ROOM: this component unmounts when the user switches rooms, and its
  // local text used to vanish with it (reported as "输入框中的内容消失了").
  const [text, setTextState] = useState(() => getDraft(roomId))
  const setText = useCallback((next: string) => {
    setTextState(next)
    setDraft(roomId, next)
  }, [roomId])
  // A different room can be rendered without remounting this component (same panel, new roomId).
  useEffect(() => { setTextState(getDraft(roomId)) }, [roomId])
  const [attachments, setAttachments] = useState<AttachmentItem[]>([])
  /** Why the last pick was refused; shown above the composer, cleared on a good pick. */
  const [attachError, setAttachError] = useState<string | undefined>(undefined)
  const [mentions, setMentions] = useState<string[]>([])
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  const [slashSubmenu, setSlashSubmenu] = useState<string | null>(null)
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  /**
   * The composer's own file input, mounted ALWAYS.
   *
   * It used to live inside `AttachmentBar`, which the composer renders only when
   * `attachments.length > 0` — so the 文件 command row could not open a picker that did
   * not exist yet, and the first attachment could never be added at all. Keeping it
   * here (hidden, unconditional) removes that cycle.
   */
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Mirrors the textarea's scroll so the highlight layer stays aligned.
  const highlightRef = useRef<HTMLDivElement>(null)
  const syncHighlightScroll = useCallback(() => {
    const ta = inputRef.current
    const hl = highlightRef.current
    if (ta === null || hl === null) return
    hl.scrollTop = ta.scrollTop
    hl.scrollLeft = ta.scrollLeft
  }, [])
  const isComposing = useRef(false)

  // Names eligible for the reference highlight — same lexicon the send path uses.
  const skillNames = new Set(skills.map(sk => sk.name))

  const commands = buildSlashCommands(modelGroups, skills, skillsError)

  // Skill bodies are preloaded so `handleSend` can expand a gesture synchronously.
  // Fetching them at submit would either block the click or reintroduce an async
  // hop in the send path.
  const [skillBodies, setSkillBodies] = useState<Map<string, string>>(() => new Map())
  // Absolute skill directories, taken from each discovered SKILL.md path.
  const skillDirs = ((): Map<string, string> => {
    const m = new Map<string, string>()
    for (const sk of skills) {
      const slash = sk.path.lastIndexOf('/')
      if (slash > 0) m.set(sk.name, sk.path.slice(0, slash))
    }
    return m
  })()
  // Shallow listing per skill directory, fetched once, so the model reads the files
  // it needs directly instead of exploring with bash/glob (slow, and it wandered
  // outside the workspace).
  const [skillListings, setSkillListings] = useState<Map<string, string>>(() => new Map())
  useEffect(() => {
    const dirs = [...skillDirs.entries()]
    if (dirs.length === 0) { setSkillListings(new Map()); return }
    let live = true
    void Promise.all(dirs.map(([name, dir]) =>
      onListSkillFiles(dir)
        .then(entries => {
          if (entries.length === 0) return [name, ''] as const
          const lines = entries.slice(0, 40).map(e => `- ${e.path}${e.isDir ? '/' : ''}`).join('\n')
          return [name, `Files in this skill (read as needed):\n${lines}\n`] as const
        })
        .catch(() => [name, ''] as const),
    )).then(pairs => {
      if (!live) return
      const m = new Map<string, string>()
      for (const [n, text] of pairs) if (text !== '') m.set(n, text)
      setSkillListings(m)
    })
    return () => { live = false }
  }, [skills, onListSkillFiles])
  useEffect(() => {
    if (skills.length === 0) { setSkillBodies(new Map()); return }
    let live = true
    void Promise.all(skills.map(sk =>
      onLoadSkill(sk.name).then(s => [sk.name, s?.content] as const).catch(() => [sk.name, undefined] as const),
    )).then(entries => {
      if (!live) return
      const m = new Map<string, string>()
      for (const [name, content] of entries) if (content !== undefined) m.set(name, content)
      setSkillBodies(m)
    })
    return () => { live = false }
  }, [skills, onLoadSkill])

  // Auto-resize textarea
  function autoResize() {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value
    setText(val)
    autoResize()

    if (isComposing.current) return

    // Slash command detection
    const slashMatch = val.match(/^\/([a-z]*)$/i)
    if (slashMatch !== null) {
      setSlashQuery(slashMatch[1] ?? '')
      // Typing "/" is an open from scratch: never inherit a previous sub-directory.
      setSlashSubmenu(null)
      // Opening the menu re-reads the catalog, so a provider/model added or renamed in
      // DSH Settings is selectable without remounting the panel.
      if (!slashOpen) onRefreshModels()
      setSlashOpen(true)
      setMentionOpen(false)
    } else {
      closeSlashMenu()
    }

    // @mention detection (group only)
    if (isGroup) {
      const atMatch = val.match(/@([a-zA-Z一-龥]*)$/)
      if (atMatch !== null) {
        setMentionQuery(atMatch[1] ?? '')
        setMentionOpen(true)
      } else {
        setMentionOpen(false)
      }
    }
  }

  // The send path reads skills/skillBodies/skillDirs/skillListings, which arrive in effects AFTER
  // the last keystroke. Listing them as dependencies would rebuild this callback on every update, so
  // they are mirrored into a ref instead — the pattern GroupProposalDialog already uses. Without it a
  // `/skill` gesture could be sent with an empty map, i.e. as a bare `/name` with no skill body.
  const skillStateRef = useRef({ skills, skillBodies, skillDirs, skillListings })
  useEffect(() => {
    skillStateRef.current = { skills, skillBodies, skillDirs, skillListings }
  }, [skills, skillBodies, skillDirs, skillListings])

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed && attachments.length === 0) return
    // Resolve `/skill` gestures ONCE, here, before sending — the same point in the
    // flow where the host expands a skill reference. Doing it here rather than
    // letting the bot call the `skill` tool removes one to three extra model round
    // trips per skill, which measured at 127s versus ~3s for a normal reply.
    const { skills: sk, skillBodies: bodies, skillDirs: dirs, skillListings: listings } = skillStateRef.current
    const modelPayload = expandSkillGestures(trimmed, sk, bodies, dirs, listings)
    onSend(trimmed, modelPayload, attachments, mentions)
    clearDraft(roomId)
    setTextState('')
    setAttachments([])
    setAttachError(undefined)
    setMentions([])
    closeSlashMenu()
    setMentionOpen(false)
    if (inputRef.current) { inputRef.current.style.height = 'auto' }
  }, [text, attachments, mentions, onSend])

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (isComposing.current) return
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      if (slashOpen || mentionOpen) return
      e.preventDefault()
      if (isRunning) {
        // Queue or steer based on current mode (default: queue)
        if (text.trim()) handleSend()
      } else {
        handleSend()
      }
    }
    // Double Esc to stop
    if (e.key === 'Escape' && isRunning) {
      onStop()
    }
  }

  // Paste images
  function handlePaste(e: React.ClipboardEvent) {
    const files = Array.from(e.clipboardData.files).filter(f => f.type.startsWith('image/'))
    if (files.length === 0) return
    e.preventDefault()
    addAttachments(files)
  }

  // Drag-drop
  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) addAttachments(files)
  }

  /**
   * Add picked / pasted / dropped files to the chip row.
   *
   * The caps mirror the host's (`attachments.ts`), and every refusal produces a visible
   * line: a silently dropped file looks exactly like a broken picker, and the previous
   * `else if` here did drop one class of them (an image type the chip row cannot
   * preview) without a word.
   */
  function addAttachments(files: File[]) {
    const MAX_IMG = 20 * 1024 * 1024
    const problems: string[] = []
    const items: AttachmentItem[] = []
    // Counted as the loop goes so the remaining budget is real even though the image
    // reads complete asynchronously.
    let count = attachments.length
    let total = attachments.reduce((sum, a) => sum + a.size, 0)
    for (const file of files) {
      if (count >= MAX_ATTACH_FILES) {
        problems.push(`最多只能添加 ${MAX_ATTACH_FILES} 个附件`)
        break
      }
      if (total + file.size > MAX_ATTACH_TOTAL_BYTES) {
        problems.push(`附件总大小不能超过 ${formatBytes(MAX_ATTACH_TOTAL_BYTES)}`)
        continue
      }
      const id = Math.random().toString(36).slice(2)
      if (PREVIEWABLE_IMAGE_TYPES.includes(file.type)) {
        if (file.size > MAX_IMG) {
          problems.push(`图片过大：${file.name}（上限 ${formatBytes(MAX_IMG)}）`)
          continue
        }
        count += 1
        total += file.size
        const reader = new FileReader()
        reader.onload = ev => {
          setAttachments(prev => [...prev, { id, kind: 'image', name: file.name, size: file.size, dataUrl: ev.target?.result as string, file }])
        }
        reader.readAsDataURL(file)
      } else if (file.type.startsWith('image/')) {
        problems.push(`不支持的图片格式：${file.name}（${file.type}）`)
      } else {
        count += 1
        total += file.size
        items.push({ id, kind: 'file', name: file.name, size: file.size, file })
      }
    }
    if (items.length > 0) setAttachments(prev => [...prev, ...items])
    setAttachError(problems.length > 0 ? problems[0] : undefined)
  }

  function selectSlashCommand(cmd: SlashCommand, subId?: string) {
    // ── THE 文件 ROW OPENS THE PICKER ITSELF ────────────────────────────────────
    //
    // Both the menu and the file input live in this component, so there is no reason to
    // route the request through the page and back. Routing it (an earlier attempt) also
    // meant a counter prop threaded through two components purely to reopen a picker
    // that is already mounted right here.
    //
    // This branch runs BEFORE the draft is cleared below: a user who types a message and
    // then attaches a file must still have that message when the picker closes.
    if (cmd.id === 'file') {
      closeSlashMenu()
      openFilePicker()
      return
    }
    closeSlashMenu()
    clearDraft(roomId)
    setTextState('')
    // Skills are flattened rows with a `skill:<name>` id. Matching the native skill
    // source, picking one inserts the `/name ` gesture and nothing else — the body is
    // never injected here. The bot sees the gesture and loads the skill through its
    // own `skill` tool, whose result carries the instructions.
    const skillName = cmd.id.startsWith('skill:') ? cmd.id.slice('skill:'.length) : undefined
    if (skillName !== undefined && skillName !== 'none') {
      // ── REPLACE THE TRIGGER, DO NOT APPEND TO IT ────────────────────────────────
      //
      // The draft still holds the `/` that OPENED the menu (the menu is matched against
      // `/^\/([a-z]*)$/`), so appending produced 「/ /banner-design 」 and the bot received
      // that doubled slash — the user saw it in the transcript and reported it as
      // 「会多出一个/，显示在技能前面」. The gesture replaces the trigger and everything
      // typed after it (the same text that narrowed the list).
      //
      // Built from the rendered value, not a functional updater: setText also writes the
      // room's draft, and a side effect inside a state updater can run twice.
      const trigger = text.lastIndexOf('/')
      const before = trigger < 0 ? text : text.slice(0, trigger)
      setText(`${before}${before !== '' && !before.endsWith(' ') ? ' ' : ''}/${skillName} `)
      inputRef.current?.focus()
      return
    }
    onCommand(cmd.id, subId)
  }

  /**
   * Close the slash menu — the ONLY way it is closed.
   *
   * WHY ONE FUNCTION: the submenu is a SEPARATE piece of state from "is the menu open",
   * and the two used to drift. The previous fix reset the submenu inside the "+"
   * handler only, so the same stale submenu came back through every other exit: Esc, or
   * picking a top-level row, left `slashSubmenu` armed — and the user's next "open the
   * menu" therefore landed straight in 模型/权限 instead of the first page. Reported
   * exactly like that: 「选择模型或者权限，没有做出选择，再次打开…直接出现对应的模型或者权限选项」.
   *
   * Closing the menu and forgetting which sub-directory it was in are one act, so they
   * happen in one place; every close site calls this instead of `setSlashOpen(false)`.
   */
  function closeSlashMenu() {
    setSlashOpen(false)
    setSlashSubmenu(null)
  }

  /** Open the OS file picker. Shared by the 文件 row and the + → 文件 path. */
  function openFilePicker() {
    const input = fileInputRef.current
    if (input === null) return
    input.value = ''
    input.click()
  }

  function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (files.length > 0) addAttachments(files)
  }

  function selectMention(bot: BotInfo) {
    // Replace the @query at end of text with @botname chip
    const newText = text.replace(/@[a-zA-Z一-龥]*$/, `@${bot.name} `)
    setText(newText)
    setMentions(prev => [...prev, bot.id])
    setMentionOpen(false)
    inputRef.current?.focus()
  }

  // Send button state
  const hasContent = text.trim().length > 0 || attachments.length > 0
  let sendLabel = '发送消息'
  let sendVariant: 'send' | 'stop' | 'queue' = 'send'
  if (isRunning && !hasContent) { sendVariant = 'stop'; sendLabel = '停止生成' }
  else if (isRunning && hasContent) { sendVariant = 'queue'; sendLabel = '排队发送' }

  // Approval takeover
  if (pendingApproval !== undefined) {
    return (
      <div>
        <ApprovalCard
          entry={pendingApproval}
          onApprove={onApprove}
          onReject={onReject}
        />
      </div>
    )
  }

  return (
    <div
      className="ac-composer-root"
      onDrop={handleDrop}
      onDragOver={e => e.preventDefault()}
    >
      {/* The composer's own picker: always mounted, so the 文件 command row and the
          attachment chips both have something to open. Kept out of AttachmentBar,
          which only renders once an attachment exists. */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,.txt,.md,.json,.csv,.pdf"
        style={{ display: 'none' }}
        onChange={onFilePicked}
      />
      {/* Queue dock */}
      <QueueDock queue={queue} onEdit={onEditQueue} onRemove={onRemoveQueue} onSteer={onSteerQueue} />

      {/* Attachments */}
      {attachError !== undefined && (
        <div style={{
          padding: '8px 16px 0', fontSize: 12,
          color: 'var(--dsw-alias-state-error-primary)',
        }}>{attachError}</div>
      )}
      {attachments.length > 0 && (
        <AttachmentBar
          attachments={attachments}
          onPick={openFilePicker}
          onRemove={id => setAttachments(prev => prev.filter(a => a.id !== id))}
        />
      )}

      {/* Native composer card: radius-panel, specific-input-major fill, elevated. */}
      <div className="ac-composer-card">
        {/* Slash menu */}
        {slashOpen && (
          <SlashMenu
            query={slashQuery}
            commands={commands}
            onSelect={selectSlashCommand}
            onClose={closeSlashMenu}
            openSubmenu={slashSubmenu}
            setOpenSubmenu={setSlashSubmenu}
          />
        )}
        {/* Mention menu */}
        {mentionOpen && isGroup && (
          <MentionMenu
            query={mentionQuery}
            bots={bots}
            onSelect={selectMention}
            onClose={() => setMentionOpen(false)}
          />
        )}

        {/*
          Reference highlight layer.

          A textarea cannot colour part of its own text, so the visible glyphs come
          from this overlay while the textarea's text is transparent (its caret still
          shows). Both layers must share identical font, padding and line-height, and
          the overlay scroll is mirrored from the textarea, or the highlight drifts.
        */}
        <div className="ac-composer-input-wrap">
          <div className="ac-composer-highlight" ref={highlightRef} aria-hidden="true">
            {renderHighlighted(text, skillNames)}
            {'\n'}
          </div>
          <textarea
            ref={inputRef}
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onScroll={syncHighlightScroll}
            onCompositionStart={() => { isComposing.current = true }}
            onCompositionEnd={() => { isComposing.current = false }}
            placeholder={
              isRunning ? '排队发送…'
              : isGroup ? '发消息，/ 调用指令，@ 提及 Bot'
              : '发消息或创建任务，/ 调用指令，@ 文件或对话'
            }
            className="ac-composer-input"
            style={{ maxHeight: 'var(--dsh-composer-text-max-height)',
                     fontFamily: 'var(--dsw-font-family)', overflow: 'auto' }}
            rows={1}
          />
        </div>

      {/* Toolbar */}
      <div className="ac-composer-row">
        {/* Left: the "+" selector chip. */}
        <div className="ac-composer-tools">
          <PlusButton
            active={slashOpen}
            onClick={() => {
              setSlashQuery('')
              // Reopening always starts at the TOP level. `closeSlashMenu` already
              // clears the submenu; this keeps that true even if the menu was closed by
              // something that bypassed it (e.g. the composer unmounted mid-submenu).
              setSlashSubmenu(null)
              if (!slashOpen) onRefreshModels()
              setSlashOpen(v => !v)
            }}
          />
        </div>

        {/* Right: send / stop. */}
        <div className="ac-composer-trailing">
          <SendButton
            variant={sendVariant}
            label={sendLabel}
            disabled={sendVariant === 'send' && !hasContent}
            onClick={sendVariant === 'stop' ? onStop : handleSend}
          />
        </div>
      </div>
      </div>
    </div>
  )
}

function SendButton({ variant, label, disabled, onClick }: {
  variant: 'send' | 'stop' | 'queue'
  label: string
  disabled: boolean
  onClick: () => void
}) {
  const isStop = variant === 'stop'
  const isQueue = variant === 'queue'
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={isStop ? '停止生成（Esc Esc）' : label}
      style={{
        height: 32, padding: '0 14px',
        borderRadius: 'var(--dsw-radius-sm, 4px)',
        border: 'none',
        background: disabled
          ? 'var(--dsw-alias-button-floating-fill)'
          : isStop
          ? 'var(--dsw-alias-state-error-primary)'
          : 'var(--dsw-alias-state-business-primary, #3b82f6)',
        color: disabled ? 'var(--dsw-alias-label-tertiary)' : '#fff',
        fontSize: 13, fontWeight: 500,
        cursor: disabled ? 'default' : 'pointer',
        display: 'flex', alignItems: 'center', gap: 6,
        transition: 'background 120ms',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {isStop ? <StopIcon /> : isQueue ? <QueueIcon /> : <SendIcon />}
      {label}
    </button>
  )
}

// PlusButton with hover + active state to match DSH toolbar buttons
function PlusButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  // Native control: 28px round selector chip, plus artwork at 14px, and a Tooltip
  // placed above with a 500ms delay (`input.commands`).
  return (
    <Tooltip label="添加文件或调用指令" side="top" delayMs={500}>
      <button
        type="button"
        aria-label="添加文件或调用指令"
        aria-haspopup="listbox"
        aria-expanded={active}
        onClick={onClick}
        className="ac-composer-add"
      >
        <IconPlusOutlineMedium size={14} />
      </button>
    </Tooltip>
  )
}

function SendIcon() {
  // Verified native artwork (IconSendOutlineArtwork).
  return <IconSendOutlineRegular size={18} />
}

function StopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <rect x="3" y="3" width="10" height="10" rx="2" />
    </svg>
  )
}

function QueueIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M3 8h10M3 4h10M3 12h6" />
    </svg>
  )
}
