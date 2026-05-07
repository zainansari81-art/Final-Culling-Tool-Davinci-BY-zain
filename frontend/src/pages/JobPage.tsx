import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  FolderOpen,
  ListOrdered,
  Sparkles,
} from 'lucide-react'
import { api } from '../api'
import { SEGMENTS } from '../constants'
import type { AnalysisJob, ClipResult } from '../types'
import BackendError from '../components/BackendError'
import ClipCard from '../components/ClipCard'
import ExportModal from '../components/ExportModal'
import ProgressPage from './ProgressPage'
import {
  HudFrame,
  HudPill,
  HudReadout,
  HudTitleBar,
  SegProgress,
} from '../components/Hud'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

const PAGE_SIZE = 50

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
  const [approveAllState, setApproveAllState] = useState<
    'idle' | 'loading' | 'done'
  >('idle')

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
    return list
  }, [clips, activeFilter, activeSegments])

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

  if (backendDown)
    return (
      <div className="p-6">
        <BackendError />
      </div>
    )

  if (loading)
    return (
      <div className="flex min-h-svh items-center justify-center text-[13px] text-muted-foreground">
        Loading job…
      </div>
    )

  if (notFound || !job)
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-3 px-6 text-center">
        <h2 className="text-base font-semibold tracking-tight">Job not found</h2>
        <p className="max-w-sm text-[13px] text-muted-foreground">
          This job is no longer in memory. The backend was likely restarted —
          jobs aren't persisted to disk yet. Start a new analysis from home.
        </p>
        <Button asChild>
          <Link to="/">Go home</Link>
        </Button>
      </div>
    )

  if (job.status === 'running' || job.status === 'queued') {
    return <ProgressPage job={job} onJobUpdate={handleJobUpdate} />
  }

  const folderName = job.folder_path.split('/').filter(Boolean).pop() ?? job.id
  const reviewedPct =
    stats.total > 0 ? ((stats.approved + stats.rejected) / stats.total) * 100 : 0
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

  return (
    <div className="min-h-svh">
      {/* TOP BAR — calm */}
      <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center justify-between gap-3 px-5 py-3">
          <div className="flex min-w-0 items-center gap-3">
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
              <span className="truncate text-[13px] font-medium">
                {folderName}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="sm" className="gap-1.5">
              <Link to={`/jobs/${id}/sequence`}>
                <ListOrdered className="h-3.5 w-3.5" />
                Sequence
              </Link>
            </Button>

            {approveAllState === 'done' ? (
              <HudPill tone="success">✓ Done</HudPill>
            ) : (
              <button
                type="button"
                onClick={handleApproveAll}
                disabled={approveAllState === 'loading'}
                className="cta-ghost"
              >
                <Sparkles className="h-3.5 w-3.5" />
                {approveAllState === 'loading' ? 'Running…' : 'Auto-approve'}
              </button>
            )}

            <button className="cta-primary" onClick={() => setShowExport(true)}>
              <Download className="h-4 w-4" />
              Export to Resolve
            </button>
          </div>
        </div>

        {/* sub-bar: stats + review progress */}
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-x-8 gap-y-3 border-t border-border/60 px-5 py-3">
          <HudReadout label="Total" value={stats.total} />
          <HudReadout
            label="Approved"
            value={stats.approved}
            accent="success"
          />
          <HudReadout
            label="Rejected"
            value={stats.rejected}
            accent="destructive"
          />
          <HudReadout
            label="Pending"
            value={stats.unreviewed}
            accent="warning"
          />
          {elapsed && <HudReadout label="Run time" value={elapsed} />}
          <div className="flex flex-1 min-w-[220px] items-center gap-3">
            <span className="text-[11.5px] text-muted-foreground">
              Review progress
            </span>
            <SegProgress value={reviewedPct} className="flex-1" />
            <span className="text-[12px] tabular-nums font-medium">
              {Math.round(reviewedPct)}%
            </span>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-[1500px] gap-5 px-5 py-6">
        {/* LEFT RAIL */}
        <aside className="hidden w-60 shrink-0 flex-col gap-4 lg:flex">
          {/* filter list */}
          <HudFrame>
            <HudTitleBar label="Filter" />
            <div className="flex flex-col py-1">
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
                      'mx-1 flex items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors',
                      active
                        ? 'bg-primary/10 text-foreground'
                        : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
                    )}
                  >
                    <span>{tab.label}</span>
                    <span
                      className={cn(
                        'tabular-nums text-[11.5px]',
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
            </div>
          </HudFrame>

          {/* segments */}
          <HudFrame>
            <HudTitleBar
              label="Segments"
              meta={
                presentSegments.length > 0
                  ? `${presentSegments.length} present`
                  : undefined
              }
            />
            <div className="flex flex-col py-1">
              {presentSegments.map((seg) => {
                const checked = activeSegments.has(seg)
                const segIdx = SEGMENTS.indexOf(seg)
                const segColor = `var(--tag-${(segIdx % 8) + 1})`
                return (
                  <button
                    key={seg}
                    onClick={() => toggleSegment(seg)}
                    className={cn(
                      'mx-1 flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors',
                      checked
                        ? 'bg-accent/40 text-foreground'
                        : 'text-muted-foreground hover:bg-accent/30 hover:text-foreground',
                    )}
                  >
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
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
                <div className="px-3 py-6 text-center text-[12px] text-muted-foreground">
                  No segments yet.
                </div>
              )}
              {activeSegments.size > 0 && (
                <button
                  onClick={() => {
                    setActiveSegments(new Set())
                    setPage(0)
                  }}
                  className="mx-1 mt-1 rounded-md px-2.5 py-1.5 text-left text-[12px] text-muted-foreground hover:bg-accent/30 hover:text-foreground"
                >
                  Clear filter
                </button>
              )}
            </div>
          </HudFrame>

          {/* hotkeys reference */}
          <HudFrame>
            <HudTitleBar label="Shortcuts" />
            <div className="grid grid-cols-2 gap-2 px-3 py-3 text-[11.5px]">
              <Key k="A" v="Approve" />
              <Key k="R" v="Reject" />
              <Key k="N" v="Near miss" />
              <Key k="1–9" v="Segment" />
              <Key k="←/→" v="Navigate" />
              <Key k="Space" v="Preview" />
            </div>
          </HudFrame>
        </aside>

        {/* MAIN */}
        <main className="min-w-0 flex-1">
          {/* mobile filter strip */}
          <ScrollArea className="mb-3 lg:hidden">
            <div className="flex gap-1.5 pb-2">
              {FILTER_TABS.map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => {
                    setActiveFilter(tab.key)
                    setPage(0)
                  }}
                  className={cn(
                    'flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-[12px]',
                    activeFilter === tab.key
                      ? 'border-primary bg-primary/15 text-[var(--primary)]'
                      : 'border-border text-muted-foreground',
                  )}
                >
                  {tab.label}
                  <span className="tabular-nums opacity-70">
                    {tabCounts[tab.key]}
                  </span>
                </button>
              ))}
            </div>
          </ScrollArea>

          {/* result count + paginator */}
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-3 text-[12px] text-muted-foreground">
              <span>
                <span className="tabular-nums font-medium text-foreground">
                  {filteredClips.length}
                </span>{' '}
                clip{filteredClips.length === 1 ? '' : 's'}
              </span>
              {activeSegments.size > 0 && (
                <span className="text-[var(--primary)]">
                  · {activeSegments.size} segment
                  {activeSegments.size === 1 ? '' : 's'}
                </span>
              )}
            </div>
            {totalPages > 1 && (
              <div className="flex items-center gap-2 text-[12px]">
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="rounded-md border border-border-strong p-1 text-muted-foreground transition-colors hover:border-primary hover:text-[var(--primary)] disabled:opacity-30"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <span className="tabular-nums text-muted-foreground">
                  Page {page + 1} of {totalPages}
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                  className="rounded-md border border-border-strong p-1 text-muted-foreground transition-colors hover:border-primary hover:text-[var(--primary)] disabled:opacity-30"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>

          {filteredClips.length === 0 ? (
            <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-border bg-muted/15 text-[13px] text-muted-foreground">
              No clips match the current filter.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
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
            <div className="mt-6 flex items-center justify-center gap-3 text-[12px]">
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
        </main>
      </div>

      {showExport && job && (
        <ExportModal job={job} onClose={() => setShowExport(false)} />
      )}
    </div>
  )
}

function Key({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center gap-2">
      <kbd className="rounded border border-border-strong bg-muted px-1.5 py-0.5 font-mono text-[10.5px] tabular-nums">
        {k}
      </kbd>
      <span className="text-muted-foreground">{v}</span>
    </div>
  )
}
