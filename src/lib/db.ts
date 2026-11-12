import postgres from 'postgres'
import { createHash } from 'node:crypto'
import { hash } from './text.js'

const sql = postgres(process.env.DATABASE_URL!, { ssl: 'require' })

const PIN_SALT = process.env.PIN_SALT ?? 'sacalo-default-salt'

export function hashPin(pin: string): string {
  return createHash('sha256').update(PIN_SALT + pin).digest('hex')
}

export async function initDb() {
  await sql`
    CREATE TABLE IF NOT EXISTS reports (
      id        SERIAL PRIMARY KEY,
      type      TEXT        NOT NULL,
      artist    TEXT        NOT NULL,
      title     TEXT        NOT NULL,
      dismissed BOOLEAN     DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `
  // Migration: add dismissed column if missing
  await sql`ALTER TABLE reports ADD COLUMN IF NOT EXISTS dismissed BOOLEAN DEFAULT FALSE`

  await sql`
    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      nickname TEXT UNIQUE NOT NULL,
      pin_hash TEXT NOT NULL,
      best_streak INT DEFAULT 0,
      current_streak INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS matches (
      id SERIAL PRIMARY KEY,
      player1_id INT REFERENCES players(id),
      player2_id INT REFERENCES players(id),
      winner_id INT REFERENCES players(id),
      song_id TEXT NOT NULL,
      diff TEXT NOT NULL,
      segment TEXT NOT NULL,
      played_at TIMESTAMPTZ DEFAULT NOW()
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS match_players (
      match_id INT REFERENCES matches(id) ON DELETE CASCADE,
      player_id INT REFERENCES players(id),
      nickname TEXT NOT NULL,
      won BOOLEAN NOT NULL,
      stage INT NOT NULL,
      time_ms INT NOT NULL,
      PRIMARY KEY (match_id, nickname)
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS songs (
      song_id TEXT PRIMARY KEY,
      artist  TEXT NOT NULL,
      title   TEXT NOT NULL,
      tier    INT  NOT NULL DEFAULT 3,
      feat    TEXT,
      era     TEXT,
      genre   TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS song_segments (
      song_id TEXT REFERENCES songs(song_id) ON DELETE CASCADE,
      segment TEXT NOT NULL,
      PRIMARY KEY (song_id, segment)
    )
  `
}

export async function insertReport(type: 'broken' | 'wrong', artist: string, title: string) {
  await sql`INSERT INTO reports (type, artist, title) VALUES (${type}, ${artist}, ${title})`
}

export async function dismissReports(type: string, artist: string, title: string) {
  await sql`UPDATE reports SET dismissed = TRUE WHERE type = ${type} AND artist = ${artist} AND title = ${title}`
}

export async function getReportCounts() {
  return sql<{ type: string; artist: string; title: string; count: string; dismissed: boolean }[]>`
    SELECT type, artist, title, COUNT(*)::text AS count, bool_or(dismissed) AS dismissed
    FROM reports
    GROUP BY type, artist, title
    ORDER BY bool_or(dismissed) ASC, type, COUNT(*) DESC
  `
}

export async function createPlayer(nickname: string, pinHash: string) {
  const [row] = await sql<{ id: number; nickname: string }[]>`
    INSERT INTO players (nickname, pin_hash) VALUES (${nickname.toLowerCase()}, ${pinHash}) RETURNING id, nickname
  `
  return row
}

export async function findPlayer(nickname: string) {
  const [row] = await sql<{ id: number; nickname: string; pin_hash: string }[]>`
    SELECT id, nickname, pin_hash FROM players WHERE nickname = ${nickname.toLowerCase()}
  `
  return row ?? null
}

interface MatchInsert {
  player1Id: number | null
  player2Id: number | null
  winnerId: number | null
  songId: string
  diff: string
  segment: string
  players: { playerId: number | null; nickname: string; won: boolean; stage: number; timeMs: number }[]
}

export async function insertMatch(m: MatchInsert) {
  const [match] = await sql<{ id: number }[]>`
    INSERT INTO matches (player1_id, player2_id, winner_id, song_id, diff, segment)
    VALUES (${m.player1Id}, ${m.player2Id}, ${m.winnerId}, ${m.songId}, ${m.diff}, ${m.segment})
    RETURNING id
  `
  for (const p of m.players) {
    await sql`
      INSERT INTO match_players (match_id, player_id, nickname, won, stage, time_ms)
      VALUES (${match.id}, ${p.playerId}, ${p.nickname}, ${p.won}, ${p.stage}, ${p.timeMs})
    `
  }
  for (const p of m.players) {
    if (!p.playerId) continue
    if (p.won) {
      await sql`UPDATE players SET current_streak = current_streak + 1, best_streak = GREATEST(best_streak, current_streak + 1) WHERE id = ${p.playerId}`
    } else {
      await sql`UPDATE players SET current_streak = 0 WHERE id = ${p.playerId}`
    }
  }
}

export async function getRanking(period: 'all' | 'month', limit = 20) {
  const dateFilter = period === 'month' ? sql`AND m.played_at >= date_trunc('month', NOW())` : sql``
  return sql<{ nickname: string; wins: string; losses: string; win_rate: string; best_streak: string; current_streak: string }[]>`
    SELECT p.nickname, COUNT(*) FILTER (WHERE mp.won) AS wins, COUNT(*) FILTER (WHERE NOT mp.won) AS losses,
      ROUND(COUNT(*) FILTER (WHERE mp.won)::numeric / GREATEST(COUNT(*), 1), 2) AS win_rate,
      p.best_streak, p.current_streak
    FROM players p JOIN match_players mp ON mp.player_id = p.id JOIN matches m ON m.id = mp.match_id
    WHERE 1=1 ${dateFilter} GROUP BY p.id, p.nickname, p.best_streak, p.current_streak
    ORDER BY COUNT(*) FILTER (WHERE mp.won) DESC, win_rate DESC LIMIT ${limit}
  `
}

export async function getPlayerStats(playerId: number) {
  const [stats] = await sql<{ wins: string; losses: string; win_rate: string; best_streak: string; current_streak: string }[]>`
    SELECT COUNT(*) FILTER (WHERE mp.won) AS wins, COUNT(*) FILTER (WHERE NOT mp.won) AS losses,
      ROUND(COUNT(*) FILTER (WHERE mp.won)::numeric / GREATEST(COUNT(*), 1), 2) AS win_rate,
      p.best_streak, p.current_streak
    FROM players p JOIN match_players mp ON mp.player_id = p.id WHERE p.id = ${playerId} GROUP BY p.id, p.best_streak, p.current_streak
  `
  return stats ?? { wins: '0', losses: '0', win_rate: '0', best_streak: '0', current_streak: '0' }
}

export async function getPlayerRank(playerId: number, period: 'all' | 'month') {
  const dateFilter = period === 'month' ? sql`AND m.played_at >= date_trunc('month', NOW())` : sql``
  const [row] = await sql<{ rank: string }[]>`
    SELECT rank FROM (
      SELECT p.id, RANK() OVER (ORDER BY COUNT(*) FILTER (WHERE mp.won) DESC) AS rank
      FROM players p JOIN match_players mp ON mp.player_id = p.id JOIN matches m ON m.id = mp.match_id
      WHERE 1=1 ${dateFilter} GROUP BY p.id
    ) ranked WHERE id = ${playerId}
  `
  return row ? +row.rank : null
}

export async function getPlayerHistory(playerId: number, page: number, pageSize = 20) {
  const offset = (page - 1) * pageSize
  const [countRow] = await sql<{ total: string }[]>`SELECT COUNT(*)::text AS total FROM match_players WHERE player_id = ${playerId}`
  const total = +(countRow?.total ?? '0')
  const rows = await sql<{ rival: string; won: boolean; date: string }[]>`
    SELECT opp.nickname AS rival, mp.won, m.played_at AS date
    FROM match_players mp JOIN matches m ON m.id = mp.match_id
    LEFT JOIN match_players opp ON opp.match_id = mp.match_id AND opp.nickname != mp.nickname
    WHERE mp.player_id = ${playerId} ORDER BY m.played_at DESC LIMIT ${pageSize} OFFSET ${offset}
  `
  return { matches: rows, total, page, pages: Math.ceil(total / pageSize) }
}

// ── Songs CRUD ─────────────────────────────────────────────────────

export interface SongRow {
  song_id: string
  artist: string
  title: string
  tier: number
  feat: string | null
  era: string | null
  genre: string | null
  segments: string[]
}

export async function seedSongs(songs: { artist: string; title: string; tier: number; feat?: string; era?: string; genre?: string; segment: string }[]) {
  const grouped = new Map<string, typeof songs[0] & { segments: string[] }>()
  for (const s of songs) {
    const id = hash(s.artist + '|' + s.title)
    const existing = grouped.get(id)
    if (existing) {
      if (!existing.segments.includes(s.segment)) existing.segments.push(s.segment)
    } else {
      grouped.set(id, { ...s, segments: [s.segment] })
    }
  }

  let inserted = 0
  for (const [id, s] of grouped) {
    const [row] = await sql`
      INSERT INTO songs (song_id, artist, title, tier, feat, era, genre)
      VALUES (${id}, ${s.artist}, ${s.title}, ${s.tier}, ${s.feat ?? null}, ${s.era ?? null}, ${s.genre ?? null})
      ON CONFLICT (song_id) DO NOTHING
      RETURNING song_id
    `
    if (row) {
      inserted++
      for (const seg of s.segments) {
        await sql`INSERT INTO song_segments (song_id, segment) VALUES (${id}, ${seg}) ON CONFLICT DO NOTHING`
      }
    }
  }
  return inserted
}

export async function getSongCount(): Promise<number> {
  const [row] = await sql<{ count: string }[]>`SELECT COUNT(*)::text AS count FROM songs`
  return +(row?.count ?? '0')
}

export async function getAllSongs(): Promise<SongRow[]> {
  return sql<SongRow[]>`
    SELECT s.song_id, s.artist, s.title, s.tier, s.feat, s.era, s.genre,
      ARRAY(SELECT ss.segment FROM song_segments ss WHERE ss.song_id = s.song_id) AS segments
    FROM songs s ORDER BY s.artist, s.title
  `
}

export async function getSongsFiltered(segment?: string, search?: string, page = 1, pageSize = 50) {
  const offset = (page - 1) * pageSize
  const segFilter = segment ? sql`AND EXISTS (SELECT 1 FROM song_segments ss WHERE ss.song_id = s.song_id AND ss.segment = ${segment})` : sql``
  const searchFilter = search ? sql`AND (LOWER(s.artist) LIKE ${'%' + search.toLowerCase() + '%'} OR LOWER(s.title) LIKE ${'%' + search.toLowerCase() + '%'})` : sql``

  const [countRow] = await sql<{ total: string }[]>`SELECT COUNT(*)::text AS total FROM songs s WHERE 1=1 ${segFilter} ${searchFilter}`
  const total = +(countRow?.total ?? '0')

  const rows = await sql<SongRow[]>`
    SELECT s.song_id, s.artist, s.title, s.tier, s.feat, s.era, s.genre,
      ARRAY(SELECT ss.segment FROM song_segments ss WHERE ss.song_id = s.song_id) AS segments
    FROM songs s WHERE 1=1 ${segFilter} ${searchFilter}
    ORDER BY s.artist, s.title LIMIT ${pageSize} OFFSET ${offset}
  `
  return { songs: rows, total, page, pages: Math.ceil(total / pageSize) }
}

export async function upsertSong(data: { artist: string; title: string; tier: number; feat?: string; era?: string; genre?: string; segments: string[] }) {
  const songId = hash(data.artist + '|' + data.title)
  await sql`
    INSERT INTO songs (song_id, artist, title, tier, feat, era, genre, updated_at)
    VALUES (${songId}, ${data.artist}, ${data.title}, ${data.tier}, ${data.feat ?? null}, ${data.era ?? null}, ${data.genre ?? null}, NOW())
    ON CONFLICT (song_id) DO UPDATE SET
      artist = EXCLUDED.artist, title = EXCLUDED.title, tier = EXCLUDED.tier,
      feat = EXCLUDED.feat, era = EXCLUDED.era, genre = EXCLUDED.genre, updated_at = NOW()
  `
  await sql`DELETE FROM song_segments WHERE song_id = ${songId}`
  for (const seg of data.segments) {
    await sql`INSERT INTO song_segments (song_id, segment) VALUES (${songId}, ${seg}) ON CONFLICT DO NOTHING`
  }
  return songId
}

export async function updateSong(songId: string, data: { artist: string; title: string; tier: number; feat?: string; era?: string; genre?: string; segments: string[] }) {
  const newId = hash(data.artist + '|' + data.title)
  if (newId !== songId) {
    // Artist or title changed — need to re-key
    await sql`DELETE FROM song_segments WHERE song_id = ${songId}`
    await sql`DELETE FROM songs WHERE song_id = ${songId}`
  }
  await sql`
    INSERT INTO songs (song_id, artist, title, tier, feat, era, genre, updated_at)
    VALUES (${newId}, ${data.artist}, ${data.title}, ${data.tier}, ${data.feat ?? null}, ${data.era ?? null}, ${data.genre ?? null}, NOW())
    ON CONFLICT (song_id) DO UPDATE SET
      artist = EXCLUDED.artist, title = EXCLUDED.title, tier = EXCLUDED.tier,
      feat = EXCLUDED.feat, era = EXCLUDED.era, genre = EXCLUDED.genre, updated_at = NOW()
  `
  await sql`DELETE FROM song_segments WHERE song_id = ${newId}`
  for (const seg of data.segments) {
    await sql`INSERT INTO song_segments (song_id, segment) VALUES (${newId}, ${seg}) ON CONFLICT DO NOTHING`
  }
  return newId
}

export async function deleteSong(songId: string): Promise<boolean> {
  const [row] = await sql`DELETE FROM songs WHERE song_id = ${songId} RETURNING song_id`
  return !!row
}
