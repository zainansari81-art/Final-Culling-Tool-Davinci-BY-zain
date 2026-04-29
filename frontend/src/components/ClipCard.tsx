import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { SEGMENTS } from '../constants'
import type { ClipResult, UpdateClipRequest } from '../types'
import './ClipCard.css'

interface Props {
  clip: ClipResult
  jobId: string
  onUpdate: (updated: ClipResult) => void
  isSelected?: boolean
  onSelect?: () => void
}

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function ClipCard({ clip, jobId, onUpdate, isSelected, onSelect }: Props) {
  const [imgError, setImgError] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)

  const isShaky = clip.shake_score > 0.15
  const isBlurry = clip.blur_score > 0.7
  const exposureBad = clip.exposure_score < 0.2 || clip.exposure_score > 0.9

  const patch = async (payload: UpdateClipRequest) => {
    try {
      const updated = await api.patchClip(jobId, clip.id, payload)
      onUpdate(updated)
    } catch (err) {
      console.error('patch failed', err)
    }
  }

  const handleApprove = () => patch({ approved: clip.approved === true ? null : true })
  const handleReject = () => patch({ approved: clip.approved === false ? null : false })
  const handleSegment = (e: React.ChangeEvent<HTMLSelectElement>) =>
    patch({ suggested_segment: e.target.value })

  useEffect(() => {
    const card = cardRef.current
    if (!card) return

    const keyHandler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'SELECT' || target.tagName === 'INPUT') return
      if (e.key === 'a' || e.key === 'A') { e.preventDefault(); handleApprove() }
      if (e.key === 'r' || e.key === 'R') { e.preventDefault(); handleReject() }
      const num = parseInt(e.key)
      if (!isNaN(num) && num >= 1 && num <= SEGMENTS.length) {
        patch({ suggested_segment: SEGMENTS[num - 1] })
      }
    }

    const mouseenter = () => window.addEventListener('keydown', keyHandler)
    const mouseleave = () => window.removeEventListener('keydown', keyHandler)

    card.addEventListener('mouseenter', mouseenter)
    card.addEventListener('mouseleave', mouseleave)

    return () => {
      card.removeEventListener('mouseenter', mouseenter)
      card.removeEventListener('mouseleave', mouseleave)
      window.removeEventListener('keydown', keyHandler)
    }
  }, [clip])  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={cardRef}
      className={[
        'clip-card',
        clip.approved === true ? 'clip-card--approved' : '',
        clip.approved === false ? 'clip-card--rejected clip-card--dimmed' : '',
        isSelected ? 'clip-card--selected' : '',
      ].filter(Boolean).join(' ')}
      onClick={onSelect}
    >
      <div className="clip-card__thumb-wrap">
        {imgError ? (
          <div className="clip-card__thumb-placeholder">no preview</div>
        ) : (
          <img
            className="clip-card__thumb"
            src={api.thumbnailUrl(jobId, clip.id)}
            alt={clip.filename}
            onError={() => setImgError(true)}
            loading="lazy"
          />
        )}
        <div className="clip-card__badges">
          {isShaky && <span className="badge badge--red">SHAKY</span>}
          {isBlurry && <span className="badge badge--orange">BLURRY</span>}
          {clip.is_duplicate && <span className="badge badge--yellow">DUP</span>}
          {exposureBad && <span className="badge badge--orange">EXPO</span>}
        </div>
        <div className="clip-card__duration">{fmtDuration(clip.duration_sec)}</div>
      </div>

      <div className="clip-card__body">
        <div className="clip-card__filename" title={clip.filename}>
          {clip.filename}
        </div>

        <select
          className="clip-card__segment"
          value={clip.suggested_segment}
          onChange={handleSegment}
          onClick={(e) => e.stopPropagation()}
        >
          {SEGMENTS.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        <div className="clip-card__scores">
          <span className={`score${isShaky ? ' score--bad' : ''}`} title={`Shake: ${clip.shake_score.toFixed(2)}`}>
            S {(clip.shake_score * 100).toFixed(0)}
          </span>
          <span className={`score${isBlurry ? ' score--bad' : ''}`} title={`Blur: ${clip.blur_score.toFixed(2)}`}>
            B {(clip.blur_score * 100).toFixed(0)}
          </span>
          <span className={`score${exposureBad ? ' score--bad' : ''}`} title={`Exposure: ${clip.exposure_score.toFixed(2)}`}>
            E {(clip.exposure_score * 100).toFixed(0)}
          </span>
        </div>

        <div className="clip-card__actions">
          <button
            className={`action-btn action-btn--approve${clip.approved === true ? ' action-btn--active-approve' : ''}`}
            onClick={(e) => { e.stopPropagation(); handleApprove() }}
            title="Approve (A)"
          >
            ✓
          </button>
          <button
            className={`action-btn action-btn--reject${clip.approved === false ? ' action-btn--active-reject' : ''}`}
            onClick={(e) => { e.stopPropagation(); handleReject() }}
            title="Reject (R)"
          >
            ✗
          </button>
        </div>
      </div>
    </div>
  )
}
