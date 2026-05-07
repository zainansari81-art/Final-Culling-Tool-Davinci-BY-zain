import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  FolderOpen,
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
  { key: 'all', label: 'ALL' },
  { key: 'unreviewed', label: 'UNREVIEWED' },
  { key: 'approved', label: 'KEEP' },
  { key: 'near_miss', label: 'NEAR' },
  { key: 'rejected', label: 'CUT' },
  { key: 'shaky', label: 'SHAKY' },
  { key: 'blurry', label: 'BLURRY' },
  { key: 'duplicates', label: 'DUPS' },
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
      <div className="flex min-h-svh items-center justify-center font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
        // LOADING SESSION ···
      </div>
    )

  if (notFound || !job)
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-destructive">
          // ERROR · 404 SESSION
        </div>
        <h2 className="text-base font-semibold tracking-tight">Job not found</h2>
        <p className="max-w-sm text-[12px] text-muted-foreground">
          This job is no longer in memory. Backend was likely restarted —
          jobs aren't persisted to disk yet.
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
    return m > 0 ? `${m}m${s.toFixed(0)}s` : `${s.toFixed(1)}s`
  })()

  return (
    <div className="min-h-svh">
      {/* TOP BAR — breadcrumb + search + actions */}
      <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between gap-4 px-5 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <Button asChild variant="ghost" size="icon" className="h-7 w-7">
              <Link to="/" aria-label="Back to home">
                <ArrowLeft className="h-3.5 w-3.5" />
              </Link>
            </Button>
            <span className="tick" />
            <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
              SESSIONS
            </span>
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
            <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
              REVIEW
            </span>
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
            <div
              className="flex min-w-0 items-center gap-1.5 border border-border bg-muted/30 px-2 py-1"
              title={job.folder_path}
            >
              <FolderOpen className="h-3 w-3 shrink-0 text-[var(--primary)]" />
              <span className="truncate font-mono text-[11px] font-medium">
                {folderName}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              className="hidden items-center gap-2 border border-border bg-muted/40 px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground md:inline-flex"
            >
              <Search className="h-3 w-3" />
              <span>FIND CLIP</span>
              <kbd className="ml-2 border border-border-strong px-1 py-px text-[9px]">
                ⌘F
              </kbd>
            </button>

            <Button asChild variant="outline" size="sm" className="h-7 gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em]">
              <Link to={`/jobs/${id}/sequence`}>
                <ListOrdered className="h-3 w-3" />
                SEQUENCE
              </Link>
            </Button>

            {approveAllState === 'done' ? (
              <HudPill tone="success">✓ DONE</HudPill>
            ) : (
              <button
                type="button"
                onClick={handleApproveAll}
                disabled={approveAllState === 'loading'}
                className="hud-cta-ghost"
              >
                <Sparkles className="h-3 w-3" />
                {approveAllState === 'loading' ? 'RUNNING…' : 'AUTO-KEEP'}
              </button>
            )}

            <button
              className="hud-cta"
              onClick={() => setShowExport(true)}
            >
              <Download className="h-3.5 w-3.5" />
              EXPORT TO RESOLVE
            </button>
          </div>
        </div>

        {/* sub-readout strip */}
        <div className="mx-auto flex max-w-[1500px] items-center gap-6 border-t border-border/60 px-5 py-2">
          <HudReadout
            label="Total"
            value={stats.total.toString().padStart(3, '0')}
            hint="CLIPS"
          />
          <HudReadout
            label="Keep"
            value={stats.approved.toString().padStart(3, '0')}
            hint="APPROVED"
            accent="success"
          />
          <HudReadout
            label="Cut"
            value={stats.rejected.toString().padStart(3, '0')}
            hint="REJECTED"
            accent="destructive"
          />
          <HudReadout
            label="Pending"
            value={stats.unreviewed.toString().padStart(3, '0')}
            hint="UNREVIEWED"
            accent="warning"
          />
          {elapsed && (
            <HudReadout
              label="Run-time"
              value={elapsed}
              hint="ANALYSIS"
            />
          )}
          <div className="ml-auto flex flex-1 items-center gap-3">
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              REVIEW PROGRESS
            </span>
            <SegProgress value={reviewedPct} segments={48} className="flex-1" />
            <span className="font-mono text-[11px] tabular-nums text-foreground">
              {Math.round(reviewedPct)}%
            </span>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-[1500px] gap-4 px-5 py-5">
        {/* LEFT RAIL: filters + segments */}
        <aside className="hidden w-64 shrink-0 flex-col gap-4 lg:flex">
          {/* Filter list */}
          <HudFrame>
            <HudTitleBar label="FILTER" />
            <div className="flex flex-col">
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
                      'group flex items-center justify-between border-l-2 px-3 py-2 text-left font-mono text-[11px] uppercase tracking-[0.14em] transition-colors',
                      active
                        ? 'border-l-[var(--primary)] bg-primary/10 text-foreground'
                        : 'border-l-transparent text-muted-foreground hover:bg-accent/30 hover:text-foreground',
                    )}
                  >
                    <span>{tab.label}</span>
                    <span
                      className={cn(
                        'tabular-nums',
                        active ? 'text-[var(--primary)]' : 'text-muted-foreground/70',
                      )}
                    >
                      {count}
                    </span>
                  </button>
                )
              })}
            </div>
          </HudFrame>

          {/* Segments */}
          <HudFrame>
            <HudTitleBar
              label="SEGMENTS"
              meta={`${presentSegments.length} ACTIVE`}
            />
            <div className="flex flex-col">
              {presentSegments.map((seg) => {
                const checked = activeSegments.has(seg)
                const segIdx = SEGMENTS.indexOf(seg)
                const segColor = `var(--tag-${(segIdx % 8) + 1})`
                return (
                  <button
                    key={seg}
                    onClick={() => toggleSegment(seg)}
                    className={cn(
                      'group flex items-center gap-2 border-l-2 px-3 py-2 text-left font-mono text-[11px] transition-colors',
                      checked
                        ? 'bg-accent/40 text-foreground'
                        : 'border-l-transparent text-muted-foreground hover:bg-accent/20 hover:text-foreground',
                    )}
                    style={{
                      borderLeftColor: checked ? segColor : 'transparent',
                    }}
                  >
                    <span
                      className="h-2 w-2 shrink-0"
                      style={{ background: segColor }}
                    />
                    <span className="flex-1 truncate uppercase tracking-[0.06em]">
                      {seg}
                    </span>
                    <span className="tabular-nums text-muted-foreground/70">
                      {segmentCounts[seg] ?? 0}
                    </span>
                  </button>
                )
              })}
              {presentSegments.length === 0 && (
                <div className="hud-hatch px-3 py-6 text-center font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  NO SEGMENTS
                </div>
              )}
              {activeSegments.size > 0 && (
                <button
                  onClick={() => {
                    setActiveSegments(new Set())
                    setPage(0)
                  }}
                  className="border-t border-border px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--primary)] hover:bg-primary/5"
                >
                  × CLEAR FILTER
                </button>
              )}
            </div>
          </HudFrame>

          {/* Hotkeys reference */}
          <HudFrame>
            <HudTitleBar label="HOTKEYS" />
            <div className="grid grid-cols-2 gap-2 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em]">
              <Key k="A" v="KEEP" />
              <Key k="R" v="CUT" />
              <Key k="N" v="NEAR" />
              <Key k="1-9" v="SEGMENT" />
              <Key k="←/→" v="NAVIGATE" />
              <Key k="⌘F" v="FIND" />
            </div>
          </HudFrame>
        </aside>

        {/* MAIN: clip grid */}
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
                    'flex shrink-0 items-center gap-1.5 border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em]',
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
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              <span>
                <span className="tabular-nums text-foreground">
                  {filteredClips.length.toString().padStart(3, '0')}
                </span>
                {' '}MATCHES
              </span>
              {activeSegments.size > 0 && (
                <span className="text-[var(--primary)]">
                  · {activeSegments.size} SEG FILTER
                </span>
              )}
            </div>
            {totalPages > 1 && (
              <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="border border-border-strong p-1 disabled:opacity-30 hover:border-primary hover:text-[var(--primary)]"
                >
                  <ChevronLeft className="h-3 w-3" />
                </button>
                <span className="tabular-nums">
                  {(page + 1).toString().padStart(2, '0')} /{' '}
                  {totalPages.toString().padStart(2, '0')}
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                  className="border border-border-strong p-1 disabled:opacity-30 hover:border-primary hover:text-[var(--primary)]"
                >
                  <ChevronRight className="h-3 w-3" />
                </button>
              </div>
            )}
          </div>

          {filteredClips.length === 0 ? (
            <div className="hud-hatch flex h-64 items-center justify-center border border-dashed border-border">
              <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                // NO CLIPS MATCH
              </span>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
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
            <div className="mt-6 flex items-center justify-center gap-3 font-mono text-[11px] uppercase tracking-[0.14em]">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="hud-cta-ghost"
              >
                <ChevronLeft className="h-3 w-3" />
                PREV
              </button>
              <span className="tabular-nums text-muted-foreground">
                PAGE {(page + 1).toString().padStart(2, '0')} /{' '}
                {totalPages.toString().padStart(2, '0')}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className="hud-cta-ghost"
              >
                NEXT
                <ChevronRight className="h-3 w-3" />
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
      <kbd className="border border-border-strong bg-muted px-1.5 py-0.5 text-[10px] tabular-nums">
        {k}
      </kbd>
      <span className="text-muted-foreground">{v}</span>
    </div>
  )
}
