import express from 'express'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import { RoomManager } from './rooms.js'
import { BY_ID } from './lib/songs.js'
import type { ClientEvents, ServerEvents, PlayerResult, Room } from './types.js'

export function createApp() {
  const expressApp = express()
  const httpServer = createServer(expressApp)
  const io = new Server<ClientEvents, ServerEvents>(httpServer, {
    cors: { origin: '*' },
  })

  expressApp.get('/health', (_, res) => {
    res.json({ ok: true })
  })

  const manager = new RoomManager()

  io.on('connection', (socket) => {
    // ── room:create ────────────────────────────────────────────────
    socket.on('room:create', ({ nickname }) => {
      const result = manager.create(socket.id, nickname)
      if ('error' in result) {
        socket.emit('room:error', { reason: result.error })
        return
      }
      socket.join(result.code)
      socket.emit('room:created', { code: result.code })
    })

    // ── room:join (also handles reconnections) ─────────────────────
    socket.on('room:join', ({ code, nickname }) => {
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

      const result = manager.join(socket.id, code, nickname)
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
    socket.on('room:config', ({ diff, era, gen }) => {
      const room = manager.setConfig(socket.id, { diff, era, gen })
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
      }
    })

    // ── room:rematch ───────────────────────────────────────────────
    socket.on('room:rematch', () => {
      const room = manager.requestRematch(socket.id, (r) => {
        io.to(r.code).emit('room:error', { reason: 'rematch-timeout' })
      })
      if (!room) return
      const opponentId =
        socket.id === room.hostSocketId ? room.guestSocketId : room.hostSocketId
      if (opponentId) socket.to(opponentId).emit('room:rematch-requested')
    })

    // ── room:rematch-accept ────────────────────────────────────────
    socket.on('room:rematch-accept', () => {
      const room = manager.acceptRematch(socket.id)
      if (!room) return
      io.to(room.code).emit('room:rematch-ready', { config: room.config })
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
