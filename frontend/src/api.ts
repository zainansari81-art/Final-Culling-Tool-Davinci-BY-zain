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
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toJob(raw: any): AnalysisJob {
  return { ...raw, clips: (raw.clips ?? []).map(toClipResult) }
}

export const api = {
  createJob: (data: CreateJobRequest): Promise<AnalysisJob> =>
    client.post('/jobs', data).then((r) => toJob(r.data)),

  listJobs: (): Promise<AnalysisJob[]> =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client.get('/jobs').then((r) => (r.data as any[]).map(toJob)),

  getJob: (id: string): Promise<AnalysisJob> =>
    client.get(`/jobs/${id}`).then((r) => toJob(r.data)),

  getProgress: (id: string): Promise<{ progress: number; status: string }> =>
    client.get(`/jobs/${id}/progress`).then((r) => r.data),

  patchClip: (jobId: string, clipId: string, patch: UpdateClipRequest): Promise<ClipResult> =>
    client
      .patch(`/jobs/${jobId}/clips/${clipId}`, {
        approved: patch.approved,
        // UI stores field as suggested_segment; backend field name is segment_label
        segment_label: patch.suggested_segment,
      })
      .then((r) => toClipResult(r.data)),

  approveAll: (jobId: string): Promise<{ approved: number; rejected: number; total: number }> =>
    client.post(`/jobs/${jobId}/approve-all`).then((r) => r.data),

  exportResolve: (jobId: string, projectName: string): Promise<void> =>
    client.post(`/jobs/${jobId}/export/resolve`, { project_name: projectName }).then(() => undefined),

  exportFcpxml: (jobId: string, outputPath: string): Promise<void> =>
    client.post(`/jobs/${jobId}/export/fcpxml`, { output_path: outputPath }).then(() => undefined),

  thumbnailUrl: (jobId: string, clipId: string): string =>
    `${BASE_URL}/thumbnails/${jobId}/${clipId}`,
}
