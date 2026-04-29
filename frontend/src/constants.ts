export const SEGMENTS = [
  'Groomsmen Getting Ready',
  'Bride Getting Ready',
  'First Look',
  'Ceremony',
  'Cocktail Hour',
  'Reception / First Dance',
  'Toasts',
  'Drone / Aerial',
  'Ambiance / BTS',
  'Backup',
] as const

export type SegmentName = typeof SEGMENTS[number]

export const SHAKE_THRESHOLD = 0.5
export const BLUR_THRESHOLD = 0.5

// These match the task spec: pre-approve clips below both thresholds
export const AUTO_APPROVE_SHAKE = 0.4
export const AUTO_APPROVE_BLUR = 0.4
