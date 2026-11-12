import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET ?? 'sacalo-dev-secret'
const JWT_EXPIRES = '30d'

export interface TokenPayload { id: number; nickname: string }

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES })
}

export function verifyToken(token: string): TokenPayload | null {
  try { return jwt.verify(token, JWT_SECRET) as TokenPayload } catch { return null }
}
