import { RAW } from '../data/catalogo.js'
import { RAW_REGGAETON } from '../data/catalogo-reggaeton.js'
import { RAW_ROCK80S } from '../data/catalogo-rock80s.js'
import { RAW_TRAP } from '../data/catalogo-trap.js'
import { RAW_HITS } from '../data/catalogo-hits.js'
import type { SimpleRow } from '../data/catalogo-reggaeton.js'
import type { SegmentId } from '../data/segments.js'
import { getAllSongs } from './db.js'
import { hash, norm } from './text.js'

export interface Song {
  id: string
  artist: string
  title: string
  tier: number
  n: string
  segments: SegmentId[]
}

// Hardcoded fallback (used if DB is empty or not yet seeded)
function buildFromHardcoded(): Song[] {
  function fromArgentina(rows: typeof RAW) {
    return rows.map((r) => ({ artist: r[0], title: r[1], tier: r[4], segment: 'argentina' as const }))
  }
  function fromSimple(rows: SimpleRow[], segment: SegmentId) {
    return rows.map((r) => ({ artist: r[0], title: r[1], tier: r[2], segment }))
  }

  const ALL = [
    ...fromArgentina(RAW),
    ...fromSimple(RAW_REGGAETON, 'reggaeton'),
    ...fromSimple(RAW_ROCK80S, 'rock80s'),
    ...fromSimple(RAW_TRAP, 'trap'),
    ...fromSimple(RAW_HITS, 'hits'),
  ]

  const songMap = new Map<string, Song>()
  for (const r of ALL) {
    const id = hash(r.artist + '|' + r.title)
    const existing = songMap.get(id)
    if (existing) {
      if (!existing.segments.includes(r.segment)) existing.segments.push(r.segment)
    } else {
      songMap.set(id, {
        id,
        artist: r.artist,
        title: r.title,
        tier: r.tier,
        n: norm(r.artist + ' ' + r.title),
        segments: [r.segment],
      })
    }
  }
  return [...songMap.values()]
}

// In-memory cache
let _songs: Song[] = buildFromHardcoded()
let _byId: Record<string, Song> = Object.fromEntries(_songs.map((s) => [s.id, s]))

export function getSongs(): Song[] { return _songs }
export function getById(): Record<string, Song> { return _byId }

// Aliases for backward compatibility
export { _songs as SONGS, _byId as BY_ID }

export async function refreshFromDb() {
  try {
    const rows = await getAllSongs()
    if (rows.length === 0) return // Keep hardcoded fallback

    _songs = rows.map((r) => ({
      id: r.song_id,
      artist: r.artist,
      title: r.title,
      tier: r.tier,
      n: norm(r.artist + ' ' + r.title + (r.feat ? ' ' + r.feat : '')),
      segments: r.segments as SegmentId[],
    }))
    _byId = Object.fromEntries(_songs.map((s) => [s.id, s]))
    console.log(`[songs] Loaded ${_songs.length} songs from DB`)
  } catch (err) {
    console.error('[songs] Failed to load from DB, using hardcoded:', err)
  }
}
