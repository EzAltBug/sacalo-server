export type SegmentId = 'argentina' | 'reggaeton' | 'rock80s' | 'trap' | 'hits'
export type SegmentFilter = SegmentId | 'todas'

export interface Segment {
  id: SegmentId
  name: string
  color: string
}

export const SEGMENTS: Segment[] = [
  { id: 'argentina', name: 'Argentina', color: '#75aadb' },
  { id: 'reggaeton', name: 'Reggaeton viejo', color: '#f59e0b' },
  { id: 'rock80s', name: 'Rock 80s', color: '#e11d48' },
  { id: 'trap', name: 'Trap', color: '#8b5cf6' },
  { id: 'hits', name: 'Greatest Hits', color: '#10b981' },
]

export const SEGMENT_MAP: Record<SegmentId, Segment> = Object.fromEntries(
  SEGMENTS.map((s) => [s.id, s]),
) as Record<SegmentId, Segment>

export function segmentLabel(id: SegmentFilter): string {
  if (id === 'todas') return 'Todas'
  return SEGMENT_MAP[id]?.name ?? id
}
