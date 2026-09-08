import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { RoomManager } from '../rooms.js'

describe('RoomManager', () => {
  let manager: RoomManager

  beforeEach(() => {
    vi.useFakeTimers()
    manager = new RoomManager()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('create', () => {
    it('returns a 4-char uppercase code', () => {
      const r = manager.create('s1', 'Gonza')
      expect('code' in r).toBe(true)
      if ('code' in r) expect(r.code).toMatch(/^[A-Z]{4}$/)
    })

    it('rejects empty nickname', () => {
      expect(manager.create('s1', '')).toEqual({ error: 'invalid-nickname' })
    })

    it('rejects nickname over 20 chars', () => {
      expect(manager.create('s1', 'a'.repeat(21))).toEqual({ error: 'invalid-nickname' })
    })

    it('trims whitespace-only nickname', () => {
      expect(manager.create('s1', '   ')).toEqual({ error: 'invalid-nickname' })
    })
  })

  describe('join', () => {
    it('lets a guest join a waiting room', () => {
      const { code } = manager.create('s1', 'Gonza') as { code: string }
      const r = manager.join('s2', code, 'Pipe')
      expect('room' in r).toBe(true)
      if ('room' in r) {
        expect(r.opponentNick).toBe('Gonza')
        expect(r.room.state).toBe('config')
      }
    })

    it('returns not-found for unknown code', () => {
      expect(manager.join('s2', 'ZZZZ', 'Pipe')).toEqual({ error: 'not-found' })
    })

    it('returns full when room already has 2 players', () => {
      const { code } = manager.create('s1', 'Gonza') as { code: string }
      manager.join('s2', code, 'Pipe')
      expect(manager.join('s3', code, 'Juan')).toEqual({ error: 'full' })
    })

    it('rejects duplicate nickname within a room', () => {
      const { code } = manager.create('s1', 'Gonza') as { code: string }
      expect(manager.join('s2', code, 'Gonza')).toEqual({ error: 'nickname-taken' })
    })
  })

  describe('startGame', () => {
    it('transitions room to playing and returns a song', () => {
      const { code } = manager.create('s1', 'Gonza') as { code: string }
      manager.join('s2', code, 'Pipe')
      const r = manager.startGame('s1')
      expect('error' in r).toBe(false)
      if ('songId' in r) {
        expect(typeof r.songId).toBe('string')
        expect(r.room.state).toBe('playing')
      }
    })

    it('rejects start from non-host', () => {
      const { code } = manager.create('s1', 'Gonza') as { code: string }
      manager.join('s2', code, 'Pipe')
      expect(manager.startGame('s2')).toEqual({ error: 'not-host' })
    })
  })

  describe('recordResult', () => {
    it('returns bothDone=false when only one player finishes', () => {
      const { code } = manager.create('s1', 'Gonza') as { code: string }
      manager.join('s2', code, 'Pipe')
      manager.startGame('s1')
      const r = manager.recordResult('s1', { won: true, stage: 1, timeMs: 500 })
      expect(r?.bothDone).toBe(false)
    })

    it('returns bothDone=true when both finish', () => {
      const { code } = manager.create('s1', 'Gonza') as { code: string }
      manager.join('s2', code, 'Pipe')
      manager.startGame('s1')
      manager.recordResult('s1', { won: true, stage: 1, timeMs: 500 })
      const r = manager.recordResult('s2', { won: false, stage: 99, timeMs: 0 })
      expect(r?.bothDone).toBe(true)
      expect(r?.room.state).toBe('result')
    })
  })

  describe('handleDisconnect during playing', () => {
    it('calls onTimeout with winner after 15s if player does not reconnect', () => {
      const { code } = manager.create('s1', 'Gonza') as { code: string }
      manager.join('s2', code, 'Pipe')
      manager.startGame('s1')
      const onTimeout = vi.fn()
      manager.handleDisconnect('s1', onTimeout)
      vi.advanceTimersByTime(15_000)
      expect(onTimeout).toHaveBeenCalledOnce()
      // Winner is s2 (the one who stayed)
      expect(onTimeout.mock.calls[0][1]).toBe('s2')
    })

    it('cancels timeout on reconnect', () => {
      const { code } = manager.create('s1', 'Gonza') as { code: string }
      manager.join('s2', code, 'Pipe')
      manager.startGame('s1')
      const onTimeout = vi.fn()
      manager.handleDisconnect('s1', onTimeout)
      manager.handleReconnect('s3', code, 'Gonza') // new socketId
      vi.advanceTimersByTime(15_000)
      expect(onTimeout).not.toHaveBeenCalled()
    })
  })
})
