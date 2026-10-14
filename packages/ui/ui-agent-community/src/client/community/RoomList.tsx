/**
 * RoomList — the page's left column: the Bots / 群聊 tab strip and the rows under it.
 *
 * Presentational on purpose. It owns no data and calls no RPC: every row action is a callback the
 * page shell turns into dialog state or a selection change, and the unread numbers arrive already
 * derived from `snapshot.unread` (see `unread.ts`) so a badge here can never disagree with the
 * tab dot or the sidebar entry above it.
 */
import type { BotIdentity, BotPresence, BotRoom } from '@dsh-plugin/agent-community'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { css } from '../styles.ts'
import { formatUnread, unreadFor } from '../unread.ts'
import type { ActiveTab } from './types.ts'

/** Presence, as the state dot's five-way vocabulary. */
function presenceToState(p: BotPresence | undefined): 'ongoing' | 'done' | 'error' | 'warning' {
  if (p === 'running') return 'ongoing'
  if (p === 'failed') return 'error'
  if (p === 'queued' || p === 'waiting-human') return 'warning'
  return 'done'
}

/** Four-up avatar grid for group rooms: up to 4 bot emojis in a 2×2 grid. */
function GroupAvatar({ bots, size = 32 }: { bots: BotIdentity[]; size?: number }) {
  const seeds = bots.slice(0, 4).map(b => b.avatar.seed)
  if (seeds.length === 0) {
    return (
      <span className={css.avatar} style={{ fontSize: 14, display: 'grid', placeItems: 'center', width: size, height: size }}>
        #
      </span>
    )
  }
  if (seeds.length === 1) {
    return (
      <span className={css.avatar} style={{ fontSize: 15, display: 'grid', placeItems: 'center', width: size, height: size }}>
        {seeds[0]}
      </span>
    )
  }
  return (
    <span
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        width: size,
        height: size,
        borderRadius: 'var(--dsw-radius-md)',
        border: '.5px solid var(--dsw-alias-border-l3)',
        background: 'var(--dsw-alias-bg-base)',
        overflow: 'hidden',
        flex: 'none',
        fontSize: Math.round(size * 0.36),
        lineHeight: 1,
      }}
      aria-hidden="true"
    >
      {seeds.map((s, i) => (
        <span key={i} style={{ display: 'grid', placeItems: 'center', overflow: 'hidden' }}>{s}</span>
      ))}
    </span>
  )
}

export interface RoomListProps {
  /** Which list is showing. Also picks the section title and the create button's label. */
  tab: ActiveTab
  /** Switching tab drops the selection — the selected room belongs to the list being left. */
  onSelectTab: (tab: ActiveTab) => void
  /** Bots in the directory; the group rows resolve their own members from it. */
  bots: BotIdentity[]
  /** Rooms of the current tab, already filtered by the shell (dead bots' DMs excluded). */
  rooms: BotRoom[]
  selectedId: string | undefined
  unread: Readonly<Record<string, number>> | undefined
  directTabUnread: boolean
  groupTabUnread: boolean
  onSelectRoom: (roomId: string) => void
  onCreate: () => void
  onEditBot: (bot: BotIdentity) => void
  onOpenRoomSettings: (room: BotRoom) => void
  onDeleteBot: (bot: BotIdentity) => void
  onDeleteRoom: (room: BotRoom) => void
}

export function RoomList({
  tab, onSelectTab, bots, rooms, selectedId, unread,
  directTabUnread, groupTabUnread,
  onSelectRoom, onCreate, onEditBot, onOpenRoomSettings, onDeleteBot, onDeleteRoom,
}: RoomListProps) {
  const isBotMode = tab === 'bots'

  return (
    <aside className={css.sidebar}>
      <div className={css.tabs}>
        <button className={css.tab} data-active={tab === 'bots' ? 'true' : undefined} onClick={() => onSelectTab('bots')}>
          Bots{directTabUnread && <span className={css.tabDot} data-testid="tab-dot-bots" aria-label="有未读单聊" />}
        </button>
        <button className={css.tab} data-active={tab === 'rooms' ? 'true' : undefined} onClick={() => onSelectTab('rooms')}>
          群聊{groupTabUnread && <span className={css.tabDot} data-testid="tab-dot-rooms" aria-label="有未读群聊" />}
        </button>
      </div>

      <div className={css.section}>
        <div className={css.sectionHeading}>
          <h3 className={css.sectionTitle}>{isBotMode ? 'Bots' : '群聊'}</h3>
          <button className={css.addButton} onClick={onCreate} title={isBotMode ? '新建 Bot' : '新建群聊'}>＋</button>
        </div>
        <div className={css.itemList}>
          {isBotMode ? (
            bots.length === 0
              ? <p className={css.listEmpty}>还没有 Bot，点击 + 创建。</p>
              : bots.map(bot => {
                const room = rooms.find(r => r.directBotId === bot.id)
                return (
                  <div key={bot.id} className={css.rowWithAction}>
                    <button
                      className={css.botRow}
                      data-active={selectedId === room?.id ? 'true' : undefined}
                      onClick={() => room !== undefined && onSelectRoom(room.id)}
                      disabled={room === undefined}
                      title={room === undefined ? '正在为该 Bot 建立直聊房间…' : undefined}
                    >
                      <span className={css.avatarWrap}>
                        <span className={css.avatar}>{bot.avatar.seed}</span>
                        {unreadFor(unread, room?.id) > 0 && (
                          <span className={css.unreadBadge} data-testid={`unread-${room?.id}`} aria-label={`${unreadFor(unread, room?.id)} 条未读`}>
                            {formatUnread(unreadFor(unread, room?.id))}
                          </span>
                        )}
                      </span>
                      <span className={css.rowText}>
                        <span className={css.rowName}>{bot.name}</span>
                        <span className={css.rowMeta} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <StateDot state={presenceToState(bot.presence)} />
                          {bot.presence === 'running' ? '运行中' : bot.presence === 'queued' ? '排队中' : '空闲'}
                        </span>
                      </span>
                    </button>
                    {/* Edit button */}
                    <button
                      className={css.rowActionButton}
                      onClick={() => onEditBot(bot)}
                      title="设置"
                      style={{ right: 30 }}
                    >
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.35"/>
                        <path d="M8 1v2M8 13v2M1 8h2M13 8h2M2.93 2.93l1.41 1.41M11.66 11.66l1.41 1.41M2.93 13.07l1.41-1.41M11.66 4.34l1.41-1.41" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round"/>
                      </svg>
                    </button>
                    {/* Delete button */}
                    <button
                      className={css.rowDeleteButton}
                      onClick={() => onDeleteBot(bot)}
                      title="删除"
                    >
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <line x1="3" y1="3" x2="13" y2="13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                        <line x1="13" y1="3" x2="3" y2="13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                      </svg>
                    </button>
                  </div>
                )
              })
          ) : (
            rooms.length === 0
              ? <p className={css.listEmpty}>还没有群聊，点击 + 创建。</p>
              : rooms.map(room => {
                const memberBots = room.memberIds.map(id => bots.find(b => b.id === id)).filter((b): b is BotIdentity => b !== undefined)
                return (
                  <div key={room.id} className={css.rowWithAction}>
                    <button
                      className={css.roomRow}
                      data-active={selectedId === room.id ? 'true' : undefined}
                      onClick={() => onSelectRoom(room.id)}
                    >
                      <span className={css.avatarWrap}>
                        <GroupAvatar bots={memberBots} size={32} />
                        {unreadFor(unread, room.id) > 0 && (
                          <span className={css.unreadBadge} data-testid={`unread-${room.id}`} aria-label={`${unreadFor(unread, room.id)} 条未读`}>
                            {formatUnread(unreadFor(unread, room.id))}
                          </span>
                        )}
                      </span>
                      <span className={css.rowText}>
                        <span className={css.rowName}>{room.name}</span>
                        <span className={css.rowMeta}>{room.memberIds.length} 成员</span>
                      </span>
                    </button>
                    {/* Room settings button */}
                    <button
                      className={css.rowActionButton}
                      onClick={() => onOpenRoomSettings(room)}
                      title="群聊设置"
                      style={{ right: 30 }}
                    >
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.35"/>
                        <path d="M8 1v2M8 13v2M1 8h2M13 8h2M2.93 2.93l1.41 1.41M11.66 11.66l1.41 1.41M2.93 13.07l1.41-1.41M11.66 4.34l1.41-1.41" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round"/>
                      </svg>
                    </button>
                    {/* Delete button */}
                    <button
                      className={css.rowDeleteButton}
                      onClick={() => onDeleteRoom(room)}
                      title="删除"
                    >
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <line x1="3" y1="3" x2="13" y2="13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                        <line x1="13" y1="3" x2="3" y2="13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                      </svg>
                    </button>
                  </div>
                )
              })
          )}
        </div>
      </div>
    </aside>
  )
}
