import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  Clock,
  FolderOpen,
  Loader2,
  PenSquare,
  Play,
  Plus,
  Search,
  Settings as SettingsIcon,
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
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        setNewSessionOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
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

  const [sidebarQuery, setSidebarQuery] = useState('')

  const groupedJobs = useMemo(() => {
    const q = sidebarQuery.trim().toLowerCase()
    const filtered = jobs.filter((j) =>
      q
        ? (j.folder_path.split('/').pop() || j.folder_path)
            .toLowerCase()
            .includes(q)
        : true,
    )
    const now = Date.now()
    const day = 86400_000
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const yStart = todayStart.getTime() - day
    const weekStart = todayStart.getTime() - 7 * day
    const groups: Record<string, AnalysisJob[]> = {
      Today: [],
      Yesterday: [],
      'Previous 7 days': [],
      Older: [],
    }
    for (const j of filtered) {
      const t = new Date(j.created_at).getTime()
      if (t >= todayStart.getTime()) groups.Today.push(j)
      else if (t >= yStart) groups.Yesterday.push(j)
      else if (t >= weekStart) groups['Previous 7 days'].push(j)
      else groups.Older.push(j)
      if (now - t < 0) groups.Today.push(j) // future-safe noop
    }
    return groups
  }, [jobs, sidebarQuery])

  if (backendDown) {
    return (
      <Shell hideSidebar>
        <div className="p-6">
          <BackendError />
        </div>
      </Shell>
    )
  }

  // Sidebar: Claude-desktop style — new-session ghost btn, search, grouped recents, settings link
  const sidebar = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-2 pt-2">
        <button
          type="button"
          onClick={() => setNewSessionOpen(true)}
          className="flex w-full items-center gap-2 rounded-sm border border-border-strong bg-muted/40 px-2.5 py-1.5 text-left text-[12.5px] text-foreground transition-colors hover:border-primary/50 hover:bg-accent"
        >
          <PenSquare className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="flex-1">New session</span>
          <kbd className="font-mono text-[10px] tabular-nums text-muted-foreground">
            ⌘N
          </kbd>
        </button>
      </div>

      <div className="px-2 pt-2 pb-1">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <input
            value={sidebarQuery}
            onChange={(e) => setSidebarQuery(e.target.value)}
            placeholder="Search sessions"
            className="h-7 w-full rounded-sm border border-border bg-input pl-7 pr-2 text-[12px] outline-none transition-colors focus:border-primary/60"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto pb-1">
        {loadingJobs && (
          <div className="space-y-1.5 px-2 py-2">
            <Skeleton className="h-7 w-full" />
            <Skeleton className="h-7 w-full" />
            <Skeleton className="h-7 w-full" />
          </div>
        )}
        {!loadingJobs && jobs.length === 0 && (
          <p className="px-3 py-3 text-[11.5px] text-muted-foreground/80">
            No sessions yet.
          </p>
        )}
        {!loadingJobs &&
          (Object.entries(groupedJobs) as [string, AnalysisJob[]][]).map(
            ([label, items]) =>
              items.length === 0 ? null : (
                <div key={label} className="mt-2">
                  <div className="px-3 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
                    {label}
                  </div>
                  <div className="flex flex-col">
                    {items.map((j) => (
                      <SidebarJobItem key={j.id} job={j} />
                    ))}
                  </div>
                </div>
              ),
          )}
      </div>

      <div className="border-t border-border">
        <Link
          to="/settings"
          className="flex items-center gap-2 px-3 py-2 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <SettingsIcon className="h-3.5 w-3.5" />
          Settings
        </Link>
      </div>
    </div>
  )

  return (
    <Shell sidebar={sidebar} sidebarTitle="Sessions">
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
        {/* Hero — clean welcome with single CTA */}
        <div className="border-b border-border bg-card/40">
          <div className="mx-auto flex max-w-3xl flex-col items-start gap-3 px-5 py-7">
            <h1 className="text-[18px] font-semibold tracking-tight">
              Start a new session
            </h1>
            <p className="text-[12.5px] text-muted-foreground">
              Pick a folder of clips. Cull scores them, finds duplicates,
              and hands ranked selects to Resolve.
            </p>
            <button
              className="cta-primary"
              onClick={() => setNewSessionOpen(true)}
            >
              <Plus className="h-3.5 w-3.5" />
              New session
            </button>
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
            <h2 className="text-[13px] font-semibold">Recent sessions</h2>
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
              No sessions yet. Start a new session to begin.
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
          className="flex h-[78vh] w-[min(720px,94vw)] flex-col gap-0 overflow-hidden border border-border/70 bg-card p-0 shadow-2xl shadow-black/60 sm:max-w-[720px]"
          showCloseButton
        >
          <DialogHeader className="border-b border-border bg-panel-header px-4 py-3">
            <DialogTitle className="text-[13.5px] font-semibold tracking-tight">
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
  const name = job.folder_path.split('/').pop() || job.folder_path
  return (
    <Link
      to={`/jobs/${job.id}`}
      className="mx-1 flex items-center gap-2 rounded-sm px-2 py-1.5 text-[12.5px] transition-colors hover:bg-accent/60"
      title={name}
    >
      <span className="flex h-3 w-3 shrink-0 items-center justify-center">
        {isActive ? (
          <Loader2 className="h-3 w-3 animate-spin text-[var(--primary)]" />
        ) : job.status === 'failed' ? (
          <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-foreground/90">
        {name}
      </span>
      {isActive && (
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
          {Math.round(job.progress)}%
        </span>
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

