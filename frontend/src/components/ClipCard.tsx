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
import { HudFrame, HudPill } from './Hud'
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

  const state =
    clip.approved === true
      ? 'done'
      : isSelected
        ? 'active'
        : 'idle'

  return (
    <div ref={cardRef} onClick={onSelect}>
      <HudFrame
        state={state}
        className={cn(
          'group flex flex-col cursor-pointer',
          clip.approved === false && 'opacity-50',
        )}
      >
        {/* TITLEBAR: filename + quality + tag */}
        <div className="hud-titlebar gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span
              aria-hidden
              className="h-2.5 w-2.5 shrink-0"
              style={{ background: segColor }}
            />
            <span
              className="min-w-0 flex-1 truncate font-mono text-[10.5px] normal-case tracking-[0.04em] text-foreground/85"
              title={clip.filename}
            >
              {clip.filename}
            </span>
          </div>
          {clip.ai_quality != null && (
            <span
              className="flex items-center gap-1 border border-primary/40 bg-primary/10 px-1 py-0.5 font-mono text-[9px] tabular-nums text-[var(--primary)]"
              title={`AI quality ${clip.ai_quality.toFixed(1)}/10`}
            >
              <Sparkles className="h-2 w-2" />
              {clip.ai_quality.toFixed(1)}
            </span>
          )}
        </div>

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
            <div className="hud-hatch absolute inset-0 flex items-center justify-center font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              NO PREVIEW
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
          {/* corner brackets on thumbnail */}
          <span aria-hidden className="pointer-events-none absolute left-1 top-1 h-2 w-2 border-l border-t border-white/40" />
          <span aria-hidden className="pointer-events-none absolute right-1 top-1 h-2 w-2 border-r border-t border-white/40" />
          <span aria-hidden className="pointer-events-none absolute left-1 bottom-1 h-2 w-2 border-l border-b border-white/40" />
          <span aria-hidden className="pointer-events-none absolute right-1 bottom-1 h-2 w-2 border-r border-b border-white/40" />

          {/* play overlay */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover/thumb:opacity-100">
            <div className="flex h-9 w-9 items-center justify-center border border-primary bg-primary/95 text-primary-foreground shadow-[0_0_16px_-2px_color-mix(in_srgb,var(--primary)_70%,transparent)]">
              <Play className="ml-0.5 h-3.5 w-3.5 fill-current" />
            </div>
          </div>

          {/* status badges */}
          <div className="absolute left-1.5 top-1.5 flex flex-wrap gap-1">
            {isShaky && (
              <HudPill tone="destructive">
                <Wind className="h-2 w-2" />SHK
              </HudPill>
            )}
            {isBlurry && (
              <HudPill tone="warning">BLR</HudPill>
            )}
            {clip.is_duplicate && (
              <HudPill tone="primary">
                <Copy className="h-2 w-2" />DUP
              </HudPill>
            )}
            {exposureBad && (
              <HudPill tone="warning">
                <Eye className="h-2 w-2" />EXP
              </HudPill>
            )}
          </div>

          {/* timecode HUD */}
          <div className="absolute bottom-1.5 right-1.5 border border-white/10 bg-black/75 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-foreground backdrop-blur">
            {fmtDuration(clip.duration_sec)}
          </div>
          {clip.analysis_sec != null && (
            <div
              className="absolute bottom-1.5 left-1.5 border border-white/10 bg-black/75 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-muted-foreground backdrop-blur"
              title={`Analysis ${clip.analysis_sec.toFixed(2)}s`}
            >
              ⏱{clip.analysis_sec.toFixed(1)}s
            </div>
          )}
          {clip.approved === true && (
            <div className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center bg-success text-success-foreground">
              <Check className="h-3 w-3" />
            </div>
          )}
          {clip.rank_in_group === 1 && clip.approved !== true && (
            <div
              className="absolute right-1.5 top-1.5 flex items-center gap-1 border border-primary/60 bg-black/80 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--primary)]"
              title="Top take in segment"
            >
              ★ TOP
            </div>
          )}
        </button>

        {/* META row */}
        <div className="border-t border-border px-2.5 py-2">
          {clip.ai_caption && (
            <p
              className="mb-2 line-clamp-2 text-[11px] leading-snug text-muted-foreground"
              title={clip.ai_caption}
            >
              {clip.ai_caption}
            </p>
          )}

          {(() => {
            const hasTrim =
              clip.ai_in_sec != null &&
              clip.ai_out_sec != null &&
              clip.ai_out_sec - clip.ai_in_sec < clip.duration_sec - 0.4
            const showRow =
              hasTrim || (clip.word_count ?? 0) > 0 || clip.sequence_position != null
            if (!showRow) return null
            return (
              <div className="mb-2 flex flex-wrap items-center gap-1">
                {(clip.word_count ?? 0) > 0 && (
                  <HudPill title={`${clip.word_count} words`}>
                    <Mic className="h-2 w-2" />
                    {clip.word_count}W
                  </HudPill>
                )}
                {hasTrim && (
                  <HudPill
                    tone="success"
                    title={`Trim ${clip.ai_in_sec!.toFixed(1)}s – ${clip.ai_out_sec!.toFixed(1)}s`}
                  >
                    <Scissors className="h-2 w-2" />
                    {clip.ai_in_sec!.toFixed(1)}–{clip.ai_out_sec!.toFixed(1)}
                  </HudPill>
                )}
                {clip.sequence_position != null && (
                  <HudPill title={`Position #${clip.sequence_position}`}>
                    <MoveVertical className="h-2 w-2" />
                    #{clip.sequence_position}
                  </HudPill>
                )}
              </div>
            )
          })()}

          {/* segment select */}
          <select
            className="mb-2 h-7 w-full border border-border bg-input px-2 font-mono text-[10.5px] uppercase tracking-[0.08em] outline-none transition-colors focus:border-primary"
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

          {/* HUD score readouts */}
          <div className="mb-2 grid grid-cols-3 gap-1.5">
            <Scope label="SHK" score={clip.shake_score} bad={isShaky} />
            <Scope label="BLR" score={clip.blur_score} bad={isBlurry} />
            <Scope
              label="EXP"
              score={1 - clip.exposure_score}
              bad={exposureBad}
              invert
            />
          </div>

          {/* Why? */}
          {(clip.ai_rationale ||
            (clip.ai_reasoning && clip.ai_reasoning.length > 0)) && (
            <div className="mb-2 border border-border/60 bg-muted/20">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-1 px-2 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation()
                  setWhyOpen((v) => !v)
                }}
              >
                <span className="flex items-center gap-1">
                  <Brain className="h-2.5 w-2.5" />
                  // RATIONALE
                </span>
                <ChevronDown
                  className={cn(
                    'h-3 w-3 transition-transform',
                    whyOpen && 'rotate-180',
                  )}
                />
              </button>
              {whyOpen && (
                <div className="space-y-2 border-t border-border/60 px-2 py-2 text-[11px] leading-snug">
                  {clip.ai_rationale ? (
                    <p className="text-foreground/90">{clip.ai_rationale}</p>
                  ) : (
                    <p className="italic text-muted-foreground/70">
                      No editor's note from the AI.
                    </p>
                  )}
                  {clip.ai_reasoning && clip.ai_reasoning.length > 0 && (
                    <details className="text-[10px] text-muted-foreground">
                      <summary className="cursor-pointer select-none font-mono uppercase tracking-wider hover:text-foreground">
                        TRACE ({clip.ai_reasoning.length})
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

          {/* Actions */}
          <div className="grid grid-cols-3 gap-1">
            <ActionBtn
              tone="success"
              active={clip.approved === true}
              onClick={(e) => {
                e.stopPropagation()
                handleApprove()
              }}
            >
              <Check className="h-3 w-3" />
              KEEP
            </ActionBtn>
            <ActionBtn
              tone="warning"
              active={clip.near_miss}
              onClick={(e) => {
                e.stopPropagation()
                handleNearMiss()
              }}
              title="Near miss"
            >
              ≈ NEAR
            </ActionBtn>
            <ActionBtn
              tone="destructive"
              active={clip.approved === false}
              onClick={(e) => {
                e.stopPropagation()
                handleReject()
              }}
            >
              <X className="h-3 w-3" />
              CUT
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
      </HudFrame>
    </div>
  )
}

function Scope({
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
        'flex flex-col gap-1 border border-border/60 bg-rail px-1.5 py-1 font-mono',
        bad && 'border-warning/40',
      )}
      title={`${label}: ${score.toFixed(2)}`}
    >
      <div className="flex items-center justify-between text-[9px] uppercase tracking-[0.14em]">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums font-medium text-foreground">
          {Math.round(pct)}
        </span>
      </div>
      <div className="h-[3px] overflow-hidden bg-muted">
        <div
          className={cn(
            'h-full transition-all',
            bad
              ? 'bg-warning'
              : 'bg-gradient-to-r from-success/80 via-success to-primary',
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
    success: 'hover:border-success hover:text-[var(--success)]',
    warning: 'hover:border-warning hover:text-[var(--warning)]',
    destructive: 'hover:border-destructive hover:text-destructive',
  }[tone]
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'inline-flex items-center justify-center gap-1 border px-2 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors',
        active
          ? toneActive
          : `border-border-strong bg-transparent text-muted-foreground ${toneIdle}`,
      )}
    >
      {children}
    </button>
  )
}
