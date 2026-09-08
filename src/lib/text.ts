export function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

function matchSingle(a: string, b: string): boolean {
  if (a === b) return true
  if (a.replace(/ /g, '') === b.replace(/ /g, '')) return true
  const aw = a.split(' ')
  const bw = b.split(' ')
  const fa = aw[0]
  const fb = bw[0]
  if (fa.length <= 2 || fa !== fb) return false
  // El artista de Deezer (a) no puede tener más palabras que el del catálogo (b).
  // Evita que "Agapornis Pimpinela" matchee "Agapornis".
  return aw.length <= bw.length
}

export function matchArtist(a: string, b: string): boolean {
  const nb = norm(b)
  // Probar primero con el artista completo
  if (matchSingle(norm(a), nb)) return true
  // Si la API devuelve "Artista & Colaborador" o "A / B", probar cada parte
  const parts = a.split(/\s*[&,/]\s*|\s+feat\.?\s+|\s+ft\.?\s+/i)
  if (parts.length > 1) {
    for (const part of parts) {
      if (matchSingle(norm(part.trim()), nb)) return true
    }
  }
  return false
}

export const cleanTitle = (t: string) => t.replace(/[_.]mp3$/i, '').replace(/_/g, ' ')
