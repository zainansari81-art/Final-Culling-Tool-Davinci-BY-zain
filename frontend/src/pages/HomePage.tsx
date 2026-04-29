import { useState, useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { api } from '../api'
import type { AnalysisJob } from '../types'
import BackendError from '../components/BackendError'
import './HomePage.css'

const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  queued:  { label: 'Queued',      cls: 'badge-status--queued'  },
  running: { label: 'Analyzing…',  cls: 'badge-status--running' },
  done:    { label: 'Done',        cls: 'badge-status--done'    },
  failed:  { label: 'Failed',      cls: 'badge-status--failed'  },
}

export default function HomePage() {
  const navigate = useNavigate()
  const [folderPath, setFolderPath] = useState('')
  const [jobs, setJobs] = useState<AnalysisJob[]>([])
  const [loading, setLoading] = useState(true)
  const [backendDown, setBackendDown] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const loadJobs = async () => {
    try {
      const data = await api.listJobs()
      setJobs(data)
      setBackendDown(false)
    } catch {
      setBackendDown(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadJobs()
  }, [])

  // Poll running/queued jobs so progress updates in the list
  useEffect(() => {
    const hasActive = jobs.some((j) => j.status === 'running' || j.status === 'queued')
    if (!hasActive) return
    const timer = setInterval(loadJobs, 2000)
    return () => clearInterval(timer)
  }, [jobs])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!folderPath.trim()) return
    setSubmitting(true)
    setError('')
    try {
      const job = await api.createJob({ folder_path: folderPath.trim() })
      navigate(`/jobs/${job.id}`)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to start job'
      setError(msg)
      setSubmitting(false)
    }
  }

  if (backendDown) {
    return (
      <div className="home-page">
        <BackendError />
      </div>
    )
  }

  return (
    <div className="home-page">
      <div className="home-hero">
        <h1 className="home-title">Wedding Footage Culler</h1>
        <p className="home-subtitle">
          Drop your wedding footage path below to begin
        </p>

        <form className="home-form" onSubmit={handleSubmit}>
          <input
            type="text"
            className="home-input"
            placeholder="/Volumes/SSD/Wedding_2024_06_15/raw"
            value={folderPath}
            onChange={(e) => setFolderPath(e.target.value)}
            disabled={submitting}
            autoFocus
          />
          <button
            type="submit"
            className="home-btn"
            disabled={submitting || !folderPath.trim()}
          >
            {submitting ? 'Starting…' : 'Analyze'}
          </button>
        </form>

        {error && <div className="home-error">{error}</div>}
      </div>

      {!loading && jobs.length > 0 && (
        <div className="home-jobs">
          <h2 className="home-jobs__title">Recent Jobs</h2>
          <div className="jobs-list">
            {jobs.map((job) => {
              const info = STATUS_LABELS[job.status] ?? { label: job.status, cls: '' }
              const isActive = job.status === 'running' || job.status === 'queued'
              return (
                <div key={job.id} className="job-row">
                  <div className="job-row__left">
                    <span className={`badge-status ${info.cls}`}>{info.label}</span>
                    <div>
                      <div className="job-row__path">{job.folder_path}</div>
                      <div className="job-row__meta">
                        {job.clips.length} clips
                        {job.created_at && (
                          <> &middot; {new Date(job.created_at).toLocaleDateString()}</>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="job-row__right">
                    {isActive && (
                      <div className="job-progress">
                        <div
                          className="job-progress__bar"
                          style={{ width: `${job.progress}%` }}
                        />
                      </div>
                    )}
                    <Link to={`/jobs/${job.id}`} className="job-row__link">
                      {job.status === 'done' ? 'Review' : isActive ? 'View Progress' : 'Open'} &rarr;
                    </Link>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {loading && <div className="home-loading">Loading…</div>}
    </div>
  )
}
