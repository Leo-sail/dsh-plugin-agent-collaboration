/**
 * MentionMenu — @bot picker for group chat, shown when user types @.
 * Filters the room's member bot list against the text after @.
 */
import { useEffect } from 'react'
import { botEmoji } from './styles.ts'

interface BotOption {
  id: string
  name: string
  /** The avatar glyph itself (`avatar.seed`), rendered as-is. */
  avatarSeed?: string | undefined
}

interface Props {
  query: string
  bots: BotOption[]
  onSelect: (bot: BotOption) => void
  onClose: () => void
}

/**
 * The room-wide option.
 *
 * `@所有人` is the ONLY way to ask every member to answer (see the routing table in
 * `routing.ts`): an unaddressed message goes to the leader, who decides. Offering the row
 * here is what makes that path reachable without the user typing the token by hand —
 * selecting it inserts `@所有人`, which the host recognises.
 */
const EVERYONE: BotOption = { id: '__everyone__', name: '所有人', avatarSeed: '👥' }
/** `@all` is the latin spelling the host also accepts; both are matched here for filtering. */
const EVERYONE_ALIASES = ['所有人', '全体', 'all']

export function MentionMenu({ query, bots, onSelect, onClose }: Props) {
  const needle = query.toLowerCase()
  const everyone = EVERYONE_ALIASES.some(alias => alias.includes(needle))
  const filtered = bots.filter(b =>
    query === '' || b.name.toLowerCase().includes(needle)
  )
  if (everyone) filtered.unshift(EVERYONE)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' || (e.key === 'Tab' && e.shiftKey)) {
        e.preventDefault(); onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (filtered.length === 0) return null

  return (
    <div style={{
      position: 'absolute', bottom: '100%', left: 0, zIndex: 100,
      marginBottom: 4, minWidth: 200, maxWidth: 280,
      borderRadius: 'var(--dsw-radius-md, 8px)',
      border: '0.5px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-button-floating-fill)',
      boxShadow: '0 4px 20px rgba(0,0,0,.15)',
      overflow: 'hidden',
    }}>
      <div style={{ padding: '6px 12px 2px', fontSize: 10, fontWeight: 600, color: 'var(--dsw-alias-label-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        提及 Bot · 或整个房间
      </div>
      {filtered.map(bot => (
        <button
          key={bot.id}
          onClick={() => onSelect(bot)}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', gap: 8,
            padding: '7px 12px', border: 'none', background: 'transparent',
            cursor: 'pointer', textAlign: 'left',
          }}
        >
          <span style={{ fontSize: 14 }}>{bot.avatarSeed ?? botEmoji(bot.id)}</span>
          <span style={{ fontSize: 13, color: 'var(--dsw-alias-label-primary)' }}>{bot.name}</span>
          {bot.id === EVERYONE.id && (
            <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>
              全员各自回答
            </span>
          )}
        </button>
      ))}
    </div>
  )
}
