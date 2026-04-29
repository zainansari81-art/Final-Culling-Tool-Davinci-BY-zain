import { useEffect } from 'react'
import { api } from '../api'
import type { AnalysisJob } from '../types'
import './ProgressPage.css'

interface Props {
  job: AnalysisJob
  onJobUpdate: (updated: AnalysisJob) => void
}

export default function ProgressPage({ job, onJobUpdate }: Props) {
  const progress = Math.round(job.progress ?? 0)
  const clipsFound = job.clips?.length ?? 0

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

  const statusText = job.status === 'queued'
    ? 'Queued — waiting to start'
    : clipsFound > 0
    ? `Analyzing clip ${clipsFound} of many…`
    : 'Scanning for video files…'

  return (
    <div className="progress-page">
      <div className="progress-card">
        <div className="progress-spinner" />
        <h2 className="progress-title">Analyzing footage…</h2>
        <p className="progress-path">{job.folder_path}</p>

        <div className="progress-bar-wrap">
          <div className="progress-bar" style={{ width: `${progress}%` }} />
        </div>

        <div className="progress-numbers">
          <span>{progress}% complete</span>
          <span>{statusText}</span>
        </div>

        {job.status === 'failed' && (
          <div className="progress-error">
            Analysis failed.{job.error ? ` ${job.error}` : ' Check backend logs.'}
          </div>
        )}
      </div>
    </div>
  )
}
