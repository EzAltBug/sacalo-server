import { RAW } from '../data/catalogo.js'
import { RAW_REGGAETON } from '../data/catalogo-reggaeton.js'
import { RAW_ROCK80S } from '../data/catalogo-rock80s.js'
import { RAW_TRAP } from '../data/catalogo-trap.js'
import { RAW_HITS } from '../data/catalogo-hits.js'
import type { SimpleRow } from '../data/catalogo-reggaeton.js'
import { getSongCount, seedSongs } from './db.js'

function fromArgentina(rows: typeof RAW) {
  return rows.map((r) => ({
    artist: r[0], title: r[1], tier: r[4], feat: r[5],
    era: r[2], genre: r[3], segment: 'argentina' as const,
  }))
}

function fromSimple(rows: SimpleRow[], segment: string) {
  return rows.map((r) => ({
    artist: r[0], title: r[1], tier: r[2], feat: r[3],
    segment,
  }))
}

export async function seedIfEmpty() {
  const count = await getSongCount()
  if (count > 0) {
    console.log(`[seed] Songs table already has ${count} songs, skipping seed.`)
    return
  }

  console.log('[seed] Songs table is empty, seeding from hardcoded catalogs...')
  const all = [
    ...fromArgentina(RAW),
    ...fromSimple(RAW_REGGAETON, 'reggaeton'),
    ...fromSimple(RAW_ROCK80S, 'rock80s'),
    ...fromSimple(RAW_TRAP, 'trap'),
    ...fromSimple(RAW_HITS, 'hits'),
  ]

  const inserted = await seedSongs(all)
  console.log(`[seed] Inserted ${inserted} songs.`)
}
