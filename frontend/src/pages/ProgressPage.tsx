import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, FolderOpen, Loader2 } from 'lucide-react'
import { api } from '../api'
import type { AnalysisJob } from '../types'
import LogPane from '../components/LogPane'
import {
  HudFrame,
  HudReadout,
  HudTitleBar,
  SegProgress,
} from '../components/Hud'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface Props {
  job: AnalysisJob
  onJobUpdate: (updated: AnalysisJob) => void
}

export default function ProgressPage({ job, onJobUpdate }: Props) {
  const progress = Math.round(job.progress ?? 0)
  const clipsFound = job.clips?.length ?? 0
  const [eta, setEta] = useState<string>('—')
  const lastTickRef = useRef<{ ts: number; pct: number } | null>(null)

  useEffect(() => {
    if (job.status === 'done' || job.status === 'failed') return
    const timer = setInterval(async () => {
      try {
        const updated = await api.getJob(job.id)
        onJobUpdate(updated)
        if (updated.status === 'done' || updated.status === 'failed') {
          clearInterval(timer)
        }
      } catch (err) {
        console.error('progress poll error', err)
      }
    }, 2000)
    return () => clearInterval(timer)
  }, [job.status, job.id, onJobUpdate])

  useEffect(() => {
    const now = Date.now()
    const last = lastTickRef.current
    if (!last) {
      lastTickRef.current = { ts: now, pct: progress }
      return
    }
    const dt = (now - last.ts) / 1000
    const dpct = progress - last.pct
    if (dt > 0.5 && dpct > 0) {
      const remainingPct = 100 - progress
      const seconds = Math.round((remainingPct / dpct) * dt)
      if (seconds < 60) setEta(`${seconds}s`)
      else setEta(`${Math.round(seconds / 60)}m`)
      lastTickRef.current = { ts: now, pct: progress }
    }
  }, [progress])

  const statusText =
    job.status === 'queued'
      ? 'QUEUED · WAITING TO START'
      : clipsFound > 0
        ? `PROCESSED ${clipsFound} CLIP${clipsFound === 1 ? '' : 'S'}`
        : 'SCANNING FOR VIDEO FILES…'

  const folderName = job.folder_path.split('/').filter(Boolean).pop() ?? job.id

  type Phase = { idx: number; label: string; state: 'pending' | 'active' | 'done' }
  const phases: Phase[] = [
    {
      idx: 1,
      label: 'SCAN · DISCOVER FILES',
      state: progress > 5 || clipsFound > 0 ? 'done' : 'active',
    },
    {
      idx: 2,
      label: 'ANALYZE · SHAKE / BLUR / EXPOSURE',
      state: progress >= 95 ? 'done' : progress > 5 ? 'active' : 'pending',
    },
    {
      idx: 3,
      label: 'DETECT · DUPLICATE GROUPING',
      state: job.status === 'done' ? 'done' : progress >= 95 ? 'active' : 'pending',
    },
  ]

  return (
    <div className="min-h-svh">
      <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-5 py-2.5">
          <Button asChild variant="ghost" size="icon" className="h-7 w-7">
            <Link to="/" aria-label="Back to home">
              <ArrowLeft className="h-3.5 w-3.5" />
            </Link>
          </Button>
          <span className="tick" />
          <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
            ANALYSIS · LIVE
          </span>
          <div
            className="ml-1 flex min-w-0 items-center gap-1.5 border border-border bg-muted/30 px-2 py-1"
            title={job.folder_path}
          >
            <FolderOpen className="h-3 w-3 shrink-0 text-[var(--primary)]" />
            <span className="truncate font-mono text-[11px] font-medium">
              {folderName}
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-5 py-6">
        <div className="mb-5">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--primary)]">
            // ANALYSIS · IN PROGRESS
          </div>
          <h1 className="mt-2 text-[24px] font-semibold tracking-tight">
            Scoring keyframes &amp; finding duplicates
          </h1>
        </div>

        {/* Main progress frame */}
        <HudFrame state="active" scanline>
          <HudTitleBar
            label="JOB · ACTIVE TELEMETRY"
            status={`${progress}%`}
            meta={`ID ${job.id.slice(0, 8).toUpperCase()}`}
          />
          <div className="space-y-4 px-4 py-4">
            <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em]">
              <Loader2 className="h-3 w-3 animate-spin text-[var(--primary)]" />
              <span className="text-foreground/80">{statusText}</span>
            </div>
            <SegProgress value={progress} segments={48} />
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <HudReadout
                label="Progress"
                value={`${progress}%`}
                hint="OF TOTAL"
                accent="primary"
              />
              <HudReadout
                label="Clips"
                value={(clipsFound || 0).toString().padStart(3, '0')}
                hint="DISCOVERED"
              />
              <HudReadout
                label="ETA"
                value={progress > 0 && progress < 100 ? eta : '—'}
                hint="REMAINING"
                accent={progress > 0 && progress < 100 ? 'warning' : 'default'}
              />
              <HudReadout
                label="State"
                value={job.status === 'queued' ? 'QUEUED' : 'RUNNING'}
                hint="JOB"
                accent="success"
                align="right"
              />
            </div>
          </div>
        </HudFrame>

        {job.status === 'failed' && (
          <div className="mt-4 border border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-destructive">
            ERR · ANALYSIS FAILED
            {job.error ? ` · ${job.error}` : ' · CHECK BACKEND LOGS.'}
          </div>
        )}

        {/* Phase rail */}
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
          {phases.map((p) => (
            <HudFrame key={p.idx} state={p.state}>
              <div className="flex items-center justify-between border-b border-border bg-panel-header px-3 py-2 font-mono text-[10px] uppercase tracking-[0.14em]">
                <span className="text-muted-foreground/80">
                  // PHASE {p.idx.toString().padStart(2, '0')}
                </span>
                <span
                  className={cn(
                    'tabular-nums',
                    p.state === 'done' && 'text-[var(--success)]',
                    p.state === 'active' && 'text-[var(--primary)]',
                    p.state === 'pending' && 'text-muted-foreground/60',
                  )}
                >
                  {p.state === 'done' ? '✓ DONE' : p.state === 'active' ? '▶ RUN' : '· IDLE'}
                </span>
              </div>
              <div className="px-3 py-3 font-mono text-[11px] uppercase tracking-[0.06em] text-foreground">
                {p.label}
              </div>
              <SegProgress
                value={p.state === 'done' ? 100 : p.state === 'active' ? 50 : 0}
                segments={20}
                variant={p.state === 'done' ? 'success' : 'primary'}
                className="mx-3 mb-3"
              />
            </HudFrame>
          ))}
        </div>

        {/* LIVE LOGS */}
        <div className="mt-4">
          <LogPane
            jobId={job.id}
            active={job.status === 'running' || job.status === 'queued'}
          />
        </div>
      </main>
    </div>
  )
}
