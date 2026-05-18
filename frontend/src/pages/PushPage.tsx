import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, ArrowRight, Loader2 } from 'lucide-react'
import { api } from '../api'
import type { AnalysisJob, ClipResult } from '../types'
import Shell from '../components/Shell'
import { cn } from '@/lib/utils'

export default function PushPage() {
  const { id } = useParams<{ id: string }>()
  const [job, setJob] = useState<AnalysisJob | null>(null)
  const [mode, setMode] = useState<'new_timeline' | 'append'>('new_timeline')
  const [includeNearMiss, setIncludeNearMiss] = useState(true)
  const [includeRejected, setIncludeRejected] = useState(false)
  const [pushing, setPushing] = useState(false)
  const [result, setResult] = useState<{
    ok: boolean
    msg: string
    errors: string[]
  } | null>(null)

  useEffect(() => {
    if (!id) return
    api.getJob(id).then(setJob).catch(() => setJob(null))
  }, [id])

  const clips = job?.clips ?? []
  const counts = {
    approved: clips.filter((c: ClipResult) => c.approved === true).length,
    near_miss: clips.filter((c: ClipResult) => c.near_miss).length,
    rejected: clips.filter((c: ClipResult) => c.approved === false).length,
  }
  const total =
    counts.approved +
    (includeNearMiss ? counts.near_miss : 0) +
    (includeRejected ? counts.rejected : 0)

  const onPush = async () => {
    if (!id) return
    setPushing(true)
    setResult(null)
    try {
      const r = await api.resolvePush(id, {
        mode,
        include_near_miss: includeNearMiss,
        include_rejected: includeRejected,
      })
      if (r.ok) {
        setResult({
          ok: true,
          msg: `Added ${r.clips_added ?? 0} clip${(r.clips_added ?? 0) === 1 ? '' : 's'} → ${r.timeline_name} in ${r.project_name}`,
          errors: r.errors ?? [],
        })
      } else {
        setResult({
          ok: false,
          msg: r.error ?? 'Push failed.',
          errors: r.errors ?? [],
        })
      }
    } catch (err: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const detail = (err as any)?.response?.data?.detail
      setResult({
        ok: false,
        msg: String(detail ?? (err instanceof Error ? err.message : 'Push failed')),
        errors: [],
      })
    } finally {
      setPushing(false)
    }
  }

  return (
    <Shell>
      <div className="mx-auto max-w-2xl px-6 py-8">
        <Link
          to={id ? `/jobs/${id}` : '/'}
          className="mb-4 inline-flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to review
        </Link>

        <h1 className="text-[20px] font-semibold tracking-tight">
          Push to Resolve
        </h1>
        <p className="mt-1 text-[12.5px] text-muted-foreground">
          Send selected clips to a new (or active) timeline in the open Resolve
          project. Trims and markers come from the AI analysis.
        </p>

        <div className="mt-6 space-y-3 rounded-md border border-border/40 bg-card p-4">
          <div className="flex items-center justify-between text-[12.5px]">
            <span className="text-muted-foreground">Approved</span>
            <span className="font-medium text-[var(--success)]">{counts.approved}</span>
          </div>
          <div className="flex items-center justify-between text-[12.5px]">
            <span className="text-muted-foreground">Near-miss</span>
            <span className="font-medium">{counts.near_miss}</span>
          </div>
          <div className="flex items-center justify-between text-[12.5px]">
            <span className="text-muted-foreground">Rejected</span>
            <span className="font-medium text-destructive">{counts.rejected}</span>
          </div>
        </div>

        <div className="mt-6 space-y-3">
          <label className="flex cursor-pointer items-center gap-3 rounded-md border border-border/40 bg-card px-3 py-2.5 text-[12.5px]">
            <input
              type="radio"
              name="mode"
              checked={mode === 'new_timeline'}
              onChange={() => setMode('new_timeline')}
              className="accent-[var(--primary)]"
            />
            <div>
              <div className="font-medium">Create new timeline</div>
              <div className="text-[11px] text-muted-foreground">
                Adds a timeline named after the job to the active project.
              </div>
            </div>
          </label>
          <label className="flex cursor-pointer items-center gap-3 rounded-md border border-border/40 bg-card px-3 py-2.5 text-[12.5px]">
            <input
              type="radio"
              name="mode"
              checked={mode === 'append'}
              onChange={() => setMode('append')}
              className="accent-[var(--primary)]"
            />
            <div>
              <div className="font-medium">Append to active timeline</div>
              <div className="text-[11px] text-muted-foreground">
                Adds the clips at the end of the currently open timeline.
              </div>
            </div>
          </label>
        </div>

        <div className="mt-4 space-y-2">
          <label className="flex cursor-pointer items-center gap-2 text-[12.5px]">
            <input
              type="checkbox"
              checked={includeNearMiss}
              onChange={(e) => setIncludeNearMiss(e.target.checked)}
              className="accent-[var(--primary)]"
            />
            Include near-miss clips ({counts.near_miss})
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-[12.5px]">
            <input
              type="checkbox"
              checked={includeRejected}
              onChange={(e) => setIncludeRejected(e.target.checked)}
              className="accent-[var(--primary)]"
            />
            Include rejected clips ({counts.rejected})
          </label>
        </div>

        <div className="mt-6 flex items-center justify-between gap-3">
          <span className="text-[12px] text-muted-foreground">
            {total} clip{total === 1 ? '' : 's'} will be pushed.
          </span>
          <button
            onClick={onPush}
            disabled={pushing || total === 0}
            className="cta-primary"
          >
            {pushing ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Pushing…
              </>
            ) : (
              <>
                <ArrowRight className="h-3.5 w-3.5" />
                Push to Resolve
              </>
            )}
          </button>
        </div>

        {result && (
          <div
            className={cn(
              'mt-6 rounded-md border px-3 py-2.5 text-[12.5px]',
              result.ok
                ? 'border-success/40 bg-success/10 text-[var(--success)]'
                : 'border-destructive/40 bg-destructive/10 text-destructive',
            )}
          >
            {result.msg}
            {result.errors.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-[11px]">
                {result.errors.slice(0, 8).map((e, i) => (
                  <li key={i}>· {e}</li>
                ))}
                {result.errors.length > 8 && (
                  <li>· … and {result.errors.length - 8} more</li>
                )}
              </ul>
            )}
          </div>
        )}
      </div>
    </Shell>
  )
}
