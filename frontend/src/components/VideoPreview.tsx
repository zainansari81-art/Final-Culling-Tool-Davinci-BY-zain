import { useEffect, useRef } from 'react'
import { Check, X } from 'lucide-react'
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
      videoRef.current.currentTime = 0
      videoRef.current.play().catch(() => {})
    }
  }, [open, clip?.id])

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

        <div className="bg-black">
          <video
            ref={videoRef}
            key={clip.id}
            src={api.clipStreamUrl(jobId, clip.id)}
            controls
            playsInline
            className="aspect-video w-full"
          />
        </div>

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
