import { useEffect, useRef, useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { api } from '../api'
import type { AnalysisJob } from '../types'
import LogPane from '../components/LogPane'
import Shell from '../components/Shell'
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

  type Phase = {
    idx: number
    label: string
    sub: string
    state: 'pending' | 'active' | 'done'
  }
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

  // Sidebar: phase rail
  const sidebar = (
    <div className="flex flex-col">
      <div className="px-3 py-3 text-[10.5px] uppercase tracking-wider text-muted-foreground/80">
        Phases
      </div>
      <div className="flex flex-col">
        {phases.map((p) => (
          <div
            key={p.idx}
            className={cn(
              'flex items-start gap-2 border-l-2 px-3 py-2',
              p.state === 'active' && 'border-l-[var(--primary)] bg-primary/5',
              p.state === 'done' && 'border-l-[var(--success)]',
              p.state === 'pending' && 'border-l-transparent',
            )}
          >
            <span
              className={cn(
                'mt-0.5 flex h-4 w-4 items-center justify-center rounded-full text-[9.5px] font-semibold tabular-nums',
                p.state === 'done' && 'bg-success text-success-foreground',
                p.state === 'active' &&
                  'border border-primary bg-primary/15 text-[var(--primary)]',
                p.state === 'pending' &&
                  'border border-border-strong bg-muted text-muted-foreground',
              )}
            >
              {p.state === 'done' ? <Check className="h-2.5 w-2.5" /> : p.idx}
            </span>
            <div className="flex-1">
              <div className="text-[12px] font-medium">{p.label}</div>
              <div className="text-[11px] text-muted-foreground">{p.sub}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )

  return (
    <Shell sidebar={sidebar} sidebarTitle="Analyzing">
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Top progress strip */}
        <div className="border-b border-border bg-card px-4 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <Loader2 className="h-4 w-4 animate-spin text-[var(--primary)]" />
            <div className="flex-1">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[13px] font-medium">
                  {job.status === 'queued'
                    ? 'Queued — waiting to start'
                    : clipsFound > 0
                      ? `Processed ${clipsFound} clip${clipsFound === 1 ? '' : 's'}`
                      : 'Scanning for video files…'}
                </span>
                <span className="text-[12px] tabular-nums text-muted-foreground">
                  {progress}%
                </span>
              </div>
              <div className="smooth-progress mt-2">
                <i style={{ width: `${progress}%` }} />
              </div>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11.5px] text-muted-foreground">
            <span>
              Clips:{' '}
              <span className="tabular-nums font-medium text-foreground">
                {clipsFound || '—'}
              </span>
            </span>
            <span>
              ETA:{' '}
              <span className="tabular-nums font-medium text-foreground">
                {progress > 0 && progress < 100 ? eta : '—'}
              </span>
            </span>
            <span>
              Status:{' '}
              <span className="font-medium text-foreground">
                {job.status === 'queued' ? 'Queued' : 'Running'}
              </span>
            </span>
          </div>
          {job.status === 'failed' && (
            <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
              Analysis failed.
              {job.error ? ` ${job.error}` : ' Check backend logs.'}
            </div>
          )}
        </div>

        {/* Logs pane */}
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <LogPane
            jobId={job.id}
            active={job.status === 'running' || job.status === 'queued'}
          />
        </div>
      </div>
    </Shell>
  )
}
