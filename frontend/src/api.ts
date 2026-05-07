import axios from 'axios'
import type { AnalysisJob, ClipResult, CreateJobRequest, UpdateClipRequest } from './types'

// When the frontend is served by FastAPI (production / Resolve flow on :8000)
// use a same-origin BASE_URL so the browser doesn't fire CORS preflights and
// then block the request. In Vite dev (port 5173) the page origin isn't the
// API, so fall back to the explicit localhost:8000 — main.py CORS allow-list
// covers that case.
export const BASE_URL = (() => {
  if (typeof window === 'undefined' || !window.location.protocol.startsWith('http')) {
    return 'http://localhost:8000'
  }
  if (window.location.port === '5173') {
    return 'http://localhost:8000'
  }
  return window.location.origin
})()

const client = axios.create({
  baseURL: BASE_URL,
  headers: { 'Content-Type': 'application/json' },
})

// Maps backend's nested ClipReview → flat ClipResult used by the UI
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toClipResult(raw: any): ClipResult {
  const scores = raw.scores ?? {}
  return {
    id: raw.clip_id,
    file_path: raw.path ?? '',
    filename: raw.filename ?? '',
    duration_sec: scores.duration_sec ?? 0,
    thumbnail_path: raw.thumbnail_path ?? null,
    shake_score: scores.shake_score ?? 0,
    blur_score: scores.blur_score ?? 0,
    exposure_score: scores.exposure_ok ? 0.5 : 0.1,
    is_duplicate: scores.duplicate_of != null,
    duplicate_of: scores.duplicate_of ?? null,
    suggested_segment: raw.segment_label ?? raw.suggested_segment ?? 'Backup',
    approved: raw.approved ?? null,
    near_miss: raw.near_miss ?? false,
    reject_reason: null,
    ai_caption: scores.ai_caption ?? null,
    ai_rationale: scores.ai_rationale ?? null,
    ai_moment: scores.ai_moment ?? null,
    ai_quality: scores.ai_quality ?? null,
    ai_subjects: scores.ai_subjects ?? [],
    ai_in_sec: scores.ai_in_sec ?? null,
    ai_out_sec: scores.ai_out_sec ?? null,
    ai_skip: scores.ai_skip ?? false,
    ai_skip_reason: scores.ai_skip_reason ?? null,
    transcript: scores.transcript ?? null,
    rank_in_group: scores.rank_in_group ?? null,
    sequence_position: scores.sequence_position ?? null,
    dialogue_trimmed: scores.dialogue_trimmed ?? false,
    needs_stabilization: scores.needs_stabilization ?? false,
    analysis_sec: scores.analysis_sec ?? null,
    ai_reasoning: Array.isArray(scores.ai_reasoning) ? scores.ai_reasoning : [],
    word_count: Array.isArray(scores.words) ? scores.words.length : 0,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toJob(raw: any): AnalysisJob {
  return { ...raw, clips: (raw.clips ?? []).map(toClipResult) }
}

export interface FsEntry {
  name: string
  path: string
  is_dir: boolean
  is_video: boolean
  size_bytes: number
}

export interface FsListResponse {
  path: string
  parent: string | null
  entries: FsEntry[]
  video_count: number
}

export interface SequenceWord {
  word: string
  start_sec: number
  end_sec: number
  speaker_tag: number | null
}

export interface SequenceItem {
  clip_id: string
  filename: string
  segment: string
  clip_type: 'AROLL' | 'BROLL'
  duration_sec: number
  ai_in_sec: number | null
  ai_out_sec: number | null
  ai_quality: number | null
  ai_caption: string | null
  transcript: string | null
  words: SequenceWord[]
  sequence_position: number | null
  placement_confidence: number | null
  approved: boolean | null
  rank_in_group: number | null
  thumbnail_url: string
  stream_url: string
  timeline_position: number
}

export interface SequenceResponse {
  job_id: string
  speaker_tags: number[]
  speaker_names: Record<string, string>
  items: SequenceItem[]
}

export interface AiInfo {
  backend: 'vertex' | 'local' | 'cloud'
  label: string
  vlm_model: string | null
  clip_model: string | null
  has_key: boolean
}

export interface OnboardingStatus {
  provider: 'gemini'
  has_key: boolean
}

export interface OnboardingTestResult {
  ok: boolean
  error?: string
}

export interface LocalModelStatus {
  vlm_model: string
  clip_model: string
  vlm_cached: boolean
  clip_cached: boolean
  running: boolean
  done: boolean
  error: string | null
}

export const api = {
  aiInfo: (): Promise<AiInfo> =>
    client.get('/ai/info').then((r) => r.data),

  onboardingStatus: (): Promise<OnboardingStatus> =>
    client.get('/onboarding/status').then((r) => r.data),

  onboardingTest: (apiKey: string): Promise<OnboardingTestResult> =>
    client.post('/onboarding/test', { api_key: apiKey }).then((r) => r.data),

  onboardingSave: (apiKey: string): Promise<{ ok: boolean; provider: string }> =>
    client.post('/onboarding/save', { api_key: apiKey }).then((r) => r.data),

  onboardingDelete: (): Promise<{ removed: boolean }> =>
    client.delete('/onboarding/key').then((r) => r.data),

  onboardingSelect: (provider: 'gemini' | 'vertex'): Promise<{ ok: boolean; provider: string }> =>
    client.post('/onboarding/select', { provider }).then((r) => r.data),

  onboardingVertexTest: (creds: {
    project_id: string
    region: string
    service_account_json: string
  }): Promise<OnboardingTestResult> =>
    client.post('/onboarding/vertex/test', creds).then((r) => r.data),

  onboardingVertexSave: (creds: {
    project_id: string
    region: string
    service_account_json: string
  }): Promise<{ ok: boolean; provider: string; project_id: string; region: string }> =>
    client.post('/onboarding/vertex/save', creds).then((r) => r.data),

  localStatus: (): Promise<LocalModelStatus> =>
    client.get('/ai/local/status').then((r) => r.data),

  startWarmup: (): Promise<{ status: string }> =>
    client.post('/ai/local/warmup').then((r) => r.data),

  warmupLogs: (since: number): Promise<{ lines: string[]; total: number }> =>
    client.get('/ai/local/logs', { params: { since } }).then((r) => r.data),

  fsList: (path?: string): Promise<FsListResponse> =>
    client.get('/fs/list', { params: path ? { path } : {} }).then((r) => r.data),

  createJob: (data: CreateJobRequest): Promise<AnalysisJob> =>
    client.post('/jobs', data).then((r) => toJob(r.data)),

  listJobs: (): Promise<AnalysisJob[]> =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client.get('/jobs').then((r) => (r.data as any[]).map(toJob)),

  getJob: (id: string): Promise<AnalysisJob> =>
    client.get(`/jobs/${id}`).then((r) => toJob(r.data)),

  getProgress: (id: string): Promise<{ progress: number; status: string }> =>
    client.get(`/jobs/${id}/progress`).then((r) => r.data),

  getLogs: (id: string, since: number): Promise<{ lines: string[]; total: number }> =>
    client.get(`/jobs/${id}/logs`, { params: { since } }).then((r) => r.data),

  patchClip: (jobId: string, clipId: string, patch: UpdateClipRequest): Promise<ClipResult> =>
    client
      .patch(`/jobs/${jobId}/clips/${clipId}`, {
        approved: patch.approved,
        near_miss: patch.near_miss,
        segment_label: patch.suggested_segment,
        sequence_position: patch.sequence_position,
        ai_in_sec: patch.ai_in_sec,
        ai_out_sec: patch.ai_out_sec,
      })
      .then((r) => toClipResult(r.data)),

  getSequence: (jobId: string): Promise<SequenceResponse> =>
    client.get(`/jobs/${jobId}/sequence`).then((r) => r.data),

  getSpeakers: (jobId: string): Promise<Record<string, string>> =>
    client.get(`/jobs/${jobId}/speakers`).then((r) => r.data),

  putSpeakers: (jobId: string, names: Record<string, string>): Promise<Record<string, string>> =>
    client.put(`/jobs/${jobId}/speakers`, { speaker_names: names }).then((r) => r.data),

  approveAll: (jobId: string): Promise<{ approved: number; rejected: number; total: number }> =>
    client.post(`/jobs/${jobId}/approve-all`).then((r) => r.data),

  exportResolve: (jobId: string, projectName: string): Promise<void> =>
    client.post(`/jobs/${jobId}/export/resolve`, { project_name: projectName }).then(() => undefined),

  resolveMediaPool: (): Promise<{
    project_name: string
    clips: { path: string; name: string }[]
  }> => client.get('/resolve/media-pool').then((r) => r.data),

  createJobFromPaths: (
    paths: string[],
    sourceName?: string,
  ): Promise<AnalysisJob> =>
    client
      .post('/jobs/from-paths', { paths, source_name: sourceName })
      .then((r) => toJob(r.data)),

  resolvePush: (
    jobId: string,
    opts: { mode?: 'new_timeline' | 'append'; include_near_miss?: boolean; include_rejected?: boolean } = {},
  ): Promise<{
    ok: boolean
    project_name?: string
    timeline_name?: string
    clips_added?: number
    clips_skipped?: number
    errors?: string[]
    error?: string
  }> =>
    client
      .post(`/jobs/${jobId}/resolve/push`, {
        mode: opts.mode ?? 'new_timeline',
        include_near_miss: opts.include_near_miss ?? true,
        include_rejected: opts.include_rejected ?? false,
      })
      .then((r) => r.data),

  exportFcpxml: (jobId: string, outputPath: string): Promise<void> =>
    client.post(`/jobs/${jobId}/export/fcpxml`, { output_path: outputPath }).then(() => undefined),

  thumbnailUrl: (jobId: string, clipId: string): string =>
    `${BASE_URL}/thumbnails/${jobId}/${clipId}`,

  clipStreamUrl: (jobId: string, clipId: string): string =>
    `${BASE_URL}/clips/${jobId}/${clipId}`,
}
