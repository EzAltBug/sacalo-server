import type { Era, Genre } from '../data/catalogo.js'
import { SONGS, type Song } from './songs.js'

export const STAGES = [0.2, 0.5, 2, 8, 15] as const

export type DiffKey = 'facil' | 'medio' | 'dificil' | 'experto' | 'imposible' | 'random'
export type EraFilter = 'any' | Era
export type GenFilter = 'any' | Genre

const DIFFS: { key: DiffKey; range: [number, number] | null }[] = [
  { key: 'facil', range: [1, 2] },
  { key: 'medio', range: [2, 3] },
  { key: 'dificil', range: [3, 4] },
  { key: 'experto', range: [4, 5] },
  { key: 'imposible', range: [5, 5] },
  { key: 'random', range: null },
]
const REAL_DIFFS = DIFFS.filter((d) => d.range)

export function drawDiff(pref: DiffKey): DiffKey {
  if (pref !== 'random') return pref
  return REAL_DIFFS[Math.floor(Math.random() * REAL_DIFFS.length)].key as DiffKey
}

export function pool(
  diff: DiffKey,
  era: EraFilter,
  gen: GenFilter,
  played: Set<string>,
): { songs: Song[]; exhausted: boolean } {
  const range = (DIFFS.find((d) => d.key === diff) ?? DIFFS[1]).range ?? [2, 3]
  const f = (s: Song) => (era === 'any' || s.era === era) && (gen === 'any' || s.gen === gen)
  let p = SONGS.filter((s) => s.tier >= range[0] && s.tier <= range[1] && f(s))
  if (!p.length) p = SONGS.filter(f)
  if (!p.length) p = SONGS
  const fresh = p.filter((s) => !played.has(s.id))
  return fresh.length ? { songs: fresh, exhausted: false } : { songs: p, exhausted: true }
}
