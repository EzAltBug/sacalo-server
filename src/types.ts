import type { DiffKey, EraFilter, GenFilter } from './lib/game.js'

export interface Player {
  socketId: string
  nickname: string
  result: { won: boolean; stage: number; timeMs: number } | null
  disconnectTimer: ReturnType<typeof setTimeout> | null
}

export interface RoomConfig {
  diff: DiffKey
  era: EraFilter
  gen: GenFilter
}

export interface Room {
  code: string
  state: 'waiting' | 'config' | 'countdown' | 'playing' | 'result'
  hostSocketId: string
  guestSocketId: string | null
  config: RoomConfig
  songId: string | null
  offset: number | null
  players: Map<string, Player>
  expiryTimer: ReturnType<typeof setTimeout>
  rematchTimer: ReturnType<typeof setTimeout> | null
  rematchQuick: boolean | null
}

export interface PlayerResult {
  nickname: string
  won: boolean
  stage: number
  timeMs: number
}

// Payloads de eventos Socket.io (cliente → servidor)
export interface ClientEvents {
  'room:create': (payload: { nickname: string }) => void
  'room:join': (payload: { code: string; nickname: string }) => void
  'room:config': (payload: { diff: DiffKey; era: EraFilter; gen: GenFilter }) => void
  'room:start': () => void
  'game:won': (payload: { stage: number; timeMs: number }) => void
  'game:lost': () => void
  'room:rematch': (payload: { quick: boolean }) => void
  'room:rematch-accept': () => void
  'room:rematch-reject': () => void
  'room:leave': () => void
}

// Payloads de eventos Socket.io (servidor → cliente)
export interface ServerEvents {
  'room:created': (payload: { code: string }) => void
  'room:joined': (payload: { opponentNick: string; config: RoomConfig }) => void
  'room:error': (payload: { reason: string }) => void
  'room:config-updated': (payload: { config: RoomConfig }) => void
  'game:song': (payload: { songId: string; offset: number; diff: DiffKey }) => void
  'game:opponent-done': (payload: { won: boolean; stage: number; timeMs: number }) => void
  'game:result': (payload: { players: PlayerResult[] }) => void
  'room:opponent-disconnected': (payload: { waitSecs: number }) => void
  'room:opponent-reconnected': () => void
  'room:opponent-left': () => void
  'room:rematch-requested': (payload: { quick: boolean }) => void
  'room:rematch-ready': (payload: { config: RoomConfig }) => void
}
