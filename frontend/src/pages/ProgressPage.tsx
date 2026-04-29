import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Clapperboard, Loader2 } from 'lucide-react'
import { api } from '../api'
import type { AnalysisJob } from '../types'
import LogPane from '../components/LogPane'
import { Step, Stepper, type StepState } from '../components/StepCard'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'

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

  // Estimate ETA from progress delta over time
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

  // Derive step states
  const scanState: StepState =
    progress > 5 || clipsFound > 0 ? 'done' : 'active'
  const analyzeState: StepState =
    progress >= 95 ? 'done' : progress > 5 ? 'active' : 'pending'
  const dupState: StepState =
    job.status === 'done' ? 'done' : progress >= 95 ? 'active' : 'pending'

  return (
    <div className="min-h-svh bg-background">
      <header className="sticky top-0 z-20 border-b border-border/70 bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-6 py-3">
          <Button asChild variant="ghost" size="icon" className="h-8 w-8">
            <Link to="/" aria-label="Back to home">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <Clapperboard className="h-4 w-4 text-muted-foreground" />
          <div className="text-sm font-medium" title={job.folder_path}>
            {folderName}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-10">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">
            Analyzing footage
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Extracting keyframes, scoring quality, and detecting duplicates.
          </p>
        </div>

        <div className="mb-8 rounded-xl border border-border/70 bg-card p-5">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              <span className="font-medium">{statusText}</span>
            </div>
            <span className="text-sm tabular-nums font-medium">
              {progress}%
            </span>
          </div>
          <Progress value={progress} />
          <div className="mt-3 grid grid-cols-3 gap-3 text-xs">
            <Stat label="Clips found" value={clipsFound || '—'} />
            <Stat label="ETA" value={progress > 0 && progress < 100 ? eta : '—'} />
            <Stat
              label="Status"
              value={job.status === 'queued' ? 'Queued' : 'Running'}
            />
          </div>
        </div>

        {job.status === 'failed' && (
          <p className="mb-8 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            Analysis failed.
            {job.error ? ` ${job.error}` : ' Check backend logs.'}
          </p>
        )}

        <LogPane
          jobId={job.id}
          active={job.status === 'running' || job.status === 'queued'}
          className="mb-8"
        />

        <Stepper>
          <Step
            index={1}
            state={scanState}
            title="Scan for videos"
            subtitle="Walking the folder for supported video files."
            collapsible={false}
          />
          <Step
            index={2}
            state={analyzeState}
            title="Analyze keyframes"
            subtitle="Shake, blur and exposure scoring across each clip."
            collapsible={false}
          />
          <Step
            index={3}
            state={dupState}
            title="Detect duplicates"
            subtitle="Perceptual hashing across all clips."
            collapsible={false}
            isLast
          />
        </Stepper>
      </main>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 truncate text-sm tabular-nums font-medium">
        {value}
      </div>
    </div>
  )
}
