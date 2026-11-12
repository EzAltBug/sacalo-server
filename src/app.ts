import express from 'express'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import rateLimit from 'express-rate-limit'
import { RoomManager } from './rooms.js'
import { BY_ID } from './lib/songs.js'
import type { ClientEvents, ServerEvents, PlayerResult, Room } from './types.js'
import { initDb, insertReport, getReportCounts, createPlayer, findPlayer, hashPin, getRanking, getPlayerStats, getPlayerRank, getPlayerHistory, insertMatch } from './lib/db.js'
import { signToken, verifyToken } from './lib/auth.js'
import { authRequired } from './lib/middleware.js'

export async function createApp() {
  await initDb()
  const expressApp = express()
  const httpServer = createServer(expressApp)
  const io = new Server<ClientEvents, ServerEvents>(httpServer, {
    cors: { origin: '*' },
  })

  expressApp.use(express.json())
  expressApp.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*')
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    if (_req.method === 'OPTIONS') { res.sendStatus(200); return }
    next()
  })

  expressApp.get('/health', (_, res) => {
    res.json({ ok: true })
  })

  const reportLimit = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false })

  expressApp.post('/report/broken', reportLimit, (req, res) => {
    const { artist, title } = req.body ?? {}
    if (artist && title) {
      insertReport('broken', artist, title).catch(() => {})
    }
    res.json({ ok: true })
  })

  expressApp.post('/report/wrong', reportLimit, (req, res) => {
    const { artist, title } = req.body ?? {}
    if (artist && title) {
      insertReport('wrong', artist, title).catch(() => {})
    }
    res.json({ ok: true })
  })

  expressApp.get('/admin/reports', async (req, res) => {
    const adminKey = process.env.ADMIN_KEY
    if (!adminKey || req.query.key !== adminKey) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const rows = await getReportCounts()
    res.json(rows)
  })

  const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false })

  expressApp.post('/auth/register', authLimit, async (req, res) => {
    const { nickname, pin } = req.body ?? {}
    if (!nickname || typeof nickname !== 'string' || nickname.trim().length < 1 || nickname.trim().length > 20) {
      res.status(400).json({ error: 'Nickname inválido (1-20 caracteres).' }); return
    }
    if (!pin || typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
      res.status(400).json({ error: 'El PIN debe ser de 4 dígitos.' }); return
    }
    const existing = await findPlayer(nickname.trim())
    if (existing) { res.status(409).json({ error: 'Ese nombre ya está registrado.' }); return }
    const player = await createPlayer(nickname.trim(), hashPin(pin))
    const token = signToken({ id: player.id, nickname: player.nickname })
    res.json({ token, nickname: player.nickname })
  })

  expressApp.post('/auth/login', authLimit, async (req, res) => {
    const { nickname, pin } = req.body ?? {}
    if (!nickname || !pin) { res.status(400).json({ error: 'Nickname y PIN son requeridos.' }); return }
    const player = await findPlayer(nickname.trim())
    if (!player || player.pin_hash !== hashPin(pin)) { res.status(401).json({ error: 'Nombre o PIN incorrecto.' }); return }
    const token = signToken({ id: player.id, nickname: player.nickname })
    res.json({ token, nickname: player.nickname })
  })

  expressApp.get('/ranking', async (req, res) => {
    const period = req.query.period === 'month' ? 'month' : 'all'
    const limit = Math.min(+(req.query.limit ?? 20), 100)
    const rows = await getRanking(period, limit)
    res.json(rows.map((r, i) => ({
      rank: i + 1, nickname: r.nickname, wins: +r.wins, losses: +r.losses,
      winRate: +r.win_rate, bestStreak: +r.best_streak, currentStreak: +r.current_streak,
    })))
  })

  expressApp.get('/me/stats', authRequired, async (req, res) => {
    const { id } = req.player!
    const stats = await getPlayerStats(id)
    const rank = await getPlayerRank(id, 'all')
    const monthlyRank = await getPlayerRank(id, 'month')
    res.json({ wins: +stats.wins, losses: +stats.losses, winRate: +stats.win_rate,
      bestStreak: +stats.best_streak, currentStreak: +stats.current_streak, rank, monthlyRank })
  })

  expressApp.get('/me/history', authRequired, async (req, res) => {
    const { id } = req.player!
    const page = Math.max(1, +(req.query.page ?? 1))
    res.json(await getPlayerHistory(id, page))
  })

  const manager = new RoomManager()
  const socketPlayers = new Map<string, { id: number; nickname: string }>()

  function determineWinner(players: PlayerResult[]): PlayerResult | undefined {
    return players.find((p) => {
      if (!p.won) return false
      const other = players.find((o) => o.nickname !== p.nickname)
      if (!other?.won) return true
      if (p.stage !== other.stage) return p.stage < other.stage
      return p.timeMs < other.timeMs
    })
  }

  async function recordMatchIfNeeded(room: Room) {
    const playerList = [...room.players.values()]
    const hasRegistered = playerList.some((p) => p.playerId !== null)
    if (!hasRegistered || !room.songId) return

    const results = playerList.map((p) => ({
      nickname: p.nickname,
      won: p.result?.won ?? false,
      stage: p.result?.stage ?? 99,
      timeMs: p.result?.timeMs ?? 0,
    }))
    const winner = determineWinner(results)
    const winnerPlayer = winner
      ? playerList.find((p) => p.nickname === winner.nickname)
      : undefined

    await insertMatch({
      player1Id: playerList[0]?.playerId ?? null,
      player2Id: playerList[1]?.playerId ?? null,
      winnerId: winnerPlayer?.playerId ?? null,
      songId: room.songId,
      diff: room.config.diff,
      segment: room.config.segment,
      players: playerList.map((p) => ({
        playerId: p.playerId,
        nickname: p.nickname,
        won: p.result?.won ?? false,
        stage: p.result?.stage ?? 99,
        timeMs: p.result?.timeMs ?? 0,
      })),
    }).catch((err) => console.error('Failed to record match:', err))
  }

  io.on('connection', (socket) => {
    // ── room:create ────────────────────────────────────────────────
    socket.on('room:create', ({ nickname, token }) => {
      let playerId: number | null = null
      if (token) {
        const payload = verifyToken(token)
        if (payload) {
          playerId = payload.id
          socketPlayers.set(socket.id, payload)
        }
      }
      const result = manager.create(socket.id, nickname, playerId)
      if ('error' in result) {
        socket.emit('room:error', { reason: result.error })
        return
      }
      socket.join(result.code)
      socket.emit('room:created', { code: result.code })
    })

    // ── room:join (also handles reconnections) ─────────────────────
    socket.on('room:join', ({ code, nickname, token }) => {
      let playerId: number | null = null
      if (token) {
        const payload = verifyToken(token)
        if (payload) {
          playerId = payload.id
          socketPlayers.set(socket.id, payload)
        }
      }

      // Check reconnection first
      const reconnected = manager.handleReconnect(socket.id, code, nickname)
      if (reconnected) {
        socket.join(code)
        const opponentId =
          socket.id === reconnected.hostSocketId
            ? reconnected.guestSocketId
            : reconnected.hostSocketId
        if (opponentId) {
          socket.to(opponentId).emit('room:opponent-reconnected')
        }
        socket.emit('room:joined', {
          opponentNick: opponentId
            ? (reconnected.players.get(opponentId)?.nickname ?? '')
            : '',
          config: reconnected.config,
        })
        return
      }

      const result = manager.join(socket.id, code, nickname, playerId)
      if ('error' in result) {
        socket.emit('room:error', { reason: result.error })
        return
      }
      socket.join(code)
      const guestNick = result.room.players.get(socket.id)!.nickname
      socket.emit('room:joined', { opponentNick: result.opponentNick, config: result.room.config })
      socket.to(result.room.hostSocketId).emit('room:joined', {
        opponentNick: guestNick,
        config: result.room.config,
      })
    })

    // ── room:config ────────────────────────────────────────────────
    socket.on('room:config', ({ diff, segment }) => {
      const room = manager.setConfig(socket.id, { diff, segment })
      if (!room || !room.guestSocketId) return
      socket.to(room.guestSocketId).emit('room:config-updated', { config: room.config })
    })

    // ── room:start ─────────────────────────────────────────────────
    socket.on('room:start', () => {
      const result = manager.startGame(socket.id)
      if ('error' in result) {
        socket.emit('room:error', { reason: result.error })
        return
      }
      const { room, songId, offset } = result
      if (!BY_ID[songId]) return
      io.to(room.code).emit('game:song', { songId, offset, diff: room.config.diff })
    })

    // ── game:won ───────────────────────────────────────────────────
    socket.on('game:won', ({ stage, timeMs }) => {
      const r = manager.recordResult(socket.id, { won: true, stage, timeMs })
      if (!r) return
      if (r.opponentSocketId) {
        socket.to(r.opponentSocketId).emit('game:opponent-done', { won: true, stage, timeMs })
      }
      if (r.bothDone) {
        io.to(r.room.code).emit('game:result', { players: buildResults(r.room) })
        recordMatchIfNeeded(r.room)
      }
    })

    // ── game:lost ──────────────────────────────────────────────────
    socket.on('game:lost', () => {
      const r = manager.recordResult(socket.id, { won: false, stage: 99, timeMs: 0 })
      if (!r) return
      if (r.opponentSocketId) {
        socket.to(r.opponentSocketId).emit('game:opponent-done', {
          won: false,
          stage: 99,
          timeMs: 0,
        })
      }
      if (r.bothDone) {
        io.to(r.room.code).emit('game:result', { players: buildResults(r.room) })
        recordMatchIfNeeded(r.room)
      }
    })

    // ── room:rematch ───────────────────────────────────────────────
    socket.on('room:rematch', ({ quick = false } = {} as { quick?: boolean }) => {
      const room = manager.requestRematch(socket.id, (r) => {
        io.to(r.code).emit('room:error', { reason: 'rematch-timeout' })
      }, quick)
      if (!room) return
      const opponentId =
        socket.id === room.hostSocketId ? room.guestSocketId : room.hostSocketId
      if (opponentId) socket.to(opponentId).emit('room:rematch-requested', { quick })
    })

    // ── room:rematch-accept ────────────────────────────────────────
    socket.on('room:rematch-accept', () => {
      const room = manager.acceptRematch(socket.id)
      if (!room) return
      if (room.rematchQuick) {
        const result = manager.startGame(room.hostSocketId)
        if ('error' in result) {
          io.to(room.code).emit('room:error', { reason: result.error })
          return
        }
        if (!BY_ID[result.songId]) return
        io.to(room.code).emit('game:song', { songId: result.songId, offset: result.offset, diff: room.config.diff })
      } else {
        io.to(room.code).emit('room:rematch-ready', { config: room.config })
      }
    })

    // ── room:rematch-reject ────────────────────────────────────────
    socket.on('room:rematch-reject', () => {
      const r = manager.rejectRematch(socket.id)
      if (!r) return
      if (r.opponentId) {
        io.to(r.opponentId).emit('room:error', { reason: 'rematch-rejected' })
      }
    })

    // ── room:leave ─────────────────────────────────────────────────
    socket.on('room:leave', () => {
      const r = manager.leave(socket.id)
      if (!r) return
      if (r.opponentId) {
        io.to(r.opponentId).emit('room:error', { reason: 'opponent-left' })
      }
      socket.leave(r.room.code)
    })

    // ── disconnect ─────────────────────────────────────────────────
    socket.on('disconnect', () => {
      socketPlayers.delete(socket.id)
      const r = manager.handleDisconnect(socket.id, (room, winnerSocketId) => {
        const winner = room.players.get(winnerSocketId)
        const loser = [...room.players.values()].find((p) => p.socketId !== winnerSocketId)
        if (!winner) return
        const players: PlayerResult[] = [
          { nickname: winner.nickname, won: true, stage: 0, timeMs: 0 },
          ...(loser ? [{ nickname: loser.nickname, won: false, stage: 99, timeMs: 0 }] : []),
        ]
        io.to(winnerSocketId).emit('room:opponent-left')
        io.to(winnerSocketId).emit('game:result', { players })
        // Record match on disconnect timeout
        if (room.songId && (winner.playerId !== null || (loser?.playerId ?? null) !== null)) {
          insertMatch({
            player1Id: winner.playerId ?? null,
            player2Id: loser?.playerId ?? null,
            winnerId: winner.playerId ?? null,
            songId: room.songId,
            diff: room.config.diff,
            segment: room.config.segment,
            players: [
              { playerId: winner.playerId ?? null, nickname: winner.nickname, won: true, stage: 0, timeMs: 0 },
              ...(loser ? [{ playerId: loser.playerId ?? null, nickname: loser.nickname, won: false, stage: 99, timeMs: 0 }] : []),
            ],
          }).catch((err) => console.error('Failed to record disconnect match:', err))
        }
      })

      if (!r) return
      const { room, wasGuest } = r
      const opponentId =
        socket.id === room.hostSocketId ? room.guestSocketId : room.hostSocketId

      if (room.state === 'playing' && opponentId) {
        socket.to(opponentId).emit('room:opponent-disconnected', { waitSecs: 15 })
      }
      if (!wasGuest && room.state === 'waiting') {
        // Host left before game started — notify guest if any
        socket.to(room.code).emit('room:error', { reason: 'host-left' })
      }
    })
  })

  return { expressApp, httpServer, io }
}

function buildResults(room: Room): PlayerResult[] {
  return [...room.players.values()].map((p) => ({
    nickname: p.nickname,
    won: p.result?.won ?? false,
    stage: p.result?.stage ?? 99,
    timeMs: p.result?.timeMs ?? 0,
  }))
}
