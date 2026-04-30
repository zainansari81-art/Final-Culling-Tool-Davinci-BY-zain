import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  ArrowRight,
  Clapperboard,
  Clock,
  Film,
  Loader2,
  Sparkles,
} from 'lucide-react'
import { api } from '../api'
import type { AnalysisJob } from '../types'
import BackendError from '../components/BackendError'
import FolderBrowser from '../components/FolderBrowser'
import LogPane from '../components/LogPane'
import { Step, Stepper, type StepState } from '../components/StepCard'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
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
  const [deepAnalysis, setDeepAnalysis] = useState(true)
  const [aiGrading, setAiGrading] = useState(false)

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
  }, [])

  // Poll the active job for progress
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
        // swallow, will retry
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
        deep_analysis: deepAnalysis,
        cull_policy: {
          deep_analysis: deepAnalysis,
          ai_grading: aiGrading,
          detect_highlights: true,
          ai_max_concurrent: 4,
        },
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

  const pickState: StepState = activeJob
    ? 'done'
    : selectedCount > 0
      ? 'active'
      : 'active'

  const analyzeState: StepState = !activeJob
    ? 'pending'
    : activeJob.status === 'done'
      ? 'done'
      : 'active'

  const reviewState: StepState =
    activeJob?.status === 'done' ? 'active' : 'pending'

  const recentJobs = useMemo(() => jobs.slice(0, 5), [jobs])

  if (backendDown) {
    return (
      <div className="min-h-svh bg-background p-6">
        <BackendError />
      </div>
    )
  }

  return (
    <div className="min-h-svh bg-background">
      <header className="sticky top-0 z-20 border-b border-border/70 bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-foreground text-background">
              <Clapperboard className="h-4 w-4" />
            </div>
            <div className="text-sm font-medium tracking-tight">
              Wedding Footage Culler
            </div>
          </div>
          <Badge variant="secondary" className="gap-1.5 font-normal">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success/70 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
            </span>
            Local
          </Badge>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 pb-20 pt-10">
        <div className="grid gap-10 lg:grid-cols-[1fr,300px]">
          <section>
            <div className="mb-8">
              <h1 className="text-2xl font-semibold tracking-tight">New analysis</h1>
              <p className="mt-1.5 text-sm text-muted-foreground">
                Pick a folder, run analysis, then review and export your selects.
              </p>
            </div>

            <Stepper>
              {/* Step 1: Pick footage */}
              <Step
                index={1}
                state={pickState}
                title="Choose footage"
                subtitle={
                  folderPath
                    ? `${folderPath} · ${selectedCount} clip${selectedCount === 1 ? '' : 's'} selected`
                    : 'Browse your external drive and pick a folder of clips.'
                }
                open={openStep === 'pick'}
                onToggle={() =>
                  setOpenStep(openStep === 'pick' ? 'analyzing' : 'pick')
                }
                collapsible={!activeJob}
              >
                <FolderBrowser
                  onSelectionChange={(p, files, count) => {
                    setFolderPath(p)
                    setIncludedFiles(files)
                    setSelectedCount(count)
                  }}
                />
                <Separator />
                {/* Analysis options */}
                <div className="px-4 py-3 space-y-2.5 border-b border-border/50">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Analysis options
                  </div>
                  <label className="flex items-start gap-3 cursor-pointer group" htmlFor="opt-deep">
                    <input
                      id="opt-deep"
                      type="checkbox"
                      checked={deepAnalysis}
                      onChange={(e) => setDeepAnalysis(e.target.checked)}
                      disabled={!!activeJob}
                      className="mt-0.5 size-4 accent-primary cursor-pointer disabled:opacity-50"
                    />
                    <div className="flex-1">
                      <div className="text-sm font-medium">Deep analysis</div>
                      <div className="text-xs text-muted-foreground">
                        Sliding-window scoring + cross-clip coverage clustering. Identifies usable
                        sub-segments inside long clips and groups multi-cam coverage. ~2-3× slower.
                      </div>
                    </div>
                  </label>
                  <label className="flex items-start gap-3 cursor-pointer group" htmlFor="opt-ai">
                    <input
                      id="opt-ai"
                      type="checkbox"
                      checked={aiGrading}
                      onChange={(e) => setAiGrading(e.target.checked)}
                      disabled={!!activeJob || !deepAnalysis}
                      className="mt-0.5 size-4 accent-primary cursor-pointer disabled:opacity-50"
                    />
                    <div className="flex-1">
                      <div className="text-sm font-medium flex items-center gap-1.5">
                        AI grading
                        <span className="text-[10px] font-normal text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                          requires deep
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Claude vision rates each sub-segment 1-10 with shot type, issues, and editorial reasoning.
                        Slower (~10s/clip) and uses Claude subscription budget. Frame-cached so re-runs are free.
                      </div>
                    </div>
                  </label>
                </div>
                <div className="flex items-center justify-between gap-3 px-4 py-3">
                  <p className="text-xs text-muted-foreground">
                    {selectedCount > 0
                      ? `Ready to analyze ${selectedCount} clip${selectedCount === 1 ? '' : 's'}.`
                      : 'Select at least one clip to continue.'}
                  </p>
                  {error && (
                    <p className="text-xs text-destructive">{error}</p>
                  )}
                  <Button
                    onClick={handleAnalyze}
                    disabled={selectedCount === 0 || submitting}
                  >
                    {submitting ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Starting…
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-4 w-4" />
                        {aiGrading ? 'Run AI culling' : deepAnalysis ? 'Run deep analysis' : 'Run analysis'}
                      </>
                    )}
                  </Button>
                </div>
              </Step>

              {/* Step 2: Analyze */}
              <Step
                index={2}
                state={analyzeState}
                title="Analyze clips"
                subtitle={
                  !activeJob
                    ? 'Shake, blur, exposure and duplicate detection.'
                    : activeJob.status === 'done'
                      ? 'Analysis complete.'
                      : `Analyzing… ${Math.round(activeJob.progress)}%`
                }
                open={openStep === 'analyzing'}
                onToggle={() =>
                  setOpenStep(openStep === 'analyzing' ? 'pick' : 'analyzing')
                }
                collapsible={!!activeJob}
              >
                {activeJob && (
                  <div className="space-y-5 px-5 py-5">
                    <div>
                      <div className="mb-2 flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">
                          {activeJob.status === 'done'
                            ? 'Done'
                            : activeJob.status === 'failed'
                              ? 'Failed'
                              : 'Analyzing keyframes…'}
                        </span>
                        <span className="tabular-nums font-medium">
                          {Math.round(activeJob.progress)}%
                        </span>
                      </div>
                      <Progress value={activeJob.progress} />
                    </div>

                    <div className="grid grid-cols-3 gap-3">
                      <Stat
                        label="Clips"
                        value={activeJob.clips.length || selectedCount}
                      />
                      <Stat
                        label="Status"
                        value={
                          activeJob.status === 'done'
                            ? 'Done'
                            : activeJob.status === 'failed'
                              ? 'Failed'
                              : 'Running'
                        }
                      />
                      <Stat label="Folder" value={folderPath.split('/').pop() || '—'} />
                    </div>

                    {activeJob.status === 'failed' && activeJob.error && (
                      <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                        {activeJob.error}
                      </p>
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
              </Step>

              {/* Step 3: Review & export */}
              <Step
                index={3}
                state={reviewState}
                title="Review & export"
                subtitle={
                  reviewState === 'active'
                    ? 'Open the review to approve clips and export to Resolve or FCPXML.'
                    : 'Approve clips and send selects to Resolve or FCPXML.'
                }
                open={openStep === 'review'}
                onToggle={() =>
                  setOpenStep(openStep === 'review' ? 'analyzing' : 'review')
                }
                collapsible={reviewState !== 'pending'}
                isLast
              >
                {activeJob?.status === 'done' && (
                  <div className="flex items-center justify-between px-5 py-5">
                    <div className="text-sm text-muted-foreground">
                      {activeJob.clips.length} clip
                      {activeJob.clips.length === 1 ? '' : 's'} ready to review.
                    </div>
                    <Button onClick={() => navigate(`/jobs/${activeJob.id}`)}>
                      Open review
                      <ArrowRight className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </Step>
            </Stepper>
          </section>

          <aside className="lg:sticky lg:top-24 lg:self-start">
            <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Recent jobs
            </h2>
            <Separator className="mt-3 mb-3" />
            <div className="space-y-2">
              {loadingJobs && (
                <>
                  <Skeleton className="h-14 w-full" />
                  <Skeleton className="h-14 w-full" />
                  <Skeleton className="h-14 w-full" />
                </>
              )}
              {!loadingJobs && recentJobs.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No jobs yet. Start one from the steps on the left.
                </p>
              )}
              {recentJobs.map((j) => (
                <JobRow key={j.id} job={j} />
              ))}
            </div>
          </aside>
        </div>
      </main>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 truncate text-sm font-medium">{value}</div>
    </div>
  )
}

function JobRow({ job }: { job: AnalysisJob }) {
  const isActive = job.status === 'running' || job.status === 'queued'
  const statusLabel =
    job.status === 'done'
      ? 'Ready'
      : job.status === 'running'
        ? 'Running'
        : job.status === 'queued'
          ? 'Queued'
          : 'Failed'
  const statusVariant =
    job.status === 'done'
      ? 'success'
      : job.status === 'failed'
        ? 'destructive'
        : 'muted'

  return (
    <Link
      to={`/jobs/${job.id}`}
      className="block rounded-lg border border-border/70 bg-card/40 px-3 py-2.5 transition-colors hover:border-border hover:bg-card"
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Film className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-xs font-medium">
            {job.folder_path.split('/').pop() || job.folder_path}
          </span>
        </div>
        <StatusDot variant={statusVariant} />
      </div>
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <Clock className="h-3 w-3" />
          {formatDate(job.created_at)}
        </span>
        <span>
          {statusLabel}
          {isActive && ` · ${Math.round(job.progress)}%`}
        </span>
      </div>
      {isActive && (
        <Progress value={job.progress} className="mt-2 h-1" />
      )}
    </Link>
  )
}

function StatusDot({
  variant,
}: {
  variant: 'success' | 'destructive' | 'muted'
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'h-1.5 w-1.5 shrink-0 rounded-full',
        variant === 'success' && 'bg-success',
        variant === 'destructive' && 'bg-destructive',
        variant === 'muted' && 'bg-muted-foreground/60',
      )}
    />
  )
}
