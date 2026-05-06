import { useEffect, useRef } from 'react'
import { Check, Quote, Sparkles, X } from 'lucide-react'
import { api } from '../api'
import type { ClipResult } from '../types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  jobId: string
  clip: ClipResult | null
  onApprove?: () => void
  onReject?: () => void
}

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function VideoPreview({
  open,
  onOpenChange,
  jobId,
  clip,
  onApprove,
  onReject,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    if (open && videoRef.current) {
      // If AI suggested an in-point, jump there; else start at 0
      const start = clip?.ai_in_sec ?? 0
      videoRef.current.currentTime = start
      videoRef.current.play().catch(() => {})
    }
  }, [open, clip?.id, clip?.ai_in_sec])

  if (!clip) return null

  const isShaky = clip.shake_score > 0.15
  const isBlurry = clip.blur_score > 0.7
  const exposureBad = clip.exposure_score < 0.2 || clip.exposure_score > 0.9

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle
            className="truncate text-base tracking-tight"
            title={clip.filename}
          >
            {clip.filename}
          </DialogTitle>
          <DialogDescription>
            {fmtDuration(clip.duration_sec)} · {clip.suggested_segment}
          </DialogDescription>
        </DialogHeader>

        <div className="relative bg-black">
          <video
            ref={videoRef}
            key={clip.id}
            src={api.clipStreamUrl(jobId, clip.id)}
            controls
            playsInline
            className="aspect-video w-full"
          />
          {clip.ai_in_sec != null && clip.ai_out_sec != null && clip.duration_sec > 0 && (
            <AiInOutBar
              inSec={clip.ai_in_sec}
              outSec={clip.ai_out_sec}
              total={clip.duration_sec}
            />
          )}
        </div>

        {(clip.ai_caption || clip.transcript || clip.ai_quality != null) && (
          <div className="space-y-2 border-b border-border/70 px-5 py-3 text-sm">
            {clip.ai_caption && (
              <div className="flex items-start gap-2">
                <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <p className="leading-relaxed">{clip.ai_caption}</p>
                {clip.ai_quality != null && (
                  <Badge variant="secondary" className="shrink-0 gap-1 text-[11px]">
                    {clip.ai_quality.toFixed(1)}/10
                  </Badge>
                )}
              </div>
            )}
            {clip.transcript && (
              <div className="flex items-start gap-2 text-xs text-muted-foreground">
                <Quote className="mt-0.5 h-3 w-3 shrink-0" />
                <p className="line-clamp-3 leading-relaxed italic">
                  {clip.transcript}
                </p>
              </div>
            )}
            {clip.ai_in_sec != null && clip.ai_out_sec != null && (
              <p className="text-[11px] tabular-nums text-muted-foreground">
                AI suggests keep {fmtDuration(clip.ai_in_sec)} → {fmtDuration(clip.ai_out_sec)}
              </p>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 px-5 py-3">
          {isShaky && (
            <Badge className="gap-1 border-0 bg-destructive/90 text-destructive-foreground">
              Shaky · {Math.round(clip.shake_score * 100)}
            </Badge>
          )}
          {isBlurry && (
            <Badge className="gap-1 border-0 bg-warning/90 text-background">
              Blurry · {Math.round(clip.blur_score * 100)}
            </Badge>
          )}
          {clip.is_duplicate && (
            <Badge className="gap-1 border-0 bg-info/90 text-background">
              Duplicate
            </Badge>
          )}
          {exposureBad && (
            <Badge className="gap-1 border-0 bg-warning/90 text-background">
              Exposure
            </Badge>
          )}
          {!isShaky && !isBlurry && !exposureBad && !clip.is_duplicate && (
            <Badge variant="secondary" className="bg-success/15 text-success">
              Looks clean
            </Badge>
          )}

          <div className="flex flex-1 justify-end gap-2">
            <Button
              variant={clip.approved === false ? 'destructive' : 'outline'}
              size="sm"
              onClick={() => {
                onReject?.()
              }}
              className={cn(clip.approved === false && 'ring-2 ring-destructive/40')}
            >
              <X className="h-4 w-4" />
              Reject
            </Button>
            <Button
              variant={clip.approved === true ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                onApprove?.()
              }}
              className={cn(
                clip.approved === true &&
                  'bg-success text-success-foreground hover:bg-success/90',
              )}
            >
              <Check className="h-4 w-4" />
              Approve
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function AiInOutBar({
  inSec,
  outSec,
  total,
}: {
  inSec: number
  outSec: number
  total: number
}) {
  const left = Math.max(0, Math.min(100, (inSec / total) * 100))
  const right = Math.max(left, Math.min(100, (outSec / total) * 100))
  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 h-1.5 bg-black/40"
      title={`AI suggested keep range`}
    >
      <div
        className="absolute top-0 bottom-0 bg-success/80"
        style={{ left: `${left}%`, width: `${right - left}%` }}
      />
    </div>
  )
}
