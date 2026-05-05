import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Eye, Play, Sparkles, Wind, X } from 'lucide-react'
import { api } from '../api'
import { SEGMENTS } from '../constants'
import type { ClipResult, UpdateClipRequest } from '../types'
import VideoPreview from './VideoPreview'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

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

export default function ClipCard({
  clip,
  jobId,
  onUpdate,
  isSelected,
  onSelect,
}: Props) {
  const [imgError, setImgError] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
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

  const handleApprove = () =>
    patch({ approved: clip.approved === true ? null : true })
  const handleReject = () =>
    patch({ approved: clip.approved === false ? null : false })
  const handleSegment = (e: React.ChangeEvent<HTMLSelectElement>) =>
    patch({ suggested_segment: e.target.value })

  useEffect(() => {
    const card = cardRef.current
    if (!card) return

    const keyHandler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'SELECT' || target.tagName === 'INPUT') return
      if (e.key === 'a' || e.key === 'A') {
        e.preventDefault()
        handleApprove()
      }
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault()
        handleReject()
      }
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
  }, [clip]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={cardRef}
      onClick={onSelect}
      className={cn(
        'group relative flex flex-col overflow-hidden rounded-xl border bg-card transition-all',
        'border-border/70 hover:border-border hover:bg-card/80',
        isSelected && 'ring-2 ring-ring ring-offset-2 ring-offset-background',
        clip.approved === true && 'border-success/40',
        clip.approved === false && 'opacity-55',
      )}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setPreviewOpen(true)
        }}
        className="group/thumb relative aspect-video w-full overflow-hidden bg-muted"
        aria-label={`Play ${clip.filename}`}
      >
        {imgError ? (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
            no preview
          </div>
        ) : (
          <img
            src={api.thumbnailUrl(jobId, clip.id)}
            alt={clip.filename}
            onError={() => setImgError(true)}
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-300 group-hover/thumb:scale-[1.02]"
          />
        )}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 transition-opacity group-hover/thumb:opacity-100">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-foreground/95 text-background shadow-lg">
            <Play className="ml-0.5 h-4 w-4 fill-current" />
          </div>
        </div>
        <div className="absolute left-2 top-2 flex flex-wrap gap-1">
          {isShaky && (
            <Badge className="gap-1 border-0 bg-destructive/90 text-destructive-foreground">
              <Wind className="h-3 w-3" /> Shaky
            </Badge>
          )}
          {isBlurry && (
            <Badge className="gap-1 border-0 bg-warning/90 text-background">
              Blurry
            </Badge>
          )}
          {clip.is_duplicate && (
            <Badge className="gap-1 border-0 bg-info/90 text-background">
              <Copy className="h-3 w-3" /> Dup
            </Badge>
          )}
          {exposureBad && (
            <Badge className="gap-1 border-0 bg-warning/90 text-background">
              <Eye className="h-3 w-3" /> Expo
            </Badge>
          )}
        </div>
        <div className="absolute bottom-2 right-2 rounded-md bg-background/80 px-1.5 py-0.5 text-[11px] tabular-nums text-foreground backdrop-blur">
          {fmtDuration(clip.duration_sec)}
        </div>
        {clip.approved === true && (
          <div className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-success text-success-foreground shadow-sm">
            <Check className="h-3.5 w-3.5" />
          </div>
        )}
      </button>

      <div className="flex flex-col gap-2.5 p-3">
        <div className="flex items-center gap-1.5">
          <div
            className="min-w-0 flex-1 truncate text-xs font-medium"
            title={clip.filename}
          >
            {clip.filename}
          </div>
          {clip.ai_quality != null && (
            <Badge
              variant="secondary"
              className="h-5 shrink-0 gap-1 px-1.5 text-[10px]"
              title={`AI quality ${clip.ai_quality.toFixed(1)}/10`}
            >
              <Sparkles className="h-2.5 w-2.5" />
              {clip.ai_quality.toFixed(1)}
            </Badge>
          )}
        </div>

        {clip.ai_caption && (
          <p
            className="line-clamp-2 text-[11px] leading-snug text-muted-foreground"
            title={clip.ai_caption}
          >
            {clip.ai_caption}
          </p>
        )}

        <select
          className="h-7 rounded-md border border-border bg-input px-2 text-xs outline-none transition-colors focus:border-ring"
          value={clip.suggested_segment}
          onChange={handleSegment}
          onClick={(e) => e.stopPropagation()}
        >
          {SEGMENTS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <div className="grid grid-cols-3 gap-1.5">
          <ScoreBar label="S" score={clip.shake_score} bad={isShaky} />
          <ScoreBar label="B" score={clip.blur_score} bad={isBlurry} />
          <ScoreBar
            label="E"
            score={1 - clip.exposure_score}
            bad={exposureBad}
            invert
          />
        </div>

        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant={clip.approved === true ? 'default' : 'outline'}
            className={cn(
              'h-7 flex-1 px-2 text-xs',
              clip.approved === true &&
                'bg-success text-success-foreground hover:bg-success/90',
            )}
            onClick={(e) => {
              e.stopPropagation()
              handleApprove()
            }}
          >
            <Check className="h-3.5 w-3.5" />
            Approve
          </Button>
          <Button
            size="sm"
            variant={clip.approved === false ? 'destructive' : 'outline'}
            className="h-7 flex-1 px-2 text-xs"
            onClick={(e) => {
              e.stopPropagation()
              handleReject()
            }}
          >
            <X className="h-3.5 w-3.5" />
            Reject
          </Button>
        </div>
      </div>

      <VideoPreview
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        jobId={jobId}
        clip={clip}
        onApprove={handleApprove}
        onReject={handleReject}
      />
    </div>
  )
}

function ScoreBar({
  label,
  score,
  bad,
  invert,
}: {
  label: string
  score: number
  bad: boolean
  invert?: boolean
}) {
  const pct = Math.max(0, Math.min(1, invert ? 1 - score : score)) * 100
  return (
    <div
      className={cn(
        'flex flex-col gap-1 rounded-md border border-border/60 bg-muted/40 px-1.5 py-1',
        bad && 'border-warning/40 bg-warning/10',
      )}
      title={`${label}: ${(score).toFixed(2)}`}
    >
      <div className="flex items-center justify-between text-[10px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums font-medium">{Math.round(pct)}</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full', bad ? 'bg-warning' : 'bg-foreground/60')}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}
