import { useEffect, useRef, useState } from 'react'
import {
  Brain,
  Check,
  ChevronDown,
  Copy,
  Eye,
  Mic,
  MoveVertical,
  Play,
  Scissors,
  Sparkles,
  Wind,
  X,
} from 'lucide-react'
import { api } from '../api'
import { SEGMENTS } from '../constants'
import type { ClipResult, UpdateClipRequest } from '../types'
import VideoPreview from './VideoPreview'
import { HudPill } from './Hud'
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
  const [whyOpen, setWhyOpen] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)

  const aiTrust = (clip.ai_quality ?? 0) >= 7
  const isShaky = !aiTrust && clip.shake_score > 0.35
  const isBlurry = !aiTrust && clip.blur_score > 0.85
  const exposureBad = !aiTrust && (clip.exposure_score < 0.2 || clip.exposure_score > 0.9)

  const segIdx = Math.max(0, SEGMENTS.indexOf(clip.suggested_segment))
  const segColor = `var(--tag-${(segIdx % 8) + 1})`

  const patch = async (payload: UpdateClipRequest) => {
    try {
      const updated = await api.patchClip(jobId, clip.id, payload)
      onUpdate(updated)
    } catch (err) {
      console.error('patch failed', err)
    }
  }

  const handleApprove = () =>
    patch({ approved: clip.approved === true ? null : true, near_miss: false })
  const handleReject = () =>
    patch({ approved: clip.approved === false ? null : false, near_miss: false })
  const handleNearMiss = () =>
    patch({
      near_miss: !clip.near_miss,
      approved: clip.near_miss ? clip.approved : null,
    })
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
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault()
        handleNearMiss()
      }
      const num = parseInt(e.key)
      if (!isNaN(num) && num >= 1 && num <= SEGMENTS.length) {
        patch({ suggested_segment: SEGMENTS[num - 1] })
      }
    }
    const me = () => window.addEventListener('keydown', keyHandler)
    const ml = () => window.removeEventListener('keydown', keyHandler)
    card.addEventListener('mouseenter', me)
    card.addEventListener('mouseleave', ml)
    return () => {
      card.removeEventListener('mouseenter', me)
      card.removeEventListener('mouseleave', ml)
      window.removeEventListener('keydown', keyHandler)
    }
  }, [clip]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={cardRef}
      onClick={onSelect}
      className={cn(
        'group relative flex cursor-pointer flex-col overflow-hidden rounded-xl border bg-card transition-all',
        'border-border hover:border-border-strong hover:bg-card/95',
        isSelected && 'ring-2 ring-primary/60 ring-offset-2 ring-offset-background',
        clip.approved === true && 'border-success/40',
        clip.approved === false && 'opacity-55',
      )}
    >
      {/* segment color stripe at top */}
      <span
        aria-hidden
        className="absolute left-0 right-0 top-0 h-[3px]"
        style={{ background: segColor }}
      />

      {/* THUMBNAIL */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setPreviewOpen(true)
        }}
        className="group/thumb relative aspect-video w-full overflow-hidden bg-rail"
        aria-label={`Play ${clip.filename}`}
      >
        {imgError ? (
          <div className="absolute inset-0 flex items-center justify-center text-[12px] text-muted-foreground">
            No preview
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

        {/* play overlay */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover/thumb:opacity-100">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/95 text-primary-foreground shadow-[0_0_22px_-4px_color-mix(in_srgb,var(--primary)_70%,transparent)]">
            <Play className="ml-0.5 h-4.5 w-4.5 fill-current" />
          </div>
        </div>

        {/* warning badges */}
        <div className="absolute left-2 top-2 flex flex-wrap gap-1">
          {isShaky && (
            <HudPill tone="destructive">
              <Wind className="h-3 w-3" /> Shaky
            </HudPill>
          )}
          {isBlurry && (
            <HudPill tone="warning">Blurry</HudPill>
          )}
          {clip.is_duplicate && (
            <HudPill tone="primary">
              <Copy className="h-3 w-3" /> Dup
            </HudPill>
          )}
          {exposureBad && (
            <HudPill tone="warning">
              <Eye className="h-3 w-3" /> Exposure
            </HudPill>
          )}
        </div>

        {/* timecode */}
        <div className="absolute bottom-2 right-2 rounded-md bg-black/75 px-2 py-0.5 font-mono text-[11px] tabular-nums text-foreground backdrop-blur">
          {fmtDuration(clip.duration_sec)}
        </div>
        {clip.analysis_sec != null && (
          <div
            className="absolute bottom-2 left-2 rounded-md bg-black/75 px-2 py-0.5 font-mono text-[11px] tabular-nums text-muted-foreground backdrop-blur"
            title={`Analysis took ${clip.analysis_sec.toFixed(2)}s`}
          >
            ⏱ {clip.analysis_sec.toFixed(1)}s
          </div>
        )}

        {clip.approved === true && (
          <div className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-success text-success-foreground shadow-md">
            <Check className="h-3.5 w-3.5" />
          </div>
        )}
        {clip.rank_in_group === 1 && clip.approved !== true && (
          <div
            className="absolute right-2 top-2 flex items-center gap-1 rounded-full border border-primary/60 bg-black/80 px-2 py-0.5 text-[10.5px] font-medium text-[var(--primary)]"
            title="Top take in this segment"
          >
            ★ Top pick
          </div>
        )}
      </button>

      {/* META */}
      <div className="flex flex-col gap-2.5 p-3">
        {/* filename + quality */}
        <div className="flex items-center gap-2">
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ background: segColor }}
            title={clip.suggested_segment}
          />
          <div
            className="min-w-0 flex-1 truncate text-[12.5px] font-medium"
            title={clip.filename}
          >
            {clip.filename}
          </div>
          {clip.ai_quality != null && (
            <span
              className="flex shrink-0 items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-[var(--primary)]"
              title={`AI quality ${clip.ai_quality.toFixed(1)}/10`}
            >
              <Sparkles className="h-3 w-3" />
              {clip.ai_quality.toFixed(1)}
            </span>
          )}
        </div>

        {/* caption */}
        {clip.ai_caption && (
          <p
            className="line-clamp-2 text-[12px] leading-snug text-muted-foreground"
            title={clip.ai_caption}
          >
            {clip.ai_caption}
          </p>
        )}

        {/* compact meta pills */}
        {(() => {
          const hasTrim =
            clip.ai_in_sec != null &&
            clip.ai_out_sec != null &&
            clip.ai_out_sec - clip.ai_in_sec < clip.duration_sec - 0.4
          const showRow =
            hasTrim || (clip.word_count ?? 0) > 0 || clip.sequence_position != null
          if (!showRow) return null
          return (
            <div className="flex flex-wrap items-center gap-1">
              {(clip.word_count ?? 0) > 0 && (
                <HudPill title={`${clip.word_count} words transcribed`}>
                  <Mic className="h-3 w-3" />
                  {clip.word_count}w
                </HudPill>
              )}
              {hasTrim && (
                <HudPill
                  tone="success"
                  title={`Trim ${clip.ai_in_sec!.toFixed(1)}s – ${clip.ai_out_sec!.toFixed(1)}s`}
                >
                  <Scissors className="h-3 w-3" />
                  {clip.ai_in_sec!.toFixed(1)}–{clip.ai_out_sec!.toFixed(1)}s
                </HudPill>
              )}
              {clip.sequence_position != null && (
                <HudPill title={`Position #${clip.sequence_position}`}>
                  <MoveVertical className="h-3 w-3" />
                  #{clip.sequence_position}
                </HudPill>
              )}
            </div>
          )
        })()}

        {/* segment select */}
        <select
          className="h-8 rounded-md border border-border bg-input px-2 text-[12.5px] outline-none transition-colors focus:border-primary"
          style={{ borderLeftWidth: 3, borderLeftColor: segColor }}
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

        {/* friendly score row */}
        <div className="grid grid-cols-3 gap-2">
          <Score label="Steady" score={1 - clip.shake_score} bad={isShaky} />
          <Score label="Sharp" score={1 - clip.blur_score} bad={isBlurry} />
          <Score
            label="Light"
            score={1 - Math.abs(clip.exposure_score - 0.5) * 2}
            bad={exposureBad}
          />
        </div>

        {/* Why? */}
        {(clip.ai_rationale ||
          (clip.ai_reasoning && clip.ai_reasoning.length > 0)) && (
          <div className="rounded-md border border-border/60 bg-muted/25">
            <button
              type="button"
              className="flex w-full items-center justify-between gap-1 px-2.5 py-1.5 text-[11.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation()
                setWhyOpen((v) => !v)
              }}
              title="What the AI thought"
            >
              <span className="flex items-center gap-1.5">
                <Brain className="h-3.5 w-3.5" />
                Why this clip?
              </span>
              <ChevronDown
                className={cn(
                  'h-3.5 w-3.5 transition-transform',
                  whyOpen && 'rotate-180',
                )}
              />
            </button>
            {whyOpen && (
              <div className="space-y-2 border-t border-border/60 px-2.5 py-2 text-[11.5px] leading-snug">
                {clip.ai_rationale ? (
                  <p className="text-foreground/90">{clip.ai_rationale}</p>
                ) : (
                  <p className="italic text-muted-foreground/70">
                    No editor's note from the AI for this clip.
                  </p>
                )}
                {clip.ai_reasoning && clip.ai_reasoning.length > 0 && (
                  <details className="text-[10.5px] text-muted-foreground">
                    <summary className="cursor-pointer select-none hover:text-foreground">
                      Technical trace ({clip.ai_reasoning.length})
                    </summary>
                    <ul className="mt-1 space-y-1">
                      {clip.ai_reasoning.map((line, i) => (
                        <li key={i} className="flex gap-1.5">
                          <span className="select-none text-muted-foreground/60">·</span>
                          <span className="flex-1">{line}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </div>
        )}

        {/* actions */}
        <div className="grid grid-cols-3 gap-1.5">
          <ActionBtn
            tone="success"
            active={clip.approved === true}
            onClick={(e) => {
              e.stopPropagation()
              handleApprove()
            }}
          >
            <Check className="h-3.5 w-3.5" />
            Approve
          </ActionBtn>
          <ActionBtn
            tone="warning"
            active={clip.near_miss}
            onClick={(e) => {
              e.stopPropagation()
              handleNearMiss()
            }}
            title="Near miss — almost good"
          >
            ≈ Near
          </ActionBtn>
          <ActionBtn
            tone="destructive"
            active={clip.approved === false}
            onClick={(e) => {
              e.stopPropagation()
              handleReject()
            }}
          >
            <X className="h-3.5 w-3.5" />
            Reject
          </ActionBtn>
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

function Score({
  label,
  score,
  bad,
}: {
  label: string
  score: number
  bad: boolean
}) {
  const pct = Math.max(0, Math.min(1, score)) * 100
  return (
    <div
      className={cn(
        'rounded-md border border-border/60 bg-muted/30 px-2 py-1.5',
        bad && 'border-warning/40 bg-warning/5',
      )}
      title={`${label} score: ${pct.toFixed(0)}%`}
    >
      <div className="mb-1 flex items-center justify-between text-[10.5px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums font-medium">{Math.round(pct)}</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            'h-full transition-all',
            bad ? 'bg-warning' : 'bg-gradient-to-r from-success/80 via-success to-primary',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

function ActionBtn({
  children,
  active,
  tone,
  onClick,
  title,
}: {
  children: React.ReactNode
  active?: boolean
  tone: 'success' | 'warning' | 'destructive'
  onClick: (e: React.MouseEvent) => void
  title?: string
}) {
  const toneActive = {
    success: 'border-success bg-success text-success-foreground',
    warning: 'border-warning bg-warning text-background',
    destructive: 'border-destructive bg-destructive text-destructive-foreground',
  }[tone]
  const toneIdle = {
    success: 'hover:border-success/60 hover:bg-success/8 hover:text-[var(--success)]',
    warning: 'hover:border-warning/60 hover:bg-warning/8 hover:text-[var(--warning)]',
    destructive: 'hover:border-destructive/60 hover:bg-destructive/8 hover:text-destructive',
  }[tone]
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'inline-flex items-center justify-center gap-1 rounded-md border px-2 py-1.5 text-[12px] font-medium transition-colors',
        active
          ? toneActive
          : `border-border-strong bg-transparent text-muted-foreground ${toneIdle}`,
      )}
    >
      {children}
    </button>
  )
}
