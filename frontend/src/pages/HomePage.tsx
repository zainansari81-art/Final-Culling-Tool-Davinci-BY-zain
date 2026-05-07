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
  Search,
  Sparkles,
  Wand2,
} from 'lucide-react'
import { api, type AiInfo } from '../api'
import type { AnalysisJob } from '../types'
import BackendError from '../components/BackendError'
import FolderBrowser from '../components/FolderBrowser'
import LocalWarmupCard from '../components/LocalWarmupCard'
import LogPane from '../components/LogPane'
import {
  HudFrame,
  HudLabel,
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

      <main className="mx-auto max-w-[1400px] px-6 pb-16 pt-6">
        {/* hero / heading */}
        <div className="mb-6 flex items-end justify-between gap-6">
          <div>
            <HudLabel>NEW SESSION · CULL.001</HudLabel>
            <h1 className="mt-2 text-[28px] font-semibold tracking-tight">
              Ingest, analyze, send to Resolve.
            </h1>
            <p className="mt-1.5 max-w-xl text-[12.5px] text-muted-foreground">
              Point the tool at your card folder. We score every clip, group
              duplicates, and hand back ranked selects ready for the timeline.
            </p>
          </div>
          <div className="hidden items-center gap-6 md:flex">
            <HudReadout label="Engine" value={aiInfo?.label ?? '—'} hint={aiInfo?.backend ?? 'idle'} accent={aiInfo ? 'primary' : 'default'} />
            <HudReadout label="Jobs" value={jobs.length} hint="LOCAL CACHE" />
            <HudReadout
              label="Status"
              value={activeJob ? activeJob.status.toUpperCase() : 'IDLE'}
              hint="SESSION"
              accent={activeJob?.status === 'failed' ? 'destructive' : activeJob ? 'success' : 'default'}
            />
          </div>
        </div>

        {aiInfo?.backend === 'local' && (
          <div className="mb-4">
            <LocalWarmupCard />
          </div>
        )}

        {/* Stage strip — 3 connected HUD frames */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr,1fr]">
          {/* LEFT: pipeline */}
          <div className="flex flex-col gap-4">
            {/* STAGE 01 — INGEST */}
            <HudFrame state={pickActive ? 'active' : activeJob ? 'done' : 'idle'}>
              <HudTitleBar
                index={1}
                label="INGEST · SOURCE FOLDER"
                status={pickActive ? 'AWAITING SELECTION' : 'LOCKED'}
                meta={
                  folderPath ? (
                    <span className="truncate font-mono text-foreground/70">
                      {folderPath}
                    </span>
                  ) : (
                    <span>NO PATH</span>
                  )
                }
              />
              <div className="grid grid-cols-1 gap-0 lg:grid-cols-[1fr,260px]">
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
                  {/* AI toggle */}
                  <label className="flex cursor-pointer items-start gap-3 border-b border-border px-3 py-3 transition-colors hover:bg-accent/30">
                    <Switch
                      checked={enableAi}
                      onCheckedChange={setEnableAi}
                      disabled={submitting}
                      className="mt-0.5"
                    />
                    <div className="flex-1">
                      <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-foreground/80">
                        <Wand2 className="h-3 w-3" />
                        AI ANALYSIS
                      </div>
                      <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                        {aiInfo?.backend === 'local'
                          ? 'Local Qwen2-VL + CLIP. Caption, segment, quality. Runs on this Mac.'
                          : 'Vertex Gemini. Caption, segment, quality, in/out points. ~30s/clip.'}
                      </p>
                    </div>
                  </label>

                  <div className="grid grid-cols-2 gap-3 border-b border-border px-3 py-3">
                    <HudReadout
                      label="Selected"
                      value={selectedCount.toString().padStart(3, '0')}
                      hint="CLIPS"
                      accent={selectedCount > 0 ? 'primary' : 'default'}
                    />
                    <HudReadout
                      label="Mode"
                      value={enableAi ? 'AI+HEUR' : 'HEUR'}
                      hint="PIPELINE"
                      align="right"
                    />
                  </div>

                  <button
                    onClick={handleAnalyze}
                    disabled={selectedCount === 0 || submitting}
                    className="hud-cta m-3 justify-center"
                  >
                    {submitting ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        STARTING…
                      </>
                    ) : (
                      <>
                        <Play className="h-3.5 w-3.5 fill-current" />
                        EXECUTE ANALYSIS
                      </>
                    )}
                  </button>
                  {error && (
                    <div className="border-t border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-destructive">
                      ERR · {error}
                    </div>
                  )}
                </div>
              </div>
            </HudFrame>

            {/* STAGE 02 — ANALYZE */}
            <HudFrame
              state={
                analyzeActive
                  ? 'active'
                  : activeJob?.status === 'done'
                    ? 'done'
                    : 'pending'
              }
              scanline={analyzeActive}
            >
              <HudTitleBar
                index={2}
                label="ANALYZE · SHAKE / BLUR / DUP"
                status={
                  !activeJob
                    ? 'STANDBY'
                    : activeJob.status === 'done'
                      ? 'COMPLETE'
                      : `RUNNING ${Math.round(activeJob.progress)}%`
                }
                meta={
                  activeJob ? `JOB ${activeJob.id.slice(0, 6).toUpperCase()}` : '—'
                }
              />
              {!activeJob ? (
                <div className="hud-hatch flex flex-col items-center justify-center px-4 py-12 text-center">
                  <HudLabel>AWAITING DISPATCH</HudLabel>
                  <p className="mt-2 max-w-md text-[11px] text-muted-foreground">
                    Once you execute analysis, scoring + duplicate detection
                    runs here in real-time.
                  </p>
                </div>
              ) : (
                <div className="space-y-4 px-4 py-4">
                  <SegProgress
                    value={activeJob.progress}
                    segments={32}
                    variant={
                      activeJob.status === 'done' ? 'success' : 'primary'
                    }
                  />
                  <div className="grid grid-cols-4 gap-4">
                    <HudReadout
                      label="Progress"
                      value={`${Math.round(activeJob.progress)}%`}
                      hint="OF TOTAL"
                      accent="primary"
                    />
                    <HudReadout
                      label="Clips"
                      value={(activeJob.clips.length || selectedCount)
                        .toString()
                        .padStart(3, '0')}
                      hint="DISCOVERED"
                    />
                    <HudReadout
                      label="State"
                      value={activeJob.status.toUpperCase()}
                      hint="JOB"
                      accent={
                        activeJob.status === 'failed'
                          ? 'destructive'
                          : activeJob.status === 'done'
                            ? 'success'
                            : 'primary'
                      }
                    />
                    <HudReadout
                      label="Source"
                      value={folderPath.split('/').pop() || '—'}
                      hint="FOLDER"
                      align="right"
                    />
                  </div>

                  {activeJob.status === 'failed' && activeJob.error && (
                    <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-destructive">
                      ERR · {activeJob.error}
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

            {/* STAGE 03 — REVIEW */}
            <HudFrame state={reviewReady ? 'active' : 'pending'}>
              <HudTitleBar
                index={3}
                label="REVIEW · DISPATCH TO RESOLVE"
                status={reviewReady ? 'READY' : 'STANDBY'}
                meta={reviewReady ? `${activeJob.clips.length} CLIPS` : '—'}
              />
              {reviewReady ? (
                <div className="flex items-center justify-between px-4 py-4">
                  <div className="flex items-center gap-4">
                    <HudReadout
                      label="Clips ready"
                      value={activeJob.clips.length.toString().padStart(3, '0')}
                      hint="QUEUED FOR REVIEW"
                      accent="success"
                    />
                  </div>
                  <button
                    className="hud-cta"
                    onClick={() => navigate(`/jobs/${activeJob.id}`)}
                  >
                    OPEN REVIEW
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <div className="hud-hatch px-4 py-10 text-center">
                  <HudLabel>STAGE LOCKED</HudLabel>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Unlocks once analysis completes.
                  </p>
                </div>
              )}
            </HudFrame>
          </div>

          {/* RIGHT: recent jobs sidebar */}
          <div className="flex flex-col gap-4">
            <HudFrame>
              <HudTitleBar label="RECENT JOBS" meta={`${jobs.length} TOTAL`} />
              <div className="divide-y divide-border">
                {loadingJobs && (
                  <div className="space-y-2 px-3 py-3">
                    <Skeleton className="h-12 w-full" />
                    <Skeleton className="h-12 w-full" />
                    <Skeleton className="h-12 w-full" />
                  </div>
                )}
                {!loadingJobs && recentJobs.length === 0 && (
                  <div className="hud-hatch px-3 py-8 text-center">
                    <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      NO JOBS · BEGIN A SESSION
                    </p>
                  </div>
                )}
                {recentJobs.map((j) => (
                  <JobRow key={j.id} job={j} />
                ))}
              </div>
            </HudFrame>

            <HudFrame>
              <HudTitleBar label="SYSTEM" />
              <div className="grid grid-cols-2 gap-3 px-3 py-3">
                <HudReadout
                  label="Backend"
                  value={aiInfo?.backend?.toUpperCase() ?? 'OFFLINE'}
                  accent={aiInfo ? 'success' : 'destructive'}
                />
                <HudReadout
                  label="Model"
                  value={aiInfo?.label ?? '—'}
                  align="right"
                  hint={aiInfo?.vlm_model?.slice(0, 20) ?? ''}
                />
              </div>
              <div className="border-t border-border px-3 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70">
                <span className="text-success">●</span> ONLINE · v1.0 ·
                LOCAL :: 127.0.0.1
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
    <header className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-4 px-6 py-2.5">
        <div className="flex items-center gap-3">
          <div className="flex h-7 w-7 items-center justify-center border border-primary/40 bg-primary/15">
            <Film className="h-3.5 w-3.5 text-[var(--primary)]" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[13px] font-semibold uppercase tracking-[0.18em]">
              CULL
            </span>
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              ⌘ DAVINCI · WEDDING CULLER
            </span>
          </div>
          <span className="tick" />
          <nav className="hidden items-center gap-1 md:flex">
            <NavItem active>SESSION</NavItem>
            <NavItem>LIBRARY</NavItem>
            <NavItem>SETTINGS</NavItem>
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="hidden items-center gap-2 border border-border bg-muted/40 px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground md:inline-flex"
          >
            <Search className="h-3 w-3" />
            <span>QUICK SEARCH</span>
            <kbd className="ml-2 border border-border-strong px-1 py-px text-[9px]">
              ⌘K
            </kbd>
          </button>
          <HudPill tone={aiInfo ? 'success' : 'destructive'}>
            <Cpu className="h-2.5 w-2.5" />
            {aiInfo ? `${aiInfo.label}` : 'OFFLINE'}
          </HudPill>
        </div>
      </div>
    </header>
  )
}

function NavItem({
  children,
  active,
}: {
  children: React.ReactNode
  active?: boolean
}) {
  return (
    <button
      className={cn(
        'border-b-2 px-2 py-1 font-mono text-[11px] uppercase tracking-[0.16em] transition-colors',
        active
          ? 'border-primary text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
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
    return m > 0 ? `${m}m${s.toFixed(0)}s` : `${s.toFixed(1)}s`
  })()
  return (
    <Link
      to={`/jobs/${job.id}`}
      className="block px-3 py-2.5 transition-colors hover:bg-accent/30"
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <FolderOpen className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono text-[11px] font-medium">
            {job.folder_path.split('/').pop() || job.folder_path}
          </span>
        </div>
        <HudPill tone={tone}>
          {job.status === 'done'
            ? '✓ READY'
            : job.status === 'failed'
              ? '× FAIL'
              : isActive
                ? `${Math.round(job.progress)}%`
                : 'IDLE'}
        </HudPill>
      </div>
      <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70">
        <span className="flex items-center gap-1">
          <Clock className="h-2.5 w-2.5" />
          {formatDate(job.created_at)}
        </span>
        {elapsed && <span className="tabular-nums">⏱ {elapsed}</span>}
      </div>
      {isActive && (
        <SegProgress value={job.progress} segments={28} className="mt-2 h-[3px]" />
      )}
    </Link>
  )
}

// Keep import surface stable: Sparkles re-export prevents tree-shaker complaints
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _keep = { Sparkles }
