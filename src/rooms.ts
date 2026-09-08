import { pool, drawDiff } from './lib/game.js'
import type { Room, Player, RoomConfig } from './types.js'

const ROOM_TTL_MS = 30 * 60 * 1000
const DISCONNECT_WAIT_MS = 15_000
const REMATCH_TIMEOUT_MS = 30_000
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ' // excluye I y O

export class RoomManager {
  private rooms = new Map<string, Room>()
  private socketToRoom = new Map<string, string>() // socketId → code

  private generateCode(): string {
    let code: string
    do {
      code = Array.from({ length: 4 }, () =>
        CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)],
      ).join('')
    } while (this.rooms.has(code))
    return code
  }

  create(socketId: string, nickname: string): { code: string } | { error: string } {
    const nick = nickname.trim()
    if (!nick || nick.length > 20) return { error: 'invalid-nickname' }

    const code = this.generateCode()
    const player: Player = { socketId, nickname: nick, result: null, disconnectTimer: null }
    const expiryTimer = setTimeout(() => this.destroyRoom(code), ROOM_TTL_MS)
    const room: Room = {
      code,
      state: 'waiting',
      hostSocketId: socketId,
      guestSocketId: null,
      config: { diff: 'medio', era: 'any', gen: 'any' },
      songId: null,
      offset: null,
      players: new Map([[socketId, player]]),
      expiryTimer,
      rematchTimer: null,
      rematchQuick: null,
    }
    this.rooms.set(code, room)
    this.socketToRoom.set(socketId, code)
    return { code }
  }

  join(
    socketId: string,
    code: string,
    nickname: string,
  ): { room: Room; opponentNick: string } | { error: string } {
    const nick = nickname.trim()
    if (!nick || nick.length > 20) return { error: 'invalid-nickname' }

    const room = this.rooms.get(code)
    if (!room) return { error: 'not-found' }
    if (room.guestSocketId !== null) return { error: 'full' }
    if (room.state !== 'waiting') return { error: 'in-progress' }

    // Reject duplicate nickname within room
    for (const p of room.players.values()) {
      if (p.nickname.toLowerCase() === nick.toLowerCase()) return { error: 'nickname-taken' }
    }

    const host = room.players.get(room.hostSocketId)!
    const guest: Player = { socketId, nickname: nick, result: null, disconnectTimer: null }
    room.players.set(socketId, guest)
    room.guestSocketId = socketId
    room.state = 'config'
    this.socketToRoom.set(socketId, code)
    return { room, opponentNick: host.nickname }
  }

  setConfig(socketId: string, config: Partial<RoomConfig>): Room | null {
    const room = this.getRoomBySocket(socketId)
    if (!room || room.hostSocketId !== socketId) return null
    room.config = { ...room.config, ...config }
    return room
  }

  startGame(socketId: string): { room: Room; songId: string; offset: number } | { error: string } {
    const room = this.getRoomBySocket(socketId)
    if (!room) return { error: 'not-found' }
    if (room.hostSocketId !== socketId) return { error: 'not-host' }
    if (room.state !== 'config') return { error: 'wrong-state' }
    if (!room.guestSocketId) return { error: 'no-opponent' }

    const diff = drawDiff(room.config.diff)
    const { songs } = pool(diff, room.config.era, room.config.gen, new Set())
    if (!songs.length) return { error: 'no-songs' }

    const song = songs[Math.floor(Math.random() * songs.length)]
    room.state = 'playing'
    room.songId = song.id
    room.offset = 0
    for (const p of room.players.values()) p.result = null

    return { room, songId: song.id, offset: 0 }
  }

  recordResult(
    socketId: string,
    result: { won: boolean; stage: number; timeMs: number },
  ): { room: Room; bothDone: boolean; opponentSocketId: string | null } | null {
    const room = this.getRoomBySocket(socketId)
    if (!room || room.state !== 'playing') return null
    const player = room.players.get(socketId)
    if (!player) return null

    player.result = result
    const opponentId =
      socketId === room.hostSocketId ? room.guestSocketId : room.hostSocketId
    const opponent = opponentId ? room.players.get(opponentId) : null
    const bothDone = opponent?.result !== null && opponent?.result !== undefined

    if (bothDone) room.state = 'result'
    return { room, bothDone, opponentSocketId: opponentId }
  }

  handleDisconnect(
    socketId: string,
    onTimeout: (room: Room, winnerSocketId: string) => void,
  ): { room: Room; wasGuest: boolean } | null {
    const room = this.getRoomBySocket(socketId)
    if (!room) return null
    const player = room.players.get(socketId)
    if (!player) return null

    const isHost = socketId === room.hostSocketId
    const isGuest = socketId === room.guestSocketId

    // Host leaves while waiting → destroy room
    if (isHost && room.state === 'waiting') {
      this.destroyRoom(room.code)
      return { room, wasGuest: false }
    }

    // Guest leaves during config → downgrade to waiting
    if (isGuest && room.state === 'config') {
      room.guestSocketId = null
      room.state = 'waiting'
      room.players.delete(socketId)
      this.socketToRoom.delete(socketId)
      return { room, wasGuest: true }
    }

    // During playing → start disconnect timer
    if (room.state === 'playing') {
      const opponentId = isHost ? room.guestSocketId : room.hostSocketId
      player.disconnectTimer = setTimeout(() => {
        if (opponentId) onTimeout(room, opponentId)
        this.destroyRoom(room.code)
      }, DISCONNECT_WAIT_MS)
    }

    return { room, wasGuest: isGuest }
  }

  handleReconnect(newSocketId: string, code: string, nickname: string): Room | null {
    const room = this.rooms.get(code)
    if (!room) return null
    const nick = nickname.trim().toLowerCase()

    for (const [oldId, player] of room.players) {
      if (player.nickname.toLowerCase() === nick && player.disconnectTimer !== null) {
        clearTimeout(player.disconnectTimer)
        player.disconnectTimer = null
        // Swap socket id
        room.players.delete(oldId)
        player.socketId = newSocketId
        room.players.set(newSocketId, player)
        this.socketToRoom.delete(oldId)
        this.socketToRoom.set(newSocketId, code)
        if (oldId === room.hostSocketId) room.hostSocketId = newSocketId
        if (oldId === room.guestSocketId) room.guestSocketId = newSocketId
        return room
      }
    }
    return null
  }

  requestRematch(socketId: string, onTimeout: (room: Room) => void, quick = false): Room | null {
    const room = this.getRoomBySocket(socketId)
    if (!room || room.state !== 'result') return null
    if (room.rematchTimer) clearTimeout(room.rematchTimer)
    room.rematchTimer = setTimeout(() => {
      onTimeout(room)
      this.destroyRoom(room.code)
    }, REMATCH_TIMEOUT_MS)
    room.rematchQuick = quick
    return room
  }

  acceptRematch(socketId: string): Room | null {
    const room = this.getRoomBySocket(socketId)
    if (!room || room.state !== 'result') return null
    if (room.rematchTimer) clearTimeout(room.rematchTimer)
    room.rematchTimer = null
    room.state = 'config'
    return room
  }

  rejectRematch(socketId: string): { room: Room; opponentId: string | null } | null {
    const room = this.getRoomBySocket(socketId)
    if (!room) return null
    const opponentId =
      socketId === room.hostSocketId ? room.guestSocketId : room.hostSocketId
    if (room.rematchTimer) clearTimeout(room.rematchTimer)
    this.destroyRoom(room.code)
    return { room, opponentId }
  }

  leave(socketId: string): { room: Room; opponentId: string | null } | null {
    const room = this.getRoomBySocket(socketId)
    if (!room) return null
    const opponentId =
      socketId === room.hostSocketId ? room.guestSocketId : room.hostSocketId
    this.destroyRoom(room.code)
    return { room, opponentId }
  }

  getRoomBySocket(socketId: string): Room | null {
    const code = this.socketToRoom.get(socketId)
    return code ? (this.rooms.get(code) ?? null) : null
  }

  private destroyRoom(code: string) {
    const room = this.rooms.get(code)
    if (!room) return
    clearTimeout(room.expiryTimer)
    if (room.rematchTimer) clearTimeout(room.rematchTimer)
    for (const p of room.players.values()) {
      if (p.disconnectTimer) clearTimeout(p.disconnectTimer)
      this.socketToRoom.delete(p.socketId)
    }
    this.rooms.delete(code)
  }
}
