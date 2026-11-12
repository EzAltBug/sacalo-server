import postgres from 'postgres'
import { createHash } from 'node:crypto'

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
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `
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
}

export async function insertReport(type: 'broken' | 'wrong', artist: string, title: string) {
  await sql`INSERT INTO reports (type, artist, title) VALUES (${type}, ${artist}, ${title})`
}

export async function getReportCounts() {
  return sql<{ type: string; artist: string; title: string; count: string }[]>`
    SELECT type, artist, title, COUNT(*)::text AS count
    FROM reports
    GROUP BY type, artist, title
    ORDER BY type, COUNT(*) DESC
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
