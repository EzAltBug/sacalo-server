import postgres from 'postgres'

const sql = postgres(process.env.DATABASE_URL!, { ssl: 'require' })

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
