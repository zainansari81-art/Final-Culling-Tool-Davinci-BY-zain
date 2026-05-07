import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  ArrowRight,
  Clock,
  Cpu,
  Film,
  FolderOpen,
  Loader2,
  Play,
  Sparkles,
  Wand2,
} from 'lucide-react'
import { api, type AiInfo } from '../api'
import type { AnalysisJob } from '../types'
import BackendError from '../components/BackendError'
import FolderBrowser from '../components/FolderBrowser'
import LocalWarmupCard from '../components/LocalWarmupCard'
import OnboardingWizard from '../components/OnboardingWizard'
import LogPane from '../components/LogPane'
import {
  HudFrame,
  HudPill,
  HudReadout,
  HudTitleBar,
  SegProgress,
} from '../components/Hud'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

type WizardStep = 'pick' | 'analyzing' | 'review'

const formatDate = (iso?: string) => {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}

export default function HomePage() {
  const navigate = useNavigate()
  const [jobs, setJobs] = useState<AnalysisJob[]>([])
  const [loadingJobs, setLoadingJobs] = useState(true)
  const [backendDown, setBackendDown] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [openStep, setOpenStep] = useState<WizardStep>('pick')

  const [folderPath, setFolderPath] = useState('')
  const [includedFiles, setIncludedFiles] = useState<string[] | null>(null)
  const [selectedCount, setSelectedCount] = useState(0)
  const [activeJob, setActiveJob] = useState<AnalysisJob | null>(null)
  const [enableAi, setEnableAi] = useState(false)
  const [aiInfo, setAiInfo] = useState<AiInfo | null>(null)

  const loadJobs = async () => {
    try {
      const data = await api.listJobs()
      setJobs(data)
      setBackendDown(false)
    } catch {
      setBackendDown(true)
    } finally {
      setLoadingJobs(false)
    }
  }

  useEffect(() => {
    loadJobs()
    api.aiInfo().then(setAiInfo).catch(() => setAiInfo(null))
  }, [])

  useEffect(() => {
    if (!activeJob) return
    if (activeJob.status === 'done' || activeJob.status === 'failed') return
    const tick = async () => {
      try {
        const fresh = await api.getJob(activeJob.id)
        setActiveJob(fresh)
        if (fresh.status === 'done') {
          setOpenStep('review')
          loadJobs()
        }
      } catch {
        // retry
      }
    }
    const t = setInterval(tick, 1500)
    return () => clearInterval(t)
  }, [activeJob])

  const handleAnalyze = async () => {
    if (!folderPath || selectedCount === 0) return
    setSubmitting(true)
    setError('')
    try {
      const job = await api.createJob({
        folder_path: folderPath,
        included_files: includedFiles ?? undefined,
        enable_ai: enableAi,
      })
      setActiveJob(job)
      setOpenStep('analyzing')
    } catch (err: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const detail = (err as any)?.response?.data?.detail
      const msg =
        detail ?? (err instanceof Error ? err.message : 'Failed to start analysis')
      setError(String(msg))
    } finally {
      setSubmitting(false)
    }
  }

  const recentJobs = useMemo(() => jobs.slice(0, 6), [jobs])

  if (backendDown) {
    return (
      <div className="min-h-svh p-6">
        <BackendError />
      </div>
    )
  }

  const pickActive = openStep === 'pick' && !activeJob
  const analyzeActive = !!activeJob && activeJob.status !== 'done'
  const reviewReady = activeJob?.status === 'done'

  return (
    <div className="min-h-svh">
      <TopBar aiInfo={aiInfo} />

      <main className="mx-auto max-w-[1400px] px-6 pb-16 pt-8">
        {/* hero */}
        <div className="mb-8">
          <h1 className="text-[26px] font-semibold tracking-tight">
            Cull a folder
          </h1>
          <p className="mt-1 max-w-xl text-[13.5px] text-muted-foreground">
            Pick the folder of clips, run analysis, then review the picks
            and send them to Resolve.
          </p>
        </div>

        {aiInfo?.backend === 'local' && (
          <div className="mb-4">
            <LocalWarmupCard />
          </div>
        )}

        {aiInfo?.backend === 'cloud' && !aiInfo.has_key && (
          <div className="mb-4">
            <OnboardingWizard
              onDone={() => {
                api.aiInfo().then(setAiInfo).catch(() => {})
              }}
            />
          </div>
        )}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[2fr,1fr]">
          {/* LEFT: pipeline */}
          <div className="flex flex-col gap-5">
            {/* STEP 1 — PICK FOLDER */}
            <HudFrame state={pickActive ? 'active' : activeJob ? 'done' : 'idle'}>
              <HudTitleBar
                index={1}
                label="Pick a folder"
                status={
                  pickActive
                    ? 'Choose your card or footage folder'
                    : 'Locked while analysis runs'
                }
                meta={
                  folderPath ? (
                    <span className="truncate font-mono">{folderPath}</span>
                  ) : null
                }
              />
              <div className="grid grid-cols-1 gap-0 lg:grid-cols-[1fr,280px]">
                <div className="border-b border-border lg:border-b-0 lg:border-r">
                  <FolderBrowser
                    onSelectionChange={(p, files, count) => {
                      setFolderPath(p)
                      setIncludedFiles(files)
                      setSelectedCount(count)
                    }}
                  />
                </div>
                <div className="flex flex-col gap-0">
                  <label className="flex cursor-pointer items-start gap-3 border-b border-border px-4 py-3 transition-colors hover:bg-accent/30">
                    <Switch
                      checked={enableAi}
                      onCheckedChange={setEnableAi}
                      disabled={submitting}
                      className="mt-0.5"
                    />
                    <div className="flex-1">
                      <div className="flex items-center gap-1.5 text-[13px] font-medium">
                        <Wand2 className="h-3.5 w-3.5 text-[var(--primary)]" />
                        Use AI analysis
                      </div>
                      <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">
                        {aiInfo?.backend === 'local'
                          ? 'Runs locally on this Mac. Adds captions, segments, and quality scores.'
                          : 'Uses Vertex Gemini. Adds captions, segments, quality, and trim suggestions (~30s/clip).'}
                      </p>
                    </div>
                  </label>

                  <div className="grid grid-cols-2 gap-4 border-b border-border px-4 py-3">
                    <HudReadout
                      label="Selected"
                      value={selectedCount}
                      hint={
                        selectedCount === 0
                          ? 'No clips yet'
                          : selectedCount === 1
                            ? '1 clip'
                            : `${selectedCount} clips`
                      }
                      accent={selectedCount > 0 ? 'primary' : 'default'}
                    />
                    <HudReadout
                      label="Mode"
                      value={enableAi ? 'AI + checks' : 'Quick checks'}
                      hint={enableAi ? 'Smarter, slower' : 'Fast, no AI'}
                      align="right"
                    />
                  </div>

                  <button
                    onClick={handleAnalyze}
                    disabled={selectedCount === 0 || submitting}
                    className="cta-primary m-4"
                  >
                    {submitting ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Starting…
                      </>
                    ) : (
                      <>
                        <Play className="h-4 w-4 fill-current" />
                        Run analysis
                      </>
                    )}
                  </button>
                  {error && (
                    <div className="border-t border-destructive/40 bg-destructive/10 px-4 py-2 text-[12px] text-destructive">
                      {error}
                    </div>
                  )}
                </div>
              </div>
            </HudFrame>

            {/* STEP 2 — ANALYZE */}
            <HudFrame
              state={
                analyzeActive
                  ? 'active'
                  : activeJob?.status === 'done'
                    ? 'done'
                    : 'pending'
              }
            >
              <HudTitleBar
                index={2}
                label="Analyze clips"
                status={
                  !activeJob
                    ? 'Waiting'
                    : activeJob.status === 'done'
                      ? 'Done'
                      : `Running · ${Math.round(activeJob.progress)}%`
                }
              />
              {!activeJob ? (
                <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
                  <p className="max-w-md text-[13px] text-muted-foreground">
                    We score every clip for shake, blur, and exposure, then
                    group duplicates. This kicks in when you run analysis.
                  </p>
                </div>
              ) : (
                <div className="space-y-5 px-5 py-5">
                  <SegProgress
                    value={activeJob.progress}
                    variant={
                      activeJob.status === 'done' ? 'success' : 'primary'
                    }
                  />
                  <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
                    <HudReadout
                      label="Progress"
                      value={`${Math.round(activeJob.progress)}%`}
                      accent="primary"
                    />
                    <HudReadout
                      label="Clips found"
                      value={activeJob.clips.length || selectedCount}
                    />
                    <HudReadout
                      label="Status"
                      value={
                        activeJob.status === 'done'
                          ? 'Done'
                          : activeJob.status === 'failed'
                            ? 'Failed'
                            : 'Running'
                      }
                      accent={
                        activeJob.status === 'failed'
                          ? 'destructive'
                          : activeJob.status === 'done'
                            ? 'success'
                            : 'primary'
                      }
                    />
                    <HudReadout
                      label="Folder"
                      value={folderPath.split('/').pop() || '—'}
                      align="right"
                    />
                  </div>

                  {activeJob.status === 'failed' && activeJob.error && (
                    <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
                      {activeJob.error}
                    </div>
                  )}

                  <LogPane
                    jobId={activeJob.id}
                    active={
                      activeJob.status === 'running' ||
                      activeJob.status === 'queued'
                    }
                  />
                </div>
              )}
            </HudFrame>

            {/* STEP 3 — REVIEW */}
            <HudFrame state={reviewReady ? 'active' : 'pending'}>
              <HudTitleBar
                index={3}
                label="Review &amp; export"
                status={
                  reviewReady
                    ? `${activeJob.clips.length} clips ready`
                    : 'Available after analysis'
                }
              />
              {reviewReady ? (
                <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-5">
                  <div className="text-[13px] text-muted-foreground">
                    Approve the keepers, mark a few near-misses, and send the
                    selects to Resolve or FCPXML.
                  </div>
                  <button
                    className="cta-primary"
                    onClick={() => navigate(`/jobs/${activeJob.id}`)}
                  >
                    Open review
                    <ArrowRight className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <div className="px-5 py-7 text-center">
                  <p className="text-[13px] text-muted-foreground">
                    Once analysis finishes, you'll review and approve clips here.
                  </p>
                </div>
              )}
            </HudFrame>
          </div>

          {/* RIGHT: recent jobs sidebar */}
          <div className="flex flex-col gap-5">
            <HudFrame>
              <HudTitleBar
                label="Recent jobs"
                meta={`${jobs.length} total`}
              />
              <div className="divide-y divide-border">
                {loadingJobs && (
                  <div className="space-y-2 p-3">
                    <Skeleton className="h-12 w-full" />
                    <Skeleton className="h-12 w-full" />
                    <Skeleton className="h-12 w-full" />
                  </div>
                )}
                {!loadingJobs && recentJobs.length === 0 && (
                  <div className="px-4 py-8 text-center text-[12.5px] text-muted-foreground">
                    No jobs yet. Pick a folder to start.
                  </div>
                )}
                {recentJobs.map((j) => (
                  <JobRow key={j.id} job={j} />
                ))}
              </div>
            </HudFrame>

            <HudFrame>
              <HudTitleBar label="System" />
              <div className="grid grid-cols-2 gap-4 px-4 py-3">
                <HudReadout
                  label="Backend"
                  value={
                    aiInfo?.backend
                      ? aiInfo.backend === 'local'
                        ? 'Local'
                        : 'Cloud'
                      : 'Offline'
                  }
                  accent={aiInfo ? 'success' : 'destructive'}
                />
                <HudReadout
                  label="Engine"
                  value={aiInfo?.label ?? '—'}
                  align="right"
                />
              </div>
              <div className="border-t border-border bg-muted/30 px-4 py-2 text-[11.5px] text-muted-foreground">
                <span className="text-success">●</span> Online · v1.0
              </div>
            </HudFrame>
          </div>
        </div>
      </main>
    </div>
  )
}

function TopBar({ aiInfo }: { aiInfo: AiInfo | null }) {
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-4 px-6 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-gradient-to-br from-primary to-[color-mix(in_srgb,var(--primary)_70%,#c2410c)] text-primary-foreground shadow-[0_0_18px_-4px_color-mix(in_srgb,var(--primary)_70%,transparent)]">
            <Film className="h-4 w-4" />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-[14px] font-semibold tracking-tight">Cull</span>
            <span className="text-[10.5px] text-muted-foreground">
              for DaVinci Resolve
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <HudPill tone={aiInfo ? 'success' : 'destructive'}>
            <Cpu className="h-3 w-3" />
            {aiInfo
              ? aiInfo.backend === 'local'
                ? 'Local'
                : 'Cloud'
              : 'Offline'}
          </HudPill>
        </div>
      </div>
    </header>
  )
}

function JobRow({ job }: { job: AnalysisJob }) {
  const isActive = job.status === 'running' || job.status === 'queued'
  const tone =
    job.status === 'done'
      ? 'success'
      : job.status === 'failed'
        ? 'destructive'
        : isActive
          ? 'primary'
          : 'default'
  const elapsed = (() => {
    if (!job.started_at) return null
    const end = job.completed_at
      ? new Date(job.completed_at).getTime()
      : Date.now()
    const start = new Date(job.started_at).getTime()
    const sec = Math.max(0, (end - start) / 1000)
    const m = Math.floor(sec / 60)
    const s = sec - m * 60
    return m > 0 ? `${m}m ${s.toFixed(0)}s` : `${s.toFixed(1)}s`
  })()
  const label =
    job.status === 'done'
      ? 'Ready'
      : job.status === 'failed'
        ? 'Failed'
        : isActive
          ? `${Math.round(job.progress)}%`
          : 'Idle'
  return (
    <Link
      to={`/jobs/${job.id}`}
      className="block px-4 py-3 transition-colors hover:bg-accent/30"
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-[12.5px] font-medium">
            {job.folder_path.split('/').pop() || job.folder_path}
          </span>
        </div>
        <HudPill tone={tone}>{label}</HudPill>
      </div>
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <Clock className="h-3 w-3" />
          {formatDate(job.created_at)}
        </span>
        {elapsed && <span className="tabular-nums">{elapsed}</span>}
      </div>
      {isActive && <SegProgress value={job.progress} className={cn('mt-2')} />}
    </Link>
  )
}

// keep tree-shaker friendly
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _keep = { Sparkles }
