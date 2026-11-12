import { RAW } from '../data/catalogo.js'
import { RAW_REGGAETON } from '../data/catalogo-reggaeton.js'
import { RAW_ROCK80S } from '../data/catalogo-rock80s.js'
import { RAW_TRAP } from '../data/catalogo-trap.js'
import { RAW_HITS } from '../data/catalogo-hits.js'
import type { SimpleRow } from '../data/catalogo-reggaeton.js'
import type { SegmentId } from '../data/segments.js'
import { hash, norm } from './text.js'

export interface Song {
  id: string
  artist: string
  title: string
  tier: number
  n: string
  segments: SegmentId[]
}

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

export const SONGS: Song[] = [...songMap.values()]

export const BY_ID: Record<string, Song> = Object.fromEntries(SONGS.map((s) => [s.id, s]))
