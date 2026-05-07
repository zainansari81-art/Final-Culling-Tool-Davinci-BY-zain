import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Check, FolderOpen, Loader2 } from 'lucide-react'
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
      if (seconds < 60) setEta(`~${seconds}s`)
      else setEta(`~${Math.round(seconds / 60)}m`)
      lastTickRef.current = { ts: now, pct: progress }
    }
  }, [progress])

  const statusText =
    job.status === 'queued'
      ? 'Queued — waiting to start'
      : clipsFound > 0
        ? `Processed ${clipsFound} clip${clipsFound === 1 ? '' : 's'}`
        : 'Scanning for video files…'

  const folderName = job.folder_path.split('/').filter(Boolean).pop() ?? job.id

  type Phase = { idx: number; label: string; sub: string; state: 'pending' | 'active' | 'done' }
  const phases: Phase[] = [
    {
      idx: 1,
      label: 'Scan folder',
      sub: 'Finding video files',
      state: progress > 5 || clipsFound > 0 ? 'done' : 'active',
    },
    {
      idx: 2,
      label: 'Score clips',
      sub: 'Shake, blur, exposure',
      state: progress >= 95 ? 'done' : progress > 5 ? 'active' : 'pending',
    },
    {
      idx: 3,
      label: 'Group duplicates',
      sub: 'Perceptual hashing',
      state: job.status === 'done' ? 'done' : progress >= 95 ? 'active' : 'pending',
    },
  ]

  return (
    <div className="min-h-svh">
      <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-5 py-3">
          <Button asChild variant="ghost" size="icon" className="h-8 w-8">
            <Link to="/" aria-label="Back to home">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div
            className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-1.5"
            title={job.folder_path}
          >
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-[var(--primary)]" />
            <span className="truncate text-[13px] font-medium">{folderName}</span>
          </div>
          <span className="text-[12.5px] text-muted-foreground">
            Analyzing…
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-5 py-8">
        <div className="mb-6">
          <h1 className="text-[22px] font-semibold tracking-tight">
            Analyzing your footage
          </h1>
          <p className="mt-1.5 text-[13px] text-muted-foreground">
            Extracting keyframes, scoring quality, and detecting duplicates.
            You can leave this open — it'll move to review when done.
          </p>
        </div>

        <HudFrame state="active">
          <HudTitleBar
            label="Progress"
            status={
              job.status === 'queued'
                ? 'Queued'
                : `${progress}% complete`
            }
          />
          <div className="space-y-5 px-5 py-5">
            <div className="flex items-center gap-2 text-[13px]">
              <Loader2 className="h-4 w-4 animate-spin text-[var(--primary)]" />
              <span className="font-medium">{statusText}</span>
            </div>
            <SegProgress value={progress} />
            <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
              <HudReadout
                label="Clips found"
                value={clipsFound || '—'}
              />
              <HudReadout
                label="ETA"
                value={progress > 0 && progress < 100 ? eta : '—'}
                accent={progress > 0 && progress < 100 ? 'warning' : 'default'}
              />
              <HudReadout
                label="Status"
                value={job.status === 'queued' ? 'Queued' : 'Running'}
                accent="primary"
              />
              <HudReadout
                label="Done"
                value={`${progress}%`}
                accent="success"
                align="right"
              />
            </div>
          </div>
        </HudFrame>

        {job.status === 'failed' && (
          <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
            Analysis failed.
            {job.error ? ` ${job.error}` : ' Check backend logs.'}
          </div>
        )}

        <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-3">
          {phases.map((p) => (
            <HudFrame key={p.idx} state={p.state}>
              <div className="flex items-center justify-between border-b border-border bg-panel-header px-3.5 py-2">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'flex h-5 w-5 items-center justify-center rounded-full text-[10.5px] font-semibold tabular-nums',
                      p.state === 'done'
                        ? 'bg-success text-success-foreground'
                        : p.state === 'active'
                          ? 'border border-primary bg-primary/15 text-[var(--primary)]'
                          : 'border border-border-strong bg-muted text-muted-foreground',
                    )}
                  >
                    {p.state === 'done' ? <Check className="h-3 w-3" /> : p.idx}
                  </span>
                  <span className="text-[13px] font-medium">{p.label}</span>
                </div>
                <span
                  className={cn(
                    'text-[11px]',
                    p.state === 'done' && 'text-[var(--success)]',
                    p.state === 'active' && 'text-[var(--primary)]',
                    p.state === 'pending' && 'text-muted-foreground/60',
                  )}
                >
                  {p.state === 'done'
                    ? 'Done'
                    : p.state === 'active'
                      ? 'Running'
                      : 'Waiting'}
                </span>
              </div>
              <div className="px-3.5 py-3">
                <p className="text-[12px] text-muted-foreground">{p.sub}</p>
                <SegProgress
                  value={p.state === 'done' ? 100 : p.state === 'active' ? 50 : 0}
                  variant={p.state === 'done' ? 'success' : 'primary'}
                  className="mt-2.5"
                />
              </div>
            </HudFrame>
          ))}
        </div>

        <div className="mt-5">
          <LogPane
            jobId={job.id}
            active={job.status === 'running' || job.status === 'queued'}
          />
        </div>
      </main>
    </div>
  )
}
