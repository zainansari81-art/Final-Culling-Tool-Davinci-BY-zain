import { useState, useEffect, useMemo, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { Download, Film } from 'lucide-react'
import { api } from '../api'
import { SEGMENTS } from '../constants'
import type { AnalysisJob, ClipResult } from '../types'
import ClipCard from '../components/ClipCard'
import ExportModal from '../components/ExportModal'
import ProgressPage from './ProgressPage'
import BackendError from '../components/BackendError'
import './JobPage.css'

const PAGE_SIZE = 50

type FilterTab = 'all' | 'unreviewed' | 'approved' | 'rejected' | 'shaky' | 'blurry' | 'duplicates'

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
  const [activeFilter, setActiveFilter] = useState<FilterTab>('all')
  const [activeSegments, setActiveSegments] = useState<Set<string>>(new Set())
  const [showExport, setShowExport] = useState(false)
  const [page, setPage] = useState(0)
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null)
  const [approveAllState, setApproveAllState] = useState<'idle' | 'loading' | 'done'>('idle')

  const loadJob = useCallback(async () => {
    if (!id) return
    try {
      const jobData = await api.getJob(id)
      setJob(jobData)
      setClips(jobData.clips)
      setBackendDown(false)
    } catch {
      setBackendDown(true)
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
    clips.forEach((c) => { if (c.suggested_segment) seen.add(c.suggested_segment) })
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

  const stats = useMemo(() => ({
    total: clips.length,
    approved: clips.filter((c) => c.approved === true).length,
    rejected: clips.filter((c) => c.approved === false).length,
    unreviewed: clips.filter((c) => c.approved === null).length,
  }), [clips])

  const tabCounts = useMemo((): Record<FilterTab, number> => ({
    all: clips.length,
    unreviewed: clips.filter((c) => c.approved === null).length,
    approved: clips.filter((c) => c.approved === true).length,
    rejected: clips.filter((c) => c.approved === false).length,
    shaky: clips.filter((c) => c.shake_score > 0.15).length,
    blurry: clips.filter((c) => c.blur_score > 0.7).length,
    duplicates: clips.filter((c) => c.is_duplicate).length,
  }), [clips])

  const segmentCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    clips.forEach((c) => {
      if (c.suggested_segment) counts[c.suggested_segment] = (counts[c.suggested_segment] ?? 0) + 1
    })
    return counts
  }, [clips])

  const filteredClips = useMemo(() => {
    let list = clips
    switch (activeFilter) {
      case 'unreviewed': list = list.filter((c) => c.approved === null); break
      case 'approved': list = list.filter((c) => c.approved === true); break
      case 'rejected': list = list.filter((c) => c.approved === false); break
      case 'shaky': list = list.filter((c) => c.shake_score > 0.15); break
      case 'blurry': list = list.filter((c) => c.blur_score > 0.7); break
      case 'duplicates': list = list.filter((c) => c.is_duplicate); break
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
      const result = await api.approveAll(id)
      await loadJob()
      setApproveAllState('done')
      setTimeout(() => setApproveAllState('idle'), 2500)
      console.log(`Auto-approved ${result.approved}, rejected ${result.rejected}`)
    } catch {
      setApproveAllState('idle')
    }
  }

  if (backendDown) return <div style={{ padding: '24px' }}><BackendError /></div>
  if (loading) return <div className="job-loading">Loading job…</div>
  if (!job) return <div className="job-loading">Job not found. <Link to="/">Go home</Link></div>

  if (job.status === 'running' || job.status === 'queued') {
    return <ProgressPage job={job} onJobUpdate={handleJobUpdate} />
  }

  const folderName = job.folder_path.split('/').filter(Boolean).pop() ?? job.id

  return (
    <div className="job-page">
      <header className="job-header">
        <div className="job-header__left">
          <Film size={16} />
          <div>
            <div className="job-header__path" title={job.folder_path}>{folderName}</div>
          </div>
          <div className="job-header__stats">
            <span className="stat">{stats.total} clips</span>
            <span className="stat stat--approved">{stats.approved} approved</span>
            <span className="stat stat--rejected">{stats.rejected} rejected</span>
            <span className="stat stat--muted">{stats.unreviewed} unreviewed</span>
          </div>
        </div>
        <div className="job-header__actions">
          {approveAllState === 'loading' && <span className="btn-action btn-action--loading">Running…</span>}
          {approveAllState === 'done' && <span className="btn-action btn-action--success">✓ Done</span>}
          {approveAllState === 'idle' && (
            <button
              className="btn-action"
              onClick={handleApproveAll}
              disabled={job.status !== 'done'}
            >
              Auto-approve
            </button>
          )}
          <button className="btn-action btn-action--primary" onClick={() => setShowExport(true)}>
            <Download size={12} style={{ display: 'inline', marginRight: 4 }} />
            Export
          </button>
          <Link to="/" className="btn-action">← Home</Link>
        </div>
      </header>

      <div className="job-tabs">
        {FILTER_TABS.map((tab) => (
          <button
            key={tab.key}
            className={`job-tab${activeFilter === tab.key ? ' job-tab--active' : ''}`}
            onClick={() => { setActiveFilter(tab.key); setPage(0) }}
          >
            {tab.label}
            {tabCounts[tab.key] > 0 && (
              <span className="job-tab__count">{tabCounts[tab.key]}</span>
            )}
          </button>
        ))}
      </div>

      <div className="job-body">
        <aside className="job-sidebar">
          <div className="sidebar-title">Segments</div>
          {presentSegments.map((seg) => (
            <label key={seg} className="sidebar-item">
              <input
                type="checkbox"
                checked={activeSegments.has(seg)}
                onChange={() => toggleSegment(seg)}
              />
              <span className="sidebar-item__label">{seg}</span>
              <span className="sidebar-item__count">{segmentCounts[seg] ?? 0}</span>
            </label>
          ))}
          {activeSegments.size > 0 && (
            <button className="sidebar-clear" onClick={() => { setActiveSegments(new Set()); setPage(0) }}>
              Clear
            </button>
          )}
        </aside>

        <div className="job-grid-wrap">
          <div className="job-grid-count">
            {filteredClips.length} clip{filteredClips.length !== 1 ? 's' : ''}
          </div>
          {filteredClips.length === 0 ? (
            <div className="job-empty">No clips match the current filter.</div>
          ) : (
            <div className="job-grid">
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
            <div style={{ display: 'flex', gap: 8, padding: '12px 0', alignItems: 'center' }}>
              <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}
                style={{ padding: '4px 10px', fontSize: 12 }}>← Prev</button>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {page + 1} / {totalPages}
              </span>
              <button onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
                style={{ padding: '4px 10px', fontSize: 12 }}>Next →</button>
            </div>
          )}
          <div className="job-grid-hint">
            Hover a clip: <kbd>A</kbd> approve · <kbd>R</kbd> reject · <kbd>1–9</kbd> segment
          </div>
        </div>
      </div>

      {showExport && job && (
        <ExportModal job={job} onClose={() => setShowExport(false)} />
      )}
    </div>
  )
}
