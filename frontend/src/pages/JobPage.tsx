import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Download,
  Sparkles,
} from 'lucide-react'
import { api } from '../api'
import { SEGMENTS } from '../constants'
import type { AnalysisJob, ClipResult } from '../types'
import BackendError from '../components/BackendError'
import ClipCard from '../components/ClipCard'
import ExportModal from '../components/ExportModal'
import ProgressPage from './ProgressPage'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

const PAGE_SIZE = 50

type FilterTab =
  | 'all'
  | 'unreviewed'
  | 'approved'
  | 'rejected'
  | 'shaky'
  | 'blurry'
  | 'duplicates'

const FILTER_TABS: { key: FilterTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unreviewed', label: 'Unreviewed' },
  { key: 'approved', label: 'Approved' },
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

  const tabCounts = useMemo(
    (): Record<FilterTab, number> => ({
      all: clips.length,
      unreviewed: clips.filter((c) => c.approved === null).length,
      approved: clips.filter((c) => c.approved === true).length,
      rejected: clips.filter((c) => c.approved === false).length,
      shaky: clips.filter((c) => c.shake_score > 0.15).length,
      blurry: clips.filter((c) => c.blur_score > 0.7).length,
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
        list = list.filter((c) => c.approved === null)
        break
      case 'approved':
        list = list.filter((c) => c.approved === true)
        break
      case 'rejected':
        list = list.filter((c) => c.approved === false)
        break
      case 'shaky':
        list = list.filter((c) => c.shake_score > 0.15)
        break
      case 'blurry':
        list = list.filter((c) => c.blur_score > 0.7)
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
        if (idx < pagedClips.length - 1)
          setSelectedClipId(pagedClips[idx + 1].id)
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
      <div className="flex min-h-svh items-center justify-center text-sm text-muted-foreground">
        Loading job…
      </div>
    )

  if (notFound || !job)
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-3 px-6 text-center">
        <h2 className="text-base font-semibold tracking-tight">Job not found</h2>
        <p className="max-w-sm text-sm text-muted-foreground">
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

  return (
    <div className="min-h-svh bg-background">
      <header className="sticky top-0 z-20 border-b border-border/70 bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-6 py-3">
          <div className="flex items-center gap-3">
            <Button asChild variant="ghost" size="icon" className="h-8 w-8">
              <Link to="/" aria-label="Back to home">
                <ArrowLeft className="h-4 w-4" />
              </Link>
            </Button>
            <div className="flex items-center gap-2">
              <Clapperboard className="h-4 w-4 text-muted-foreground" />
              <div className="text-sm font-medium" title={job.folder_path}>
                {folderName}
              </div>
            </div>
            <Separator orientation="vertical" className="h-5" />
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="tabular-nums">{stats.total}</span>
              <span>clips</span>
              <span className="text-success">·</span>
              <span className="tabular-nums text-success">
                {stats.approved}
              </span>
              <span>approved</span>
              <span className="text-destructive">·</span>
              <span className="tabular-nums text-destructive">
                {stats.rejected}
              </span>
              <span>rejected</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {approveAllState === 'done' ? (
              <Badge
                variant="secondary"
                className="bg-success/15 text-success"
              >
                ✓ Done
              </Badge>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={handleApproveAll}
                disabled={approveAllState === 'loading'}
              >
                <Sparkles className="h-3.5 w-3.5" />
                {approveAllState === 'loading' ? 'Running…' : 'Auto-approve'}
              </Button>
            )}
            <Button size="sm" onClick={() => setShowExport(true)}>
              <Download className="h-3.5 w-3.5" />
              Export
            </Button>
          </div>
        </div>
        <div className="mx-auto max-w-7xl px-6 pb-2">
          <Progress value={reviewedPct} className="h-1" />
        </div>
      </header>

      <div className="mx-auto flex max-w-7xl gap-6 px-6 py-6">
        <aside className="sticky top-[5.25rem] hidden h-fit w-56 shrink-0 lg:block">
          <h3 className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Segments
          </h3>
          <div className="space-y-0.5">
            {presentSegments.map((seg) => {
              const checked = activeSegments.has(seg)
              return (
                <label
                  key={seg}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent',
                    checked && 'bg-accent',
                  )}
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => toggleSegment(seg)}
                  />
                  <span className="flex-1 truncate">{seg}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {segmentCounts[seg] ?? 0}
                  </span>
                </label>
              )
            })}
            {presentSegments.length === 0 && (
              <p className="px-2 text-xs text-muted-foreground">
                No segments yet.
              </p>
            )}
            {activeSegments.size > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-1 w-full justify-start text-xs text-muted-foreground"
                onClick={() => {
                  setActiveSegments(new Set())
                  setPage(0)
                }}
              >
                Clear filter
              </Button>
            )}
          </div>
        </aside>

        <main className="min-w-0 flex-1">
          <Tabs
            value={activeFilter}
            onValueChange={(v) => {
              setActiveFilter(v as FilterTab)
              setPage(0)
            }}
            className="mb-4"
          >
            <ScrollArea className="w-full">
              <TabsList className="h-9">
                {FILTER_TABS.map((tab) => (
                  <TabsTrigger key={tab.key} value={tab.key} className="gap-1.5">
                    {tab.label}
                    {tabCounts[tab.key] > 0 && (
                      <Badge
                        variant="secondary"
                        className="h-4 min-w-4 px-1 text-[10px] font-medium"
                      >
                        {tabCounts[tab.key]}
                      </Badge>
                    )}
                  </TabsTrigger>
                ))}
              </TabsList>
            </ScrollArea>
          </Tabs>

          <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {filteredClips.length} clip
              {filteredClips.length !== 1 ? 's' : ''}
            </span>
            <span>
              <kbd className="rounded border border-border bg-muted px-1 py-0.5 text-[10px]">
                A
              </kbd>{' '}
              approve ·{' '}
              <kbd className="rounded border border-border bg-muted px-1 py-0.5 text-[10px]">
                R
              </kbd>{' '}
              reject ·{' '}
              <kbd className="rounded border border-border bg-muted px-1 py-0.5 text-[10px]">
                1–9
              </kbd>{' '}
              segment
            </span>
          </div>

          {filteredClips.length === 0 ? (
            <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-border bg-muted/20 text-sm text-muted-foreground">
              No clips match the current filter.
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
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
            <div className="mt-6 flex items-center justify-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
              >
                <ChevronLeft className="h-4 w-4" />
                Prev
              </Button>
              <span className="text-xs tabular-nums text-muted-foreground">
                {page + 1} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </Button>
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
