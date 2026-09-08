import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { io as Client, type Socket } from 'socket.io-client'
import { createApp } from '../app.js'
import type { ServerEvents, ClientEvents } from '../types.js'

const PORT = 3099

function connect(): Socket<ServerEvents, ClientEvents> {
  return Client(`http://localhost:${PORT}`, { autoConnect: true })
}

function waitFor<T>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve) => socket.once(event, resolve as () => void))
}

describe('Sacalo server integration', () => {
  let server: ReturnType<typeof createApp>['httpServer']

  beforeAll(async () => {
    const app = createApp()
    server = app.httpServer
    await new Promise<void>((resolve) => server.listen(PORT, resolve))
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('GET /health returns ok', async () => {
    const res = await fetch(`http://localhost:${PORT}/health`)
    const json = await res.json()
    expect(json.ok).toBe(true)
  })

  it('creates a room and guest joins, then host starts game', async () => {
    const host = connect()
    const guest = connect()

    await waitFor(host, 'connect')
    await waitFor(guest, 'connect')

    host.emit('room:create', { nickname: 'Gonza' })
    const { code } = await waitFor<{ code: string }>(host, 'room:created')
    expect(code).toMatch(/^[A-Z]{4}$/)

    guest.emit('room:join', { code, nickname: 'Pipe' })
    const [guestJoined, hostJoined] = await Promise.all([
      waitFor<{ opponentNick: string }>(guest, 'room:joined'),
      waitFor<{ opponentNick: string }>(host, 'room:joined'),
    ])
    expect(guestJoined.opponentNick).toBe('Gonza')
    expect(hostJoined.opponentNick).toBe('Pipe')

    host.emit('room:start')
    const [hostSong, guestSong] = await Promise.all([
      waitFor<{ songId: string }>(host, 'game:song'),
      waitFor<{ songId: string }>(guest, 'game:song'),
    ])
    expect(hostSong.songId).toBe(guestSong.songId)

    host.disconnect()
    guest.disconnect()
  })

  it('emits game:result when both players finish', async () => {
    const host = connect()
    const guest = connect()
    await waitFor(host, 'connect')
    await waitFor(guest, 'connect')

    host.emit('room:create', { nickname: 'A' })
    const { code } = await waitFor<{ code: string }>(host, 'room:created')
    guest.emit('room:join', { code, nickname: 'B' })
    await Promise.all([waitFor(host, 'room:joined'), waitFor(guest, 'room:joined')])

    host.emit('room:start')
    await Promise.all([waitFor(host, 'game:song'), waitFor(guest, 'game:song')])

    host.emit('game:won', { stage: 1, timeMs: 500 })
    guest.emit('game:lost')

    const [hostResult, guestResult] = await Promise.all([
      waitFor<{ players: unknown[] }>(host, 'game:result'),
      waitFor<{ players: unknown[] }>(guest, 'game:result'),
    ])
    expect(hostResult.players).toHaveLength(2)
    expect(guestResult.players).toHaveLength(2)

    host.disconnect()
    guest.disconnect()
  })
})
