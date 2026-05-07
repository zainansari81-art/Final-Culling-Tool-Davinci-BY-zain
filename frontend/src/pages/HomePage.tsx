import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  Clock,
  FolderOpen,
  Loader2,
  Play,
  Plus,
  Wand2,
} from 'lucide-react'
import { api, type AiInfo } from '../api'
import type { AnalysisJob } from '../types'
import BackendError from '../components/BackendError'
import FolderBrowser from '../components/FolderBrowser'
import LocalWarmupCard from '../components/LocalWarmupCard'
import OnboardingWizard from '../components/OnboardingWizard'
import Shell from '../components/Shell'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

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
  const [folderPath, setFolderPath] = useState('')
  const [includedFiles, setIncludedFiles] = useState<string[] | null>(null)
  const [selectedCount, setSelectedCount] = useState(0)
  const [activeJob, setActiveJob] = useState<AnalysisJob | null>(null)
  const [enableAi, setEnableAi] = useState(false)
  const [aiInfo, setAiInfo] = useState<AiInfo | null>(null)
  const [newSessionOpen, setNewSessionOpen] = useState(false)

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
          loadJobs()
          navigate(`/jobs/${fresh.id}`)
        }
      } catch {
        // retry
      }
    }
    const t = setInterval(tick, 1500)
    return () => clearInterval(t)
  }, [activeJob, navigate])

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
      setNewSessionOpen(false)
      navigate(`/jobs/${job.id}`)
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

  const recentJobs = useMemo(() => jobs.slice(0, 8), [jobs])

  if (backendDown) {
    return (
      <Shell hideSidebar>
        <div className="p-6">
          <BackendError />
        </div>
      </Shell>
    )
  }

  // Sidebar content: Recent jobs list (compact)
  const sidebar = (
    <div className="flex flex-col">
      <div className="px-3 pt-3 pb-2">
        <button
          className="cta-primary w-full"
          onClick={() => setNewSessionOpen(true)}
        >
          <Plus className="h-3.5 w-3.5" />
          New session
        </button>
      </div>
      <div className="px-3 pb-2 text-[10.5px] uppercase tracking-wider text-muted-foreground/80">
        Recent
      </div>
      <div className="flex flex-col">
        {loadingJobs && (
          <div className="space-y-2 px-3 pb-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        )}
        {!loadingJobs && recentJobs.length === 0 && (
          <p className="px-3 pb-3 text-[12px] text-muted-foreground">
            No jobs yet.
          </p>
        )}
        {recentJobs.map((j) => (
          <SidebarJobItem key={j.id} job={j} />
        ))}
      </div>
    </div>
  )

  return (
    <Shell sidebar={sidebar} sidebarTitle="Library">
      {aiInfo?.backend === 'cloud' && !aiInfo.has_key && (
        <div className="border-b border-border bg-card px-4 py-3">
          <OnboardingWizard
            onDone={() => {
              api.aiInfo().then(setAiInfo).catch(() => {})
            }}
          />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {/* Hero / start panel */}
        <div className="border-b border-border bg-card">
          <div className="mx-auto max-w-3xl px-5 py-8">
            <h1 className="text-[20px] font-semibold tracking-tight">
              Library
            </h1>
            <p className="mt-1 text-[12.5px] text-muted-foreground">
              Pick a folder of clips. Cull scores them, finds duplicates, and
              hands ranked selects to Resolve.
            </p>
            <div className="mt-4 flex items-center gap-2">
              <button
                className="cta-primary"
                onClick={() => setNewSessionOpen(true)}
              >
                <Plus className="h-3.5 w-3.5" />
                New session
              </button>
              <span className="text-[12px] text-muted-foreground">
                or pick a recent job
              </span>
            </div>
          </div>
        </div>

        {aiInfo?.backend === 'local' && (
          <div className="border-b border-border bg-card/40 px-5 py-3">
            <LocalWarmupCard />
          </div>
        )}

        {/* Recent jobs grid */}
        <div className="mx-auto max-w-6xl px-5 py-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[13px] font-semibold">Recent jobs</h2>
            <span className="text-[11.5px] text-muted-foreground">
              {jobs.length} total
            </span>
          </div>

          {loadingJobs && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          )}

          {!loadingJobs && jobs.length === 0 && (
            <div className="flex h-40 items-center justify-center rounded-md border border-dashed border-border bg-card/40 text-[12.5px] text-muted-foreground">
              No jobs yet. Start a new session to begin.
            </div>
          )}

          {!loadingJobs && jobs.length > 0 && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {jobs.map((j) => (
                <JobCard key={j.id} job={j} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* New session dialog */}
      <Dialog open={newSessionOpen} onOpenChange={setNewSessionOpen}>
        <DialogContent
          className="flex h-[78vh] w-[min(720px,94vw)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[720px]"
          showCloseButton
        >
          <DialogHeader className="border-b border-border bg-panel-header px-4 py-3">
            <DialogTitle className="text-[14px] font-semibold tracking-tight">
              New session
            </DialogTitle>
            <DialogDescription className="text-[12px]">
              Pick a folder of clips, optionally enable AI, then run analysis.
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-hidden">
            <FolderBrowser
              onSelectionChange={(p, files, count) => {
                setFolderPath(p)
                setIncludedFiles(files)
                setSelectedCount(count)
              }}
            />
          </div>

          <div className="border-t border-border bg-card">
            <label className="flex cursor-pointer items-start gap-3 border-b border-border px-4 py-3 transition-colors hover:bg-accent/40">
              <Switch
                checked={enableAi}
                onCheckedChange={setEnableAi}
                disabled={submitting}
                className="mt-0.5"
              />
              <div className="flex-1">
                <div className="flex items-center gap-1.5 text-[12.5px] font-medium">
                  <Wand2 className="h-3.5 w-3.5 text-[var(--primary)]" />
                  Use AI analysis
                </div>
                <p className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">
                  {aiInfo?.backend === 'local'
                    ? 'Runs locally. Adds captions, segments, quality scores.'
                    : 'Uses Vertex Gemini (~30s/clip). Adds captions, segments, quality, trim suggestions.'}
                </p>
              </div>
            </label>

            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="text-[12px] text-muted-foreground">
                {selectedCount > 0 ? (
                  <>
                    <span className="font-medium tabular-nums text-foreground">
                      {selectedCount}
                    </span>{' '}
                    clip{selectedCount === 1 ? '' : 's'} selected
                    {enableAi ? ' · AI on' : ''}
                  </>
                ) : (
                  'Select at least one clip to continue.'
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setNewSessionOpen(false)}
                  className="cta-ghost"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAnalyze}
                  disabled={selectedCount === 0 || submitting}
                  className="cta-primary"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Starting…
                    </>
                  ) : (
                    <>
                      <Play className="h-3.5 w-3.5 fill-current" />
                      Run analysis
                    </>
                  )}
                </button>
              </div>
            </div>
            {error && (
              <div className="border-t border-destructive/40 bg-destructive/10 px-4 py-2 text-[12px] text-destructive">
                {error}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

    </Shell>
  )
}

function SidebarJobItem({ job }: { job: AnalysisJob }) {
  const isActive = job.status === 'running' || job.status === 'queued'
  const tone =
    job.status === 'done'
      ? 'success'
      : job.status === 'failed'
        ? 'destructive'
        : isActive
          ? 'primary'
          : 'default'
  return (
    <Link
      to={`/jobs/${job.id}`}
      className="block px-3 py-2 transition-colors hover:bg-accent/40"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <FolderOpen className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="truncate text-[12px] font-medium">
            {job.folder_path.split('/').pop() || job.folder_path}
          </span>
        </div>
        <Tone tone={tone} />
      </div>
      <div className="mt-0.5 flex items-center justify-between text-[10.5px] text-muted-foreground/80">
        <span>{formatDate(job.created_at)}</span>
        {isActive && (
          <span className="tabular-nums">{Math.round(job.progress)}%</span>
        )}
      </div>
      {isActive && (
        <div className="smooth-progress mt-1.5">
          <i style={{ width: `${job.progress}%` }} />
        </div>
      )}
    </Link>
  )
}

function JobCard({ job }: { job: AnalysisJob }) {
  const isActive = job.status === 'running' || job.status === 'queued'
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
      className={cn(
        'panel flex flex-col gap-2 p-3 transition-colors hover:border-primary/50 hover:bg-card',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span
            className="truncate text-[13px] font-medium"
            title={job.folder_path}
          >
            {job.folder_path.split('/').pop() || job.folder_path}
          </span>
        </div>
        <Badge
          variant="secondary"
          className={cn(
            'rounded-sm px-1.5 py-0 text-[10.5px]',
            job.status === 'done' && 'bg-success/15 text-[var(--success)]',
            job.status === 'failed' && 'bg-destructive/15 text-destructive',
            isActive && 'bg-primary/15 text-[var(--primary)]',
          )}
        >
          {label}
        </Badge>
      </div>
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <Clock className="h-3 w-3" />
          {formatDate(job.created_at)}
        </span>
        {elapsed && <span className="tabular-nums">{elapsed}</span>}
      </div>
      {isActive && (
        <div className="smooth-progress">
          <i style={{ width: `${job.progress}%` }} />
        </div>
      )}
      {job.status === 'done' && (
        <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{job.clips?.length ?? 0} clips</span>
          <span className="text-[var(--primary)]">Open →</span>
        </div>
      )}
    </Link>
  )
}

function Tone({ tone }: { tone: 'success' | 'destructive' | 'primary' | 'default' }) {
  const cls = {
    success: 'bg-success',
    destructive: 'bg-destructive',
    primary: 'bg-primary',
    default: 'bg-muted-foreground/50',
  }[tone]
  return <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', cls)} />
}
