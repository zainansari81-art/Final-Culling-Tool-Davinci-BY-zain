import { useState } from 'react'
import { api } from '../api'
import type { AnalysisJob } from '../types'
import './ExportModal.css'

function defaultFcpxmlPath(): string {
  const date = new Date().toISOString().slice(0, 10)
  return `${(globalThis as unknown as { process?: { env?: Record<string, string> } })?.process?.env?.HOME ?? '~'}/Desktop/wedding-${date}.fcpxml`
}

interface Props {
  job: AnalysisJob
  onClose: () => void
}

type ExportStatus = 'idle' | 'loading' | 'success' | 'error'

export default function ExportModal({ job, onClose }: Props) {
  const today = new Date().toISOString().slice(0, 10)
  const [projectName, setProjectName] = useState(`Wedding ${today}`)
  const [exportType, setExportType] = useState<'resolve' | 'fcpxml'>('resolve')
  const [status, setStatus] = useState<ExportStatus>('idle')
  const [errorMsg, setErrorMsg] = useState('')

  const handleExport = async () => {
    setStatus('loading')
    setErrorMsg('')
    try {
      if (exportType === 'resolve') {
        await api.exportResolve(job.id, projectName)
      } else {
        await api.exportFcpxml(job.id, defaultFcpxmlPath())
      }
      setStatus('success')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Export failed'
      setErrorMsg(msg)
      setStatus('error')
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h2>Export Project</h2>
          <button className="modal__close" onClick={onClose}>
            &#x2715;
          </button>
        </div>

        {status === 'success' ? (
          <div className="modal__success">
            <div className="modal__success-icon">&#x2713;</div>
            <p>
              {exportType === 'resolve'
                ? 'Project created in DaVinci Resolve'
                : 'FCPXML file exported successfully'}
            </p>
            <p className="modal__success-hint">
              {exportType === 'resolve'
                ? 'Open DaVinci Resolve to find your new project.'
                : 'Import the .fcpxml file in Final Cut Pro.'}
            </p>
            <button className="btn btn--primary" onClick={onClose}>
              Close
            </button>
          </div>
        ) : (
          <>
            <div className="modal__body">
              <label className="form-label">
                Project name
                <input
                  type="text"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  className="form-input"
                  disabled={status === 'loading'}
                  autoFocus
                />
              </label>

              <div>
                <div className="form-label-text">Export format</div>
                <div className="export-toggle">
                  <button
                    className={`export-toggle__btn${exportType === 'resolve' ? ' export-toggle__btn--active' : ''}`}
                    onClick={() => setExportType('resolve')}
                    disabled={status === 'loading'}
                  >
                    DaVinci Resolve
                  </button>
                  <button
                    className={`export-toggle__btn${exportType === 'fcpxml' ? ' export-toggle__btn--active' : ''}`}
                    onClick={() => setExportType('fcpxml')}
                    disabled={status === 'loading'}
                  >
                    FCPXML
                  </button>
                </div>
              </div>

              {status === 'error' && (
                <div className="modal__error">{errorMsg}</div>
              )}
            </div>

            <div className="modal__footer">
              <button
                className="btn btn--ghost"
                onClick={onClose}
                disabled={status === 'loading'}
              >
                Cancel
              </button>
              <button
                className="btn btn--primary"
                onClick={handleExport}
                disabled={status === 'loading' || !projectName.trim()}
              >
                {status === 'loading' ? 'Exporting…' : 'Export'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
