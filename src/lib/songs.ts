import { RAW, type Era, type Genre } from '../data/catalogo.js'
import { hash, norm } from './text.js'

export interface Song {
  id: string
  artist: string
  title: string
  era: Era
  gen: Genre
  tier: number
  n: string
}

export const SONGS: Song[] = RAW.map((r) => ({
  id: hash(r[0] + '|' + r[1]),
  artist: r[0],
  title: r[1],
  era: r[2],
  gen: r[3],
  tier: r[4],
  n: norm(r[0] + ' ' + r[1]),
}))

export const BY_ID: Record<string, Song> = Object.fromEntries(SONGS.map((s) => [s.id, s]))
