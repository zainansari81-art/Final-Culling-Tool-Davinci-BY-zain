import { useEffect, useRef, useState } from 'react'
import { Terminal } from 'lucide-react'
import { api } from '../api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

interface Props {
  jobId: string
  active: boolean
  className?: string
}

const LEVEL_COLORS: Record<string, string> = {
  E: 'text-destructive',
  W: 'text-warning',
  I: 'text-muted-foreground',
  D: 'text-muted-foreground/70',
}

export default function LogPane({ jobId, active, className }: Props) {
  const [lines, setLines] = useState<string[]>([])
  const [autoScroll, setAutoScroll] = useState(true)
  const sinceRef = useRef(0)
  const viewportRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false

    const tick = async () => {
      try {
        const data = await api.getLogs(jobId, sinceRef.current)
        if (cancelled) return
        if (data.lines.length > 0) {
          sinceRef.current = data.total
          setLines((prev) => [...prev, ...data.lines])
        }
      } catch {
        // ignore — backend may briefly error during HMR
      }
    }

    tick() // immediate fetch
    if (!active) return
    const t = setInterval(tick, 1500)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [jobId, active])

  useEffect(() => {
    if (!autoScroll) return
    const vp = viewportRef.current?.querySelector(
      '[data-slot="scroll-area-viewport"]',
    ) as HTMLElement | null
    if (vp) vp.scrollTop = vp.scrollHeight
  }, [lines, autoScroll])

  return (
    <div className={cn('overflow-hidden rounded-lg border border-border/70 bg-muted/30', className)}>
      <div className="flex items-center justify-between gap-2 border-b border-border/70 px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-medium">
          <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
          <span>Logs</span>
          <Badge variant="secondary" className="h-4 px-1.5 text-[10px] tabular-nums">
            {lines.length}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setAutoScroll((v) => !v)}
            className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
          >
            {autoScroll ? 'Auto-scroll on' : 'Auto-scroll off'}
          </Button>
        </div>
      </div>
      <ScrollArea
        ref={viewportRef}
        className="h-56 font-mono"
      >
        <div className="px-3 py-2 text-[11px] leading-relaxed">
          {lines.length === 0 && (
            <div className="text-muted-foreground/60">Waiting for output…</div>
          )}
          {lines.map((line, i) => {
            const m = /^(\S+)\s+([EWID])\s+(.*)$/.exec(line)
            if (!m) {
              return (
                <div key={i} className="text-muted-foreground">
                  {line}
                </div>
              )
            }
            const [, ts, level, msg] = m
            return (
              <div key={i} className="flex gap-2">
                <span className="shrink-0 text-muted-foreground/60">{ts}</span>
                <span
                  className={cn(
                    'shrink-0 font-semibold',
                    LEVEL_COLORS[level] ?? 'text-muted-foreground',
                  )}
                >
                  {level}
                </span>
                <span className="break-all text-foreground/90">{msg}</span>
              </div>
            )
          })}
        </div>
      </ScrollArea>
    </div>
  )
}
