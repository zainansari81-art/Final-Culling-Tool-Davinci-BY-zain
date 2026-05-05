export type JobStatus = 'queued' | 'running' | 'done' | 'failed'

export interface ClipResult {
  id: string
  file_path: string
  filename: string
  duration_sec: number
  thumbnail_path: string
  shake_score: number
  blur_score: number
  exposure_score: number
  is_duplicate: boolean
  duplicate_of: string | null
  suggested_segment: string
  approved: boolean | null
  reject_reason: string | null
  // AI-derived
  ai_caption?: string | null
  ai_moment?: string | null
  ai_quality?: number | null
  ai_subjects?: string[]
  ai_in_sec?: number | null
  ai_out_sec?: number | null
  ai_skip?: boolean
  ai_skip_reason?: string | null
  transcript?: string | null
}

export interface AnalysisJob {
  id: string
  folder_path: string
  status: JobStatus
  progress: number
  clips: ClipResult[]
  created_at: string
  error?: string | null
}

export interface CreateJobRequest {
  folder_path: string
  included_files?: string[]
  enable_ai?: boolean
}

export interface UpdateClipRequest {
  approved?: boolean | null
  suggested_segment?: string
  reject_reason?: string | null
}

export interface ExportRequest {
  job_id: string
  export_type: 'resolve' | 'fcpxml'
  project_name: string
  output_path?: string
}
