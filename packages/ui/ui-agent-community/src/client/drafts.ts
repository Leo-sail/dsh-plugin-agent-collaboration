/**
 * Composer drafts, kept per room.
 *
 * The composer's text used to live in the component's own `useState`, so switching to another room
 * and back threw the half-typed message away — reported as "输入框中的内容消失了". The draft now
 * belongs to the ROOM, not to the mounted component: the store survives unmounts, and it is mirrored
 * into `localStorage` so a page reload (or an app restart) does not lose it either.
 *
 * Everything here is defensive: `localStorage` can be unavailable (private mode, disabled storage) or
 * full, and a lost draft must never break the panel.
 */

const STORAGE_KEY = 'dsh-plugin-community-drafts'
/** Keep the store small: drafts are transient text, not history. */
const MAX_ROOMS = 100
const MAX_CHARS = 20_000

/** In-memory mirror so reads are synchronous inside render. */
let cache: Record<string, string> | undefined

function storage(): Storage | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined
    return localStorage
  } catch {
    return undefined
  }
}

/** Decode the persisted map; anything malformed degrades to "no drafts". */
export function parseDrafts(raw: string | null | undefined): Record<string, string> {
  if (raw === null || raw === undefined || raw === '') return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [roomId, text] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof text === 'string' && text !== '' && roomId !== '') out[roomId] = text.slice(0, MAX_CHARS)
    }
    return out
  } catch {
    return {}
  }
}

/** Drop empty values and keep only the newest {@link MAX_ROOMS} rooms. */
export function trimDrafts(drafts: Record<string, string>, max = MAX_ROOMS): Record<string, string> {
  const entries = Object.entries(drafts).filter(([roomId, text]) => roomId !== '' && text !== '')
  return Object.fromEntries(entries.slice(-max))
}

export function serializeDrafts(drafts: Record<string, string>): string {
  return JSON.stringify(trimDrafts(drafts))
}

/** The whole map, loading it from storage on first use. */
export function allDrafts(): Record<string, string> {
  if (cache !== undefined) return cache
  const store = storage()
  cache = store === undefined ? {} : parseDrafts(store.getItem(STORAGE_KEY))
  return cache
}

function persist(next: Record<string, string>): void {
  cache = trimDrafts(next)
  const store = storage()
  if (store === undefined) return
  try {
    store.setItem(STORAGE_KEY, serializeDrafts(cache))
  } catch {
    // Quota or disabled storage: the in-memory copy still works for this session.
  }
}

/** The draft for one room ('' when empty). */
export function getDraft(roomId: string | undefined): string {
  if (roomId === undefined || roomId === '') return ''
  return allDrafts()[roomId] ?? ''
}

/** Store a room's draft. Empty text removes the entry rather than keeping a blank. */
export function setDraft(roomId: string | undefined, text: string): void {
  if (roomId === undefined || roomId === '') return
  const next = { ...allDrafts() }
  if (text === '') delete next[roomId]
  else next[roomId] = text.slice(0, MAX_CHARS)
  persist(next)
}

/** Forget a room's draft (after sending, or when the room is gone). */
export function clearDraft(roomId: string | undefined): void {
  setDraft(roomId, '')
}

/** Test seam: forget the in-memory mirror so storage is re-read. */
export function resetDraftCache(): void {
  cache = undefined
}
