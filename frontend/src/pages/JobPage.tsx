import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ListOrdered,
  Search,
  Sparkles,
} from 'lucide-react'
import { api } from '../api'
import { SEGMENTS } from '../constants'
import type { AnalysisJob, ClipResult } from '../types'
import BackendError from '../components/BackendError'
import ClipCard from '../components/ClipCard'
import ExportModal from '../components/ExportModal'
import ProgressPage from './ProgressPage'
import Shell from '../components/Shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

const PAGE_SIZE = 60

type FilterTab =
  | 'all'
  | 'unreviewed'
  | 'approved'
  | 'near_miss'
  | 'rejected'
  | 'shaky'
  | 'blurry'
  | 'duplicates'

const FILTER_TABS: { key: FilterTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unreviewed', label: 'Unreviewed' },
  { key: 'approved', label: 'Approved' },
  { key: 'near_miss', label: 'Near miss' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'shaky', label: 'Shaky' },
  { key: 'blurry', label: 'Blurry' },
  { key: 'duplicates', label: 'Duplicates' },
]

export default function JobPage() {
  const { id } = useParams<{ id: string }>()
  const [job, setJob] = useState<AnalysisJob | null>(null)
  const [clips, setClips] = useState<ClipResult[]>([])
  const [loading, setLoading] = useState(true)
  const [backendDown, setBackendDown] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const [activeFilter, setActiveFilter] = useState<FilterTab>('all')
  const [activeSegments, setActiveSegments] = useState<Set<string>>(new Set())
  const [showExport, setShowExport] = useState(false)
  const [page, setPage] = useState(0)
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [approveAllState, setApproveAllState] = useState<
    'idle' | 'loading' | 'done'
  >('idle')
  const [pushState, setPushState] = useState<
    'idle' | 'loading' | 'done' | 'error'
  >('idle')
  const [pushMsg, setPushMsg] = useState<string>('')

  const loadJob = useCallback(async () => {
    if (!id) return
    try {
      const jobData = await api.getJob(id)
      setJob(jobData)
      setClips(jobData.clips)
      setBackendDown(false)
      setNotFound(false)
    } catch (err: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const status = (err as any)?.response?.status
      if (status === 404) {
        setNotFound(true)
        setBackendDown(false)
      } else {
        setBackendDown(true)
      }
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    loadJob()
  }, [loadJob])

  const handleClipUpdate = useCallback((updated: ClipResult) => {
    setClips((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))
  }, [])

  const handleJobUpdate = useCallback((updated: AnalysisJob) => {
    setJob(updated)
    setClips(updated.clips)
  }, [])

  const presentSegments = useMemo(() => {
    const seen = new Set<string>()
    clips.forEach((c) => {
      if (c.suggested_segment) seen.add(c.suggested_segment)
    })
    return SEGMENTS.filter((s) => seen.has(s))
  }, [clips])

  const toggleSegment = (seg: string) => {
    setActiveSegments((prev) => {
      const next = new Set(prev)
      if (next.has(seg)) next.delete(seg)
      else next.add(seg)
      return next
    })
    setPage(0)
  }

  const stats = useMemo(
    () => ({
      total: clips.length,
      approved: clips.filter((c) => c.approved === true).length,
      rejected: clips.filter((c) => c.approved === false).length,
      unreviewed: clips.filter((c) => c.approved === null).length,
    }),
    [clips],
  )

  const isShakyVisible = (c: ClipResult) =>
    (c.ai_quality ?? 0) < 7 && c.shake_score > 0.35
  const isBlurryVisible = (c: ClipResult) =>
    (c.ai_quality ?? 0) < 7 && c.blur_score > 0.85

  const tabCounts = useMemo(
    (): Record<FilterTab, number> => ({
      all: clips.length,
      unreviewed: clips.filter((c) => c.approved === null && !c.near_miss).length,
      approved: clips.filter((c) => c.approved === true).length,
      near_miss: clips.filter((c) => c.near_miss).length,
      rejected: clips.filter((c) => c.approved === false).length,
      shaky: clips.filter(isShakyVisible).length,
      blurry: clips.filter(isBlurryVisible).length,
      duplicates: clips.filter((c) => c.is_duplicate).length,
    }),
    [clips],
  )

  const segmentCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    clips.forEach((c) => {
      if (c.suggested_segment)
        counts[c.suggested_segment] = (counts[c.suggested_segment] ?? 0) + 1
    })
    return counts
  }, [clips])

  const filteredClips = useMemo(() => {
    let list = clips
    switch (activeFilter) {
      case 'unreviewed':
        list = list.filter((c) => c.approved === null && !c.near_miss)
        break
      case 'approved':
        list = list.filter((c) => c.approved === true)
        break
      case 'near_miss':
        list = list.filter((c) => c.near_miss)
        break
      case 'rejected':
        list = list.filter((c) => c.approved === false)
        break
      case 'shaky':
        list = list.filter(isShakyVisible)
        break
      case 'blurry':
        list = list.filter(isBlurryVisible)
        break
      case 'duplicates':
        list = list.filter((c) => c.is_duplicate)
        break
    }
    if (activeSegments.size > 0) {
      list = list.filter((c) => activeSegments.has(c.suggested_segment))
    }
    if (query.trim()) {
      const q = query.trim().toLowerCase()
      list = list.filter(
        (c) =>
          c.filename.toLowerCase().includes(q) ||
          (c.ai_caption?.toLowerCase().includes(q) ?? false),
      )
    }
    return list
  }, [clips, activeFilter, activeSegments, query])

  const totalPages = Math.ceil(filteredClips.length / PAGE_SIZE)
  const pagedClips = filteredClips.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'SELECT' || target.tagName === 'INPUT') return
      if (selectedClipId === null) return
      const idx = pagedClips.findIndex((c) => c.id === selectedClipId)
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault()
        if (idx < pagedClips.length - 1) setSelectedClipId(pagedClips[idx + 1].id)
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault()
        if (idx > 0) setSelectedClipId(pagedClips[idx - 1].id)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [selectedClipId, pagedClips])

  const handleApproveAll = async () => {
    if (!id) return
    setApproveAllState('loading')
    try {
      await api.approveAll(id)
      await loadJob()
      setApproveAllState('done')
      setTimeout(() => setApproveAllState('idle'), 2500)
    } catch {
      setApproveAllState('idle')
    }
  }

  const handlePushToResolve = async () => {
    if (!id) return
    setPushState('loading')
    setPushMsg('')
    try {
      const r = await api.resolvePush(id, {
        mode: 'new_timeline',
        include_near_miss: true,
        include_rejected: false,
      })
      if (r.ok) {
        const errs = r.errors?.length ? ` · ${r.errors.length} err` : ''
        setPushMsg(`Pushed ${r.clips_added ?? 0} clips → ${r.timeline_name}${errs}`)
        setPushState('done')
      } else {
        setPushMsg(r.error ?? 'Push failed.')
        setPushState('error')
      }
      setTimeout(() => {
        setPushState('idle')
        setPushMsg('')
      }, 6000)
    } catch (err: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const detail = (err as any)?.response?.data?.detail
      setPushMsg(String(detail ?? (err instanceof Error ? err.message : 'Push failed.')))
      setPushState('error')
      setTimeout(() => {
        setPushState('idle')
        setPushMsg('')
      }, 6000)
    }
  }

  if (backendDown)
    return (
      <Shell hideSidebar>
        <div className="p-6">
          <BackendError />
        </div>
      </Shell>
    )

  if (loading)
    return (
      <Shell hideSidebar>
        <div className="flex flex-1 items-center justify-center text-[12.5px] text-muted-foreground">
          Loading job…
        </div>
      </Shell>
    )

  if (notFound || !job)
    return (
      <Shell hideSidebar>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <h2 className="text-base font-semibold tracking-tight">
            Job not found
          </h2>
          <p className="max-w-sm text-[12.5px] text-muted-foreground">
            This job is no longer in memory. Backend was likely restarted.
          </p>
          <Button asChild>
            <Link to="/">Go home</Link>
          </Button>
        </div>
      </Shell>
    )

  if (job.status === 'running' || job.status === 'queued') {
    return <ProgressPage job={job} onJobUpdate={handleJobUpdate} />
  }

  const folderName = job.folder_path.split('/').filter(Boolean).pop() ?? job.id
  const reviewedPct =
    stats.total > 0 ? ((stats.approved + stats.rejected) / stats.total) * 100 : 0

  // Sidebar content: filters + segments + shortcuts
  const sidebar = (
    <div className="flex flex-col">
      <Section label="Filter">
        {FILTER_TABS.map((tab) => {
          const active = activeFilter === tab.key
          const count = tabCounts[tab.key]
          return (
            <button
              key={tab.key}
              onClick={() => {
                setActiveFilter(tab.key)
                setPage(0)
              }}
              className={cn(
                'flex items-center justify-between border-l-2 px-3 py-1.5 text-left text-[12px] transition-colors',
                active
                  ? 'border-l-[var(--primary)] bg-primary/10 text-foreground'
                  : 'border-l-transparent text-muted-foreground hover:bg-accent/40 hover:text-foreground',
              )}
            >
              <span>{tab.label}</span>
              <span
                className={cn(
                  'tabular-nums text-[11px]',
                  active
                    ? 'text-[var(--primary)]'
                    : 'text-muted-foreground/70',
                )}
              >
                {count}
              </span>
            </button>
          )
        })}
      </Section>

      <Section
        label="Segments"
        action={
          activeSegments.size > 0 && (
            <button
              onClick={() => {
                setActiveSegments(new Set())
                setPage(0)
              }}
              className="text-[10.5px] text-[var(--primary)] hover:underline"
            >
              Clear
            </button>
          )
        }
      >
        {presentSegments.map((seg) => {
          const checked = activeSegments.has(seg)
          const segIdx = SEGMENTS.indexOf(seg)
          const segColor = `var(--tag-${(segIdx % 8) + 1})`
          return (
            <button
              key={seg}
              onClick={() => toggleSegment(seg)}
              className={cn(
                'flex items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors',
                checked
                  ? 'bg-accent/40 text-foreground'
                  : 'text-muted-foreground hover:bg-accent/30 hover:text-foreground',
              )}
            >
              <span
                className="h-2 w-2 shrink-0 rounded-sm"
                style={{ background: segColor }}
              />
              <span className="flex-1 truncate">{seg}</span>
              <span className="tabular-nums text-[11px] text-muted-foreground/70">
                {segmentCounts[seg] ?? 0}
              </span>
            </button>
          )
        })}
        {presentSegments.length === 0 && (
          <p className="px-3 py-2 text-[11px] text-muted-foreground/70">
            None yet.
          </p>
        )}
      </Section>

      <Section label="Shortcuts">
        <div className="grid grid-cols-2 gap-1.5 px-3 py-2 text-[11px]">
          <Key k="A" v="Approve" />
          <Key k="R" v="Reject" />
          <Key k="N" v="Near" />
          <Key k="1–9" v="Segment" />
          <Key k="←/→" v="Nav" />
          <Key k="Space" v="Preview" />
        </div>
      </Section>
    </div>
  )

  return (
    <Shell sidebar={sidebar} sidebarTitle={folderName}>
      {/* Action bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search clips…"
            className="h-7 w-[200px] pl-7 text-[12px]"
          />
        </div>
        <div className="flex items-center gap-3 text-[11.5px]">
          <Stat label="Total" value={stats.total} />
          <Stat label="Keep" value={stats.approved} tone="success" />
          <Stat label="Cut" value={stats.rejected} tone="destructive" />
          <Stat label="Pending" value={stats.unreviewed} tone="warning" />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="hidden items-center gap-2 md:flex">
            <span className="text-[11px] text-muted-foreground">Reviewed</span>
            <div className="smooth-progress w-[120px]">
              <i style={{ width: `${reviewedPct}%` }} />
            </div>
            <span className="text-[11.5px] tabular-nums">
              {Math.round(reviewedPct)}%
            </span>
          </div>
          <Button asChild variant="outline" size="sm" className="h-7 gap-1.5">
            <Link to={`/jobs/${id}/sequence`}>
              <ListOrdered className="h-3.5 w-3.5" />
              Sequence
            </Link>
          </Button>
          {approveAllState === 'done' ? (
            <Badge variant="secondary" className="bg-success/15 text-[var(--success)]">
              ✓ Done
            </Badge>
          ) : (
            <button
              type="button"
              onClick={handleApproveAll}
              disabled={approveAllState === 'loading'}
              className="cta-ghost h-7"
            >
              <Sparkles className="h-3.5 w-3.5" />
              {approveAllState === 'loading' ? 'Running…' : 'Auto-approve'}
            </button>
          )}
          <button
            className="cta-primary h-7"
            onClick={handlePushToResolve}
            disabled={pushState === 'loading'}
            title="Send approved + near-miss clips to a new timeline in the active Resolve project"
          >
            {pushState === 'loading' ? '↻ Pushing…' : '→ Push to Resolve'}
          </button>
          {pushState !== 'idle' && pushMsg && (
            <Badge
              variant="secondary"
              className={cn(
                'max-w-[260px] truncate text-[11px]',
                pushState === 'done' && 'bg-success/15 text-[var(--success)]',
                pushState === 'error' && 'bg-destructive/15 text-destructive',
              )}
              title={pushMsg}
            >
              {pushMsg}
            </Badge>
          )}
          <button className="cta-ghost h-7" onClick={() => setShowExport(true)}>
            <Download className="h-3.5 w-3.5" />
            Export…
          </button>
        </div>
      </div>

      {/* Clip grid pane */}
      <div className="min-h-0 flex-1 overflow-auto bg-background p-3">
        {filteredClips.length === 0 ? (
          <div className="flex h-full min-h-[300px] items-center justify-center rounded-md border border-dashed border-border bg-card/40 text-[12.5px] text-muted-foreground">
            No clips match the current filter.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {pagedClips.map((clip) => (
              <ClipCard
                key={clip.id}
                clip={clip}
                jobId={id!}
                onUpdate={handleClipUpdate}
                isSelected={selectedClipId === clip.id}
                onSelect={() => setSelectedClipId(clip.id)}
              />
            ))}
          </div>
        )}

        {totalPages > 1 && (
          <div className="mt-5 flex items-center justify-center gap-2 text-[12px]">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="cta-ghost"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Prev
            </button>
            <span className="tabular-nums text-muted-foreground">
              Page {page + 1} of {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="cta-ghost"
            >
              Next
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      {showExport && job && (
        <ExportModal job={job} onClose={() => setShowExport(false)} />
      )}
    </Shell>
  )
}

function Section({
  label,
  action,
  children,
}: {
  label: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="border-b border-border">
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/80">
          {label}
        </span>
        {action}
      </div>
      <div className="flex flex-col pb-1">{children}</div>
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone?: 'success' | 'destructive' | 'warning'
}) {
  const toneClass = {
    success: 'text-[var(--success)]',
    destructive: 'text-destructive',
    warning: 'text-[var(--warning)]',
  } as const
  return (
    <span className="flex items-center gap-1">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          'tabular-nums font-medium',
          tone ? toneClass[tone] : 'text-foreground',
        )}
      >
        {value}
      </span>
    </span>
  )
}

function Key({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <kbd className="rounded-sm border border-border-strong bg-muted px-1.5 py-px font-mono text-[10px] tabular-nums">
        {k}
      </kbd>
      <span className="text-muted-foreground">{v}</span>
    </div>
  )
}
