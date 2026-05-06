import axios from 'axios'
import type { AnalysisJob, ClipResult, CreateJobRequest, UpdateClipRequest } from './types'

export const BASE_URL = 'http://localhost:8000'

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
    reject_reason: null,
    ai_caption: scores.ai_caption ?? null,
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

export const api = {
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

  exportFcpxml: (jobId: string, outputPath: string): Promise<void> =>
    client.post(`/jobs/${jobId}/export/fcpxml`, { output_path: outputPath }).then(() => undefined),

  thumbnailUrl: (jobId: string, clipId: string): string =>
    `${BASE_URL}/thumbnails/${jobId}/${clipId}`,

  clipStreamUrl: (jobId: string, clipId: string): string =>
    `${BASE_URL}/clips/${jobId}/${clipId}`,
}
