import type { Request, Response, NextFunction } from 'express'
import { verifyToken, type TokenPayload } from './auth.js'

declare global {
  namespace Express {
    interface Request {
      player?: TokenPayload
    }
  }
}

export function authRequired(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) { res.status(401).json({ error: 'Token requerido.' }); return }
  const payload = verifyToken(header.slice(7))
  if (!payload) { res.status(401).json({ error: 'Token inválido o expirado.' }); return }
  req.player = payload
  next()
}
