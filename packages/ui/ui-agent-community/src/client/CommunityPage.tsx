import { useCallback, useEffect, useRef, useState, createElement } from 'react'
import type { SetStateAction } from 'react'
import type {
  BotCommunitySnapshot,
  BotIdentity,
  BotRoom,
  BotRun,
} from '@dsh-plugin/agent-community'
import { Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ActiveTab, CommunityPageProps, ModelGroup } from './community/types.ts'
import { useCommunitySnapshot } from './community/useCommunitySnapshot.ts'
import { useGroupProposal } from './community/useGroupProposal.ts'
import { useRoomActions } from './community/useRoomActions.ts'
import { ConversationArea } from './community/ConversationArea.tsx'
import { RoomList } from './community/RoomList.tsx'
import { BotFormDialog } from './community/BotFormDialog.tsx'
import { ConfirmDeleteDialog } from './community/ConfirmDeleteDialog.tsx'
import { RoomSettingsDialog } from './community/RoomSettingsDialog.tsx'
import { css } from './styles.ts'
import { sectionHasUnread, totalUnread, unreadFor, planMarkRead } from './unread.ts'
import { setNavBadgeCount, setPanelVisible } from './navBadge.ts'
import { GroupProposalDialog } from './conversation/GroupProposalDialog.tsx'
import type { LedgerEntry } from './conversation/types.ts'

/**
 * The page's public surface, re-exported so the plugin entry point keeps importing it from
 * `CommunityPage.tsx`. The definitions themselves live in `community/types.ts`.
 */
export type {
  ActiveTab, CommunityDiagnostics, CommunityPageProps, CommunityRemote, ModelGroup,
} from './community/types.ts'

export function CommunityPage({ remote, diagnostics }: CommunityPageProps) {
  const [tab, setTab] = useState<ActiveTab>('bots')
  const [selectedId, setSelectedId] = useState<string>()
  /**
   * The room the USER picked, as opposed to the one the snapshot auto-selected.
   *
   * Switching tabs re-points `selectedId` at the first room of the new tab, and marking
   * that auto-selection as read cleared the dot the user never got to see — measured on a
   * group with one unread reply: the 群聊 tab dot was on (nav badge 1), and the moment the
   * 群聊 tab was opened the reply was marked read and the row badge never appeared.
   */
  const [userSelectedId, setUserSelectedId] = useState<string>()
  /**
   * When the user opened that room.
   *
   * The watermark may only cover messages that existed by then: a reply that arrives while
   * the room is on screen is still unread, and marking it read on the next poll is why the
   * count appeared frozen 「切到 dsh 未读没有改变」.
   */
  const selectedAtRef = useRef<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [formOpen, setFormOpen] = useState(false)

  // ── NOTICES ARE TRANSCRIPT ROWS, NOT A TOP STRIP ──────────────────────────────
  //
  // The coloured strip this page used to paint (`notice !== undefined && <div …>`) is gone: the user
  // asked for exactly what the transcript already does for 「已邀请 X 加入群聊」 — small grey text
  // between two hairlines, in the message area. That row is the ledger's `dispatch` entry, so a
  // notice is recorded THROUGH THE HOST (`noticeRoom`), which persists it on the room and pushes the
  // live row; the panel then renders it with the divider renderer it already has.
  //
  // Routing: `noticeFor` is built per selected room, and that is deliberate. `onCommand`/`onFork`
  // hold the callback of the render they started in, so a result that resolves AFTER the user
  // switched rooms still lands in the room the action was issued in — the alternative (reading the
  // current selection at resolution time) is how a model-change confirmation ends up in an unrelated
  // conversation.
  const noticeFor = useCallback((roomId: string | undefined, text: string) => {
    if (roomId === undefined || text === '') return
    // Best-effort: if the room is gone the host reports `stored: false` and there is nothing to
    // retry — the action the notice describes has already happened.
    void remote.noticeRoom({ roomId, text }).catch(() => undefined)
  }, [remote])

  /** The prop `ConversationArea` calls for model/permission/command results (signature unchanged). */
  const onNotice = useCallback(
    (text: string) => noticeFor(selectedId, text),
    [noticeFor, selectedId],
  )

  /**
   * The dialogs' older `setState`-shaped sink, kept because two of them still take it.
   *
   * `setNotice(undefined)` used to clear the strip and is now a no-op (there is nothing to clear);
   * a string becomes a row in the room that is open when it is reported.
   */
  const setNotice = useCallback((value?: SetStateAction<string | undefined>) => {
    if (typeof value === 'string') noticeFor(selectedId, value)
  }, [noticeFor, selectedId])

  // editingBot: if set, the create dialog is in edit mode for this bot. The dialog's own fields
  // live in `community/BotFormDialog.tsx`; the shell only holds which mode the form is in.
  const [editingBot, setEditingBot] = useState<BotIdentity | undefined>()

  const [defaultWorkspace, setDefaultWorkspace] = useState('')
  // Shared with the open room's composer, which is why the list is loaded by the dialog but
  // stored here.
  const [modelGroups, setModelGroups] = useState<ModelGroup[]>([])

  // Room settings dialog (separate from create). The dialog owns its edit buffer; the shell only
  // holds which room is open, because that is also what the row list highlights.
  const [roomSettingsOpen, setRoomSettingsOpen] = useState(false)
  const [editingRoom, setEditingRoom] = useState<BotRoom | undefined>()

  // P1-A: @mention bot picker (fallback textarea mode only)

  // Snapshot fetching, the poll schedule and the direct-room repair pass: see community/.
  const { snapshot, setSnapshot, error, setError, load, roomIdsKey } = useCommunitySnapshot({
    remote, tab, selectedId, setSelectedId,
  })
  // P1-4 / §5.4: the pending group proposal for the open DM room, its gate, and the
  // navigation that follows an answer — see community/useGroupProposal.ts.
  const proposalFlow = useGroupProposal({
    remote, snapshot, selectedId, roomIdsKey, setTab, setSelectedId, setNotice, load,
  })
  const proposal = proposalFlow.proposal
  const isBotMode = tab === 'bots'

  // ── unread ──────────────────────────────────────────────────────────────────
  const unread = snapshot?.unread
  const tabRooms = snapshot?.rooms ?? []
  const directTabUnread = sectionHasUnread(unread, tabRooms, 'direct')
  const groupTabUnread = sectionHasUnread(unread, tabRooms, 'group')
  const total = totalUnread(unread)

  // One number for the plugin's own sidebar entry, and one for the room on screen.
  useEffect(() => { setNavBadgeCount(total) }, [total])
  // Tell the sidebar entry whether this panel is the one in front: while it is, the badge is fed by
  // the snapshot above; while it is not, the plugin's background poller takes over (otherwise a
  // reply finishing behind another panel left a stale number on screen).
  useEffect(() => {
    setPanelVisible(true)
    return () => setPanelVisible(false)
  }, [])

  // ── STABLE SKILL CALLBACKS ──────────────────────────────────────────────────────────────────────
  // These used to be inline arrows recreated on every render, and the composer's skill effects list
  // them as dependencies: each snapshot tick therefore re-fetched a directory listing for EVERY skill
  // and the full body (up to 50 000 chars) of every skill — ~0.5 MB/s, permanently, while merely
  // sitting in a room. Stable identities make those effects run once per room instead.
  const loadSkillForRoom = useCallback(
    (name: string) => remote.loadSkill(selectedId ?? '', name),
    [remote, selectedId],
  )
  const listSkillFiles = useCallback(
    (dir: string) => remote.listSkillFiles(dir) as Promise<Array<{ path: string; isDir: boolean }>>,
    [remote],
  )

  /**
   * Advance a room's read water mark to a message the user has demonstrably seen.
   *
   * A REF, NOT STATE, because its callers are event handlers (send, and the effect below) — a
   * value captured in a handler's closure is one render behind. `upTo` is the message the caller
   * knows the user saw (the one just sent, as the RPC returned it), or `null` for "everything up
   * to the instant this room was opened".
   *
   * THE DECISION LIVES IN `planMarkRead` (./unread.ts), which also refuses a mark that is not
   * newer than the last one issued for this room. Issuing it again on every poll is what made the
   * entry badge and the group row blink: each answer deleted the room's unread entry locally for
   * one frame, the next poll restored it, and the cycle repeated for as long as the room stayed
   * open. Two details matter here:
   *
   *   · `lastMarkedRef` is per room and survives polls, so a room that cannot be marked any
   *     further (its unread replies arrived after it was opened) is asked about exactly once;
   *   · the local delete runs ONLY when the mark really covers the room (`clearsRoom`) and the
   *     host says it wrote it. A refused mark must not be painted as success — that lie is the
   *     flicker.
   *
   * Messages come from a ref, not from the effect's dependency list: `snapshot.messages` is a new
   * array on every poll, so depending on it re-ran this effect (with its RPC) 0.7–2.5×/s for ever.
   * No reload is issued here either — the snapshot poll reconciles within one interval, and the
   * extra full-snapshot RPC per mark was the other half of the request storm.
   */
  const messagesRef = useRef<BotCommunitySnapshot['messages']>([])
  messagesRef.current = snapshot?.messages ?? []
  const lastMarkedRef = useRef(new Map<string, string>())
  const markReadRef = useRef<((roomId: string, upTo: { id: string; createdAt: string } | null) => void) | undefined>(undefined)
  markReadRef.current = (roomId: string, upTo: { id: string; createdAt: string } | null): void => {
    const plan = planMarkRead({
      messages: messagesRef.current,
      roomId,
      openedAt: upTo === null ? selectedAtRef.current : undefined,
      upTo,
      lastMarkedAt: lastMarkedRef.current.get(roomId),
    })
    if (plan === undefined) return
    lastMarkedRef.current.set(roomId, plan.at)
    void remote.markRoomRead({ roomId, upToId: plan.upToId })
      .then((result: { readonly cleared?: boolean }) => {
        if (result?.cleared !== true || !plan.clearsRoom) return
        // Clear it HERE as well as on the host: the host's answer only reaches this panel on the
        // next snapshot poll, and until then the room the user is sitting in keeps showing the
        // unread dot it was opened to clear (「明明处在会话界面却依然显示未读」). Dropping the
        // entry locally makes the mark visible in the same frame; the poll then confirms it.
        setSnapshot((prev: BotCommunitySnapshot | undefined) => {
          if (prev === undefined || prev.unread?.[roomId] === undefined) return prev
          const nextUnread = { ...prev.unread }
          delete nextUnread[roomId]
          return { ...prev, unread: nextUnread }
        })
      })
      .catch(() => undefined)
  }

  const selectedUnread = unreadFor(unread, selectedId)
  /**
   * Stable handle on {@link markReadRef} for the composer's send path.
   *
   * Sending marks the room read up to the message just sent, and that mark must be recorded in the
   * SAME per-room bookkeeping as the effect's — otherwise the effect immediately asks for the older
   * "opened at" mark again, which is the request the host can only refuse.
   */
  const onMarkRead = useCallback((roomId: string, upTo: { id: string; createdAt: string } | null) => {
    markReadRef.current?.(roomId, upTo)
  }, [])
  /**
   * The room on screen is READ — selected means read, whichever way it got selected.
   *
   * The first version also required an explicit click, on the theory that auto-selection would hide
   * the dot before the user saw it. Live feedback killed that: while actually sitting in a bot's
   * conversation the dot stayed until the user switched away and back. The entry badge still tells
   * the "something happened elsewhere" story, and it only clears once every room has been seen.
   *
   * DEPENDENCIES ARE THE SELECTION AND THE NUMBER. `snapshot?.messages` used to be in this list,
   * and since every poll parses a fresh snapshot it re-ran the effect (and its RPC) for ever —
   * the request storm behind the blinking badges. Messages now reach `markReadRef` through a ref,
   * which is what the planner needs and nothing more.
   */
  useEffect(() => {
    // Only a room the user actually opened counts as read. An auto-selected room is on
    // screen, but the user never chose it — and marking it read is what made a group's
    // unread reply disappear the instant its tab was opened.
    if (selectedId === undefined || selectedId !== userSelectedId) return
    if (selectedUnread === 0) return
    markReadRef.current?.(selectedId, null)
  }, [selectedId, userSelectedId, selectedUnread])

  /**
   * Load the provider/model catalog for the SLASH MENU, not only for the form.
   *
   * `modelGroups` used to be filled by `BotFormDialog` when the create/edit dialog
   * opened, so until the user happened to open that dialog the composer's 模型 row
   * offered nothing but its `(使用默认)` placeholder — the menu looked broken because
   * it genuinely had no models to list. The catalog is a read-only, cheap RPC; asking
   * once when the panel mounts makes the menu complete without opening any dialog.
   *
   * Failures stay silent here: `modelGroups` empty is exactly the previous state, and
   * the row already says so. `BotFormDialog` still reports catalog errors in the form,
   * which is where a user can act on them.
   */
  useEffect(() => {
    let cancelled = false
    void remote.listModelGroups()
      .then(groups => { if (!cancelled && groups.length > 0) setModelGroups(groups) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [remote])

  // Stable reference — without useCallback this recreates every render, restarting the
  // polling interval inside BotConversationPanel on every state change.
  const ledgerFetcher = useCallback(
    (roomId: string, opts?: {
      beforeSequence?: number
      afterSequence?: number
      changedAfterSequence?: number
      limit?: number
    }) =>
      remote.listLedger(roomId, opts as {
        beforeSequence?: number
        afterSequence?: number
        changedAfterSequence?: number
        limit?: number
      }) as unknown as Promise<LedgerEntry[]>,
    [remote]
  )

  useEffect(() => { void load() }, [load])

  // P1-3: bottomRef scroll removed — useStickToBottom in LedgerView handles this

  // Native session embedding was removed on purpose: the panel is self-contained
  // and draws its own transcript + composer from the plugin's ledger. Calling
  // ensureRoomSession() here allocated a DSH session per room and dragged every
  // room back onto the native pipeline (with its archived-session lifecycle).

  // Load model groups when the create-bot form opens. The dialog reads them (it is what needs the
  // provider/model prefill); the page keeps them because the composer in the open room renders the
  // same list. See `community/BotFormDialog.tsx`.

  // Load default workspace from Host once, to pre-fill the workspace field
  useEffect(() => {
    if (defaultWorkspace !== '') return
    void (async () => {
      try {
        const result = await remote.getDefaults()
        setDefaultWorkspace(result.defaultWorkspace)
      } catch {
        // Not fatal; workspace field will remain empty and user can pick manually
      }
    })()
  }, [remote, defaultWorkspace])

  const visibleBots: BotIdentity[] = (snapshot?.bots ?? []) as BotIdentity[]
  // A direct room whose bot is gone is dead UI: the host retires these on startup,
  // but filtering here makes a deleted bot's conversation disappear immediately
  // instead of lingering until the next restart.
  const aliveBotIds = new Set(visibleBots.map(b => b.id))
  const visibleRooms: BotRoom[] = snapshot?.rooms.filter(r => {
    if (isBotMode) {
      return r.directBotId !== undefined && aliveBotIds.has(r.directBotId)
    }
    return r.directBotId === undefined
  }) ?? []
  const selectedRoom = visibleRooms.find(r => r.id === selectedId)
  // Skills for the selected room, refreshed whenever the room changes.
  const [skills, setSkills] = useState<Array<{ id: string; name: string; description: string; path: string }>>([])
  /**
   * Why the skill list is empty. A swallowed rejection is indistinguishable from
   * "the host found no skills", which made this impossible to diagnose from the UI.
   */
  const [skillsError, setSkillsError] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (selectedId === undefined) { setSkills([]); setSkillsError(undefined); return }
    let live = true
    setSkillsError(undefined)
    void remote.listSkills(selectedId)
      .then(list => { if (live) { setSkills(list); setSkillsError(undefined) } })
      .catch((e: unknown) => {
        if (live) { setSkills([]); setSkillsError(e instanceof Error ? e.message : String(e)) }
      })
    return () => { live = false }
  }, [selectedId, remote])
  const runs: BotRun[] = (snapshot?.runs ?? []) as BotRun[]
  // Clear / stop-all / delete: the state they own and the three handlers live in
  // community/useRoomActions.ts.
  const roomActions = useRoomActions({
    remote, selectedId, selectedRoom, runs,
    snapshotMessages: snapshot?.messages ?? [],
    busy, setBusy, setError, load,
  })
  const confirmDelete = roomActions.confirmDelete
  const diag = diagnostics?.()

  function openCreateForm() {
    setEditingBot(undefined)
    setFormOpen(true)
  }

  function openEditForm(bot: BotIdentity) {
    setEditingBot(bot)
    setModelGroups([])
    setFormOpen(true)
  }

  function openRoomSettings(room: BotRoom) {
    setEditingRoom(room)
    setRoomSettingsOpen(true)
  }

  function closeForm() {
    setFormOpen(false)
    setEditingBot(undefined)
  }

  function closeRoomSettings() {
    setRoomSettingsOpen(false)
    setEditingRoom(undefined)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* RPC status bar */}
      {diag !== undefined && diag.status !== 'ready' && (
        <div style={{ flex: 'none', padding: '8px 16px', fontSize: 12, lineHeight: '18px', borderBottom: '0.5px solid var(--dsw-alias-border-l2)', background: diag.status === 'failed' ? 'var(--dsw-alias-bg-layer-1)' : 'var(--dsw-alias-bg-module-platform)', color: diag.status === 'failed' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)' }}>
          RPC {diag.status === 'failed' ? '不可用' : '连接中'}：{diag.detail}
        </div>
      )}
      {/* The notice strip used to live here. It is gone on purpose: every notice is now a
          `dispatch` row inside the open room's transcript (see `onNotice` above), which is what
          the user asked for — 「放在消息区，用灰色小字显示…带分割线」. */}

      <div
        className={css.page}
        style={{ flex: '1 1 auto', minHeight: 0 }}
      >
        <RoomList
          tab={tab}
          onSelectTab={(next) => { setTab(next); setUserSelectedId(undefined); setSelectedId(undefined) }}
          bots={visibleBots}
          rooms={visibleRooms}
          selectedId={selectedId}
          unread={unread}
          directTabUnread={directTabUnread}
          groupTabUnread={groupTabUnread}
          onSelectRoom={(id) => { selectedAtRef.current = new Date().toISOString(); setUserSelectedId(id); setSelectedId(id) }}
          onCreate={openCreateForm}
          onEditBot={openEditForm}
          onOpenRoomSettings={openRoomSettings}
          onDeleteBot={(bot) => roomActions.requestDelete({ type: 'bot', id: bot.id, name: bot.name })}
          onDeleteRoom={(room) => roomActions.requestDelete({ type: 'room', id: room.id, name: room.name })}
        />

        {/* Right sidebar — where the native app shows its tool panels. Opening a
            row in the left list fills this column instead of a modal. */}
        {/* Content area */}

        <div className={css.content}>
          <ConversationArea
            room={selectedRoom}
            roomId={selectedId}
            bots={visibleBots}
            runs={runs}
            modelGroups={modelGroups}
            tasks={snapshot?.tasks ?? []}
            skills={skills}
            skillsError={skillsError}
            error={error}
            isBotMode={isBotMode}
            remote={remote}
            onLoadSkill={loadSkillForRoom}
            onListSkillFiles={listSkillFiles}
            listLedger={ledgerFetcher}
            onNotice={onNotice}
            onMarkRead={onMarkRead}
            onDetectProposal={proposalFlow.detectProposal}
            onReload={load}
            onOpenBotRoom={(id) => { setTab('bots'); selectedAtRef.current = new Date().toISOString(); setUserSelectedId(id); setSelectedId(id) }}
          />
        </div>
    </div>

      {/* Create / Edit dialog — native Modal chrome, tabs replicated from SegmentedTabs */}
      {formOpen && (
        <BotFormDialog
          isBotMode={isBotMode}
          editingBot={editingBot}
          visibleBots={visibleBots}
          busy={busy}
          setBusy={setBusy}
          remote={remote}
          modelGroups={modelGroups}
          setModelGroups={setModelGroups}
          defaultWorkspace={defaultWorkspace}
          setNotice={setNotice}
          onClose={closeForm}
          onSaved={() => { closeForm(); void load() }}
        />
      )}

      {/* Room settings dialog */}
      {roomSettingsOpen && editingRoom !== undefined && (
        <RoomSettingsDialog
          room={editingRoom}
          bots={visibleBots}
          busy={busy}
          setBusy={setBusy}
          remote={remote}
          onClose={closeRoomSettings}
          onSaved={() => { closeRoomSettings(); void load() }}
        />
      )}

      {/* Group proposal dialog (§5.4). `key` on the proposal id so a second proposal
          remounts the dialog and its countdown instead of inheriting the first one's
          edited name and pending state. */}
      {proposal !== undefined && (
        <GroupProposalDialog
          key={proposal.id}
          proposal={proposal}
          bots={visibleBots.map(b => ({
            id: b.id,
            name: b.name,
            description: b.description ?? '',
            avatarSeed: b.avatar.seed,
          }))}
          onConfirm={proposalFlow.onConfirm}
          onDecline={proposalFlow.onDecline}
          onConfirmed={proposalFlow.onConfirmed}
          onDeclined={proposalFlow.onDeclined}
        />
      )}

      {/* Delete confirmation dialog */}
      {confirmDelete !== undefined && (
        <ConfirmDeleteDialog
          target={confirmDelete}
          busy={busy}
          onCancel={roomActions.cancelDelete}
          onConfirm={() => void roomActions.handleConfirmDelete()}
        />
      )}
    </div>
  )
}
