/**
 * ConversationArea — the page's content column: the open room's conversation, or the
 * "pick something on the left" state when no room is selected.
 *
 * Presentational on purpose, like `RoomList`: it owns no data and calls no RPC of its own
 * beyond the ones the panel is handed. The panel wiring (room/bot/skill/ledger props and the
 * whole callback set) lives here so the shell only has to supply the current values. Every
 * callback the shell passes in is a `useCallback` from the shell — the panel's skill effects
 * list them as dependencies, so identity stability is the shell's job.
 */
import type { BotCommunitySnapshot, BotIdentity, BotRoom, BotRun } from '@dsh-plugin/agent-community'
import { useState } from 'react'
import type { CommunityRemote, ModelGroup } from './types.ts'
import { describe } from './types.ts'
import { css } from '../styles.ts'
import { GoalStrip } from './GoalStrip.tsx'
import { BotConversationPanel } from '../conversation/BotConversationPanel.tsx'
import type { BotConversationPanelProps } from '../conversation/BotConversationPanel.tsx'
import type { AttachmentItem } from '../conversation/types.ts'

/** One row of the snapshot's task board; the panel's `tasks` prop is narrowed from these. */
type SnapshotTask = BotCommunitySnapshot['tasks'][number]

export interface ConversationAreaProps {
  /** The room on screen. `undefined` draws the empty state instead of a panel. */
  room: BotRoom | undefined
  /** The selected room id; equals `room.id` whenever `room` is set. */
  roomId: string | undefined
  /** The whole directory — the panel resolves the room's own members from it. */
  bots: readonly BotIdentity[]
  /** This room's runs (already filtered by the shell), for the panel's live-run tests. */
  runs: readonly BotRun[]
  modelGroups: readonly ModelGroup[]
  /**
   * Re-read Settings' model catalog. Called when the composer opens its model menu:
   * Settings can change while the panel stays mounted, and this UI must show the
   * user's CURRENT providers rather than the list captured at mount time.
   */
  onRefreshModels: () => void
  /** The snapshot's task board; filtered to this room below. */
  tasks: readonly SnapshotTask[]
  skills: ReadonlyArray<{ id: string; name: string; description: string; path: string }> | undefined
  skillsError: string | undefined
  /** Last snapshot failure, painted above the panel and inside the empty state. */
  error: string | undefined
  /** Picks the empty state's wording: bots list or group list. */
  isBotMode: boolean
  remote: CommunityRemote
  /** Stable skill loaders — see the note on the composer's dependency list in the shell. */
  onLoadSkill: (name: string) => Promise<{ name: string; content: string } | undefined>
  onListSkillFiles: (dir: string) => Promise<Array<{ path: string; isDir: boolean }>>
  listLedger: BotConversationPanelProps['listLedger']
  /** The shell's notice line (model/permission/command feedback, fork results). */
  onNotice: (text: string) => void
  /** §5.4: after a DM send, ask the host whether the task should become a group. */
  onDetectProposal: (roomId: string, messageId: string) => void
  /**
   * Advance the open room's read water mark. `upTo` is the message the user demonstrably saw — for
   * a send, the object `sendMessage` just returned (the panel's snapshot may not contain it yet);
   * `null` means "everything up to the moment the room was opened".
   *
   * Routed through the shell rather than calling the RPC here: the shell keeps one per-room record
   * of the last mark it asked for, and the send path has to share it. Bypassing it made the shell
   * ask for the older "opened at" mark on the next tick — a request the host can only refuse.
   */
  onMarkRead: (roomId: string, upTo: { id: string; createdAt: string } | null) => void
  /**
   * Reload the snapshot now. Deliberately takes no room: the reload must keep whatever the
   * user has selected by the time it lands. Passing the room this panel was showing (the old
   * fork path did) dragged the selection back when the user switched away mid-request — see
   * `selection.ts` and `useCommunitySnapshot`.
   */
  onReload: () => Promise<void>
  /** Land in a freshly forked bot's room: switch to the bots tab and select it. */
  onOpenBotRoom: (roomId: string) => void
}

export function ConversationArea({
  room, roomId, bots, runs, modelGroups, onRefreshModels, tasks, skills, skillsError, error, isBotMode,
  remote, onLoadSkill, onListSkillFiles, listLedger, onNotice, onMarkRead, onDetectProposal,
  onReload, onOpenBotRoom,
}: ConversationAreaProps) {
  /**
   * Bumped after a compaction to REMOUNT the transcript.
   *
   * The panel merges ledger rows by id and never drops one (that is what keeps a streamed
   * turn from reordering the list), so rows for messages the host has just deleted would
   * stay on screen for ever. A compaction is the one event that removes rows, and a fresh
   * mount is the one thing that forgets them. Hook lives above the early return below
   * because hooks may not be conditional.
   */
  const [transcriptEpoch, setTranscriptEpoch] = useState(0)

  if (room === undefined) {
    return (
      <div className={css.emptyState} style={{ gridRow: '1 / -1' }}>
        {error !== undefined && <p style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 13 }}>{error}</p>}
        <p className={css.emptyTitle}>{isBotMode ? '选择一个 Bot' : '选择一个群聊'}</p>
        <p className={css.emptyHint}>{isBotMode ? '从左侧选择 Bot 开始聊天，或点击 + 新建。' : '从左侧选择群聊，或点击 + 新建。'}</p>
      </div>
    )
  }

  return (
    <>
      {/* The room header is deliberately gone: the panel's own
          SessionHeader already carries the name, stop, and clear
          controls, so the page header was pure duplication. */}
      {error !== undefined && <div className={css.error}>{error}</div>}
      {/* P1-P8: BotConversationPanel — self-contained conversation UI.
          Data comes from the plugin's own ledger RPC, not DSH session.
          css.content is a grid (grid-template-rows: auto minmax(0,1fr) auto).
          Use gridRow:'2/-1' so the panel always fills all remaining rows
          regardless of whether the error div is present; height:100% is
          correct for a grid child (flex:1 does nothing here). */}
      <div style={{
        gridRow: '2 / -1',
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
        // Two rows: the goal strip (auto) and the transcript (all the rest). A GRID, not a flex
        // column, so the panel below stays a direct child and its own `height: 100%` resolves to
        // the remaining track instead of the whole wrapper. The strip is a sibling of the
        // scroller, never a row inside it: authorizing/pausing must not require scrolling.
        display: 'grid',
        gridTemplateRows: 'auto minmax(0, 1fr)',
      }}>
        {/* S3: the room goal's authorization state and the user's controls. Renders nothing
            when the room has no goal, or when the goal is done. The wrapping div is load-bearing:
            it keeps row 1 of this grid occupied even when the strip renders nothing, so the
            transcript below always lands in the `minmax(0, 1fr)` row instead of drifting into the
            auto row (where its own `height: 100%` would collapse). */}
        <div style={{ minWidth: 0 }}>
          <GoalStrip room={room} remote={remote} onReload={onReload} onNotice={onNotice} />
        </div>
        <BotConversationPanel
          key={`${roomId}#${transcriptEpoch}`}
          remote={remote}
          roomId={roomId!}
          roomName={room.directBotId !== undefined
            ? (bots.find(b => b.id === room.directBotId)?.name ?? room.name ?? 'Bot 会话')
            : (room.name ?? '群聊')}
          isGroup={room.directBotId === undefined}
          bots={bots
            .filter(b => room.memberIds.includes(b.id))
            .map(b => ({ id: b.id, name: b.name, avatarSeed: b.avatar.seed }))}
          // THE ROOM'S runs, not the members' runs: a member busy in ANOTHER room used
          // to satisfy the task dock's "something is running" test, so the card stayed
          // on screen in a room where nothing was happening.
          runs={runs.filter(r => r.roomId === roomId)}
          modelGroups={modelGroups as Array<{ id: string; name?: string; label?: string; models: Array<{ id: string; name?: string }> }>}
          onRefreshModels={onRefreshModels}
          skills={skills}
          skillsError={skillsError}
          onLoadSkill={onLoadSkill}
          onListSkillFiles={onListSkillFiles}
          onSend={async (roomId, text, modelPayload, attachments, mentions) => {
            // `text` is the draft (what the bubble shows); `modelPayload` adds the
            // expanded `/skill` bodies for the model only. Attachments travel as base64
            // bytes: the page cannot see the host's filesystem, and the host refuses to
            // accept a caller-supplied path. The host stores each file inside the
            // receiving bot's own workspace and appends an `[附件]` block to the MODEL
            // payload, so the bubble still shows exactly what the user typed.
            const sent = await remote.sendMessage({
              roomId, text, modelText: modelPayload,
              ...(attachments.length > 0
                ? { attachments: await readAttachmentsForRpc(attachments) }
                : {}),
            } as Parameters<typeof remote.sendMessage>[0])
            // ── THE USER'S OWN MESSAGE IS NOT UNREAD ────────────────────────────────
            //
            // Sending means "I have seen everything up to this point", so the room's read
            // water mark advances to the message just sent. Without this the mark stayed at
            // the instant the room was OPENED, so the user's own message — and every reply
            // that followed it — counted as unread while the user was staring at the
            // transcript, reported as 「明明处在会话界面却依然显示未读，还把我发送的消息也
            // 识别为未读」.
            //
            // The id comes from the send's own answer, so the mark is exact rather than a
            // timestamp compared against the client's clock — and the whole message object is
            // handed over, because the panel's snapshot does not contain it yet.
            onMarkRead(roomId, { id: sent.id, createdAt: sent.createdAt })
            void onReload()
            // §5.4: only a DM can escalate into a group — a group already has
            // its members — and the check runs AFTER the send resolved so the
            // message the proposal is about is already in the room.
            if (room.directBotId !== undefined) void onDetectProposal(roomId, sent.id)
          }}
          onStop={async (_roomId) => {
            const activeRuns = runs.filter(r =>
              room.memberIds.includes(r.botId) &&
              (r.status === 'running' || r.status === 'queued'),
            )
            await Promise.all(activeRuns.map(r =>
              remote.controlRun({ id: r.id, action: 'cancel', expectedRevision: r.controlRevision }),
            ))
          }}
          onApprove={async (callId) => {
            await remote.approveBotToolCall(callId, 'allowed-once')
          }}
          onReject={async (callId) => {
            await remote.approveBotToolCall(callId, 'rejected')
          }}
          // A blocked question: the answer unblocks the bot's turn, so the panel reloads
          // straight away rather than waiting for the next poll tick.
          onAnswerQuestion={async (questionId, answer) => {
            await remote.answerBotQuestion({ roomId: roomId!, questionId, answer })
            void onReload()
          }}
          onSkipQuestion={async (questionId) => {
            await remote.answerBotQuestion({ roomId: roomId!, questionId, skip: true })
            void onReload()
          }}
          onCommand={(_roomId, cmdId, subId) => {
            // ── EVERY ROW MUST DO SOMETHING REAL ────────────────────────────────
            //
            // This handler used to be a pile of placeholders: `file` had no branch at
            // all (the menu row did nothing), `permission` and `model` answered with a
            // notice and changed nothing, and `compact` silently DELETED the room's
            // messages — a destructive surprise behind a label that means "compress".
            // A menu whose rows lie is worse than a menu with fewer rows, so each branch
            // below either performs the action or says plainly why it cannot.
            const botId = room.directBotId ?? room.memberIds[0]
            const bot = bots.find(b => b.id === botId)
            if (botId === undefined || bot === undefined) {
              onNotice('这个房间没有可配置的 Bot。')
              return
            }
            const botName = bot.name

            if (cmdId === 'permission' && subId !== undefined) {
              // The bot's permission IS the session's sandbox/approval preset
              // (`SessionRunner.applyPermissionPreset`), so the stored value is the
              // switch that matters — no session-level knob exists to poke instead.
              const label = { 'read-only': '仅可查看', 'workspace-write': '工作区内修改', 'full-access': '完全权限' }[subId] ?? subId
              void remote.updateBot({ id: botId, permission: subId as 'read-only' | 'workspace-write' | 'full-access' })
                .then(() => {
                  onNotice(`已把「${botName}」的权限设为：${label}。正在进行的这一轮不受影响，下一次运行生效。`)
                  return onReload()
                })
                .catch((e: unknown) => { onNotice(`设置权限失败：${describe(e)}`) })
              return
            }

            if (cmdId === 'model' && subId !== undefined) {
              if (subId === 'default') {
                onNotice('这是占位项：模型目录还没加载完，稍后再试。')
                return
              }
              // Menu ids are `<provider>:<model>` so two providers that offer the same
              // model id (they exist) stay distinguishable; a bare id is still accepted
              // for entries produced by an older menu.
              const sep = subId.indexOf(':')
              const providerId = sep > 0 ? subId.slice(0, sep) : undefined
              const modelId = sep > 0 ? subId.slice(sep + 1) : subId
              const group = (providerId !== undefined ? modelGroups.find(g => g.id === providerId) : undefined)
                ?? modelGroups.find(g => g.models.some(m => m.id === modelId))
              if (group === undefined) {
                onNotice(`找不到模型「${subId}」所属的提供方，未做修改。`)
                return
              }
              const modelName = group.models.find(m => m.id === modelId)?.name ?? modelId
              const providerName = group.name ?? group.label ?? group.id
              void remote.updateBot({ id: botId, provider: group.id, model: modelId })
                .then(() => {
                  // The provider belongs in the notice: two providers offer the same model
                  // ids, so "model set to X" alone cannot tell the user what changed.
                  onNotice(`已把「${botName}」的模型设为：${modelName}（提供方：${providerName}）。正在进行的这一轮不受影响，下一次运行生效。`)
                  return onReload()
                })
                .catch((e: unknown) => { onNotice(`设置模型失败：${describe(e)}`) })
              return
            }

            if (cmdId === 'compact') {
              // 压缩 folds the room's older messages behind one checkpoint. The host owns
              // the work — only it can read the room's messages and write the checkpoint —
              // so this branch is: call, report, reload. Nothing is deleted: the originals
              // stay in the transcript and the bots' own sessions are left to DSH.
              //
              // The old branch printed an explanation pointing at 清空消息 because there was
              // no summariser to call. There is one now (`compactRoom` → the plugin's own
              // `ctx.llm.stream` path), and it keeps the newest messages verbatim.
              void remote.compactRoom({ roomId: roomId! })
                .then((result) => {
                  if (!result.compacted) {
                    // A refusal is a normal answer and NOTHING was touched: say why and stop.
                    onNotice(result.reason ?? '这次没有压缩：房间不需要压缩。')
                    return
                  }
                  // NON-DESTRUCTIVE, and the wording has to match: the folded messages are
                  // still in the transcript (scroll up and they are there) — what changed is
                  // the model's window. Claiming "原文不再保留" would now be false.
                  onNotice(
                    `已把 ${result.removed} 条较早的消息折叠成 1 条摘要；原文仍在，向上翻可以看到，`
                    + `模型从摘要 + 最近 ${result.kept} 条继续。Bot 自己的上下文由 DSH 负责压缩。`,
                  )
                  // ── THE TRANSCRIPT HAS TO BE REBUILT, NOT PATCHED ──────────────
                  //
                  // The panel merges ledger rows by id and never drops one, so the rows of
                  // the messages this call just replaced would stay on screen. Bumping the
                  // epoch remounts the panel, which fetches the host's rebuilt ledger.
                  setTranscriptEpoch(epoch => epoch + 1)
                  return onReload()
                })
                .catch((e: unknown) => { onNotice(`压缩失败：${describe(e)}`) })
              return
            }

            // `file` never reaches here: the composer owns both the menu and the file
            // input, so it opens the picker in `selectSlashCommand` and does not call
            // onCommand. Noted so a later reader does not add a "missing" branch.

            onNotice(`「${cmdId}」这个命令还没有实现。`)
          }}
          onClear={(_roomId) => {
            remote.clearMessages(roomId!).catch(() => undefined)
          }}
          round={room.taskState?.round}
          tasks={tasks.filter(t => t.roomId === roomId).map(t => ({
            id: t.id, subject: t.subject, status: t.status, round: t.round,
            ...(t.assigneeName !== undefined ? { assigneeName: t.assigneeName } : {}),
          }))}
          listLedger={listLedger}
          onFork={room.directBotId === undefined ? undefined : (messageId) => {
            const botId = room.directBotId
            if (botId === undefined) return
            void remote.copyBot(botId, room.id, messageId)
              .then(({ bot, room: copy }) => {
                onNotice(`已分叉出新 Bot：${bot.name}（已带上该条及之前的消息）`)
                // Land in the copy's conversation, not the original's. The reload itself
                // carries no room: `onOpenBotRoom` is what moves the selection, and it has
                // to run AFTER the fresh snapshot so the copy's room exists to be selected.
                void onReload().then(() => {
                  onOpenBotRoom(copy.id)
                })
              })
              .catch((e: unknown) => { onNotice(`分叉失败：${describe(e)}`) })
          }}
        />
      </div>
    </>
  )
}

/**
 * Read the composer's picked files into the send RPC's inline shape.
 *
 * BASE64, not a path: the page cannot see the host's filesystem, and the host must not
 * accept a path — an "attachment name" like `../../x` would otherwise be an arbitrary
 * write. `FileReader` rather than a manual byte loop because `String.fromCharCode(...)`
 * over a multi-megabyte array overflows the stack.
 */
async function readAttachmentsForRpc(
  items: readonly AttachmentItem[],
): Promise<Array<{ name: string; mime?: string; dataBase64: string }>> {
  return Promise.all(items.map(async item => ({
    name: item.name,
    ...(item.file.type !== '' ? { mime: item.file.type } : {}),
    dataBase64: await readAsBase64(item.file),
  })))
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`读取附件失败：${file.name}`))
    reader.onload = () => {
      // readAsDataURL always yields `data:<mime>;base64,<payload>`; the RPC carries the
      // payload alone, and the host resolves the MIME from the explicit field.
      const result = String(reader.result ?? '')
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.readAsDataURL(file)
  })
}
