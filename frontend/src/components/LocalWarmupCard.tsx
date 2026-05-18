import { useEffect, useState } from 'react'
import { Download, CheckCircle2, Loader2, AlertCircle } from 'lucide-react'
import { api, type LocalModelStatus } from '../api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import LogPane from './LogPane'

export default function LocalWarmupCard() {
  const [status, setStatus] = useState<LocalModelStatus | null>(null)
  const [starting, setStarting] = useState(false)

  const refresh = async () => {
    try {
      const s = await api.localStatus()
      setStatus(s)
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 1500)
    return () => clearInterval(t)
  }, [])

  const handleStart = async () => {
    setStarting(true)
    try {
      await api.startWarmup()
      await refresh()
    } finally {
      setStarting(false)
    }
  }

  if (!status) return null

  const fullyReady = status.vlm_cached && status.clip_cached && status.done
  const running = status.running

  return (
    <div className="mb-6 overflow-hidden rounded-lg border border-border/70 bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border/70 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          {fullyReady ? (
            <CheckCircle2 className="h-4 w-4 text-success" />
          ) : running ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : status.error ? (
            <AlertCircle className="h-4 w-4 text-destructive" />
          ) : (
            <Download className="h-4 w-4 text-muted-foreground" />
          )}
          Local AI models
          <Badge
            variant={fullyReady ? 'default' : 'outline'}
            className="font-normal"
          >
            {fullyReady
              ? 'Ready'
              : running
                ? 'Downloading…'
                : status.error
                  ? 'Error'
                  : status.vlm_cached
                    ? 'VLM cached'
                    : 'Not downloaded'}
          </Badge>
        </div>
        <Button
          size="sm"
          variant={fullyReady ? 'outline' : 'default'}
          onClick={handleStart}
          disabled={starting || running}
        >
          {running
            ? 'Downloading…'
            : fullyReady
              ? 'Re-warm'
              : starting
                ? 'Starting…'
                : 'Download models'}
        </Button>
      </div>
      <div className="px-4 py-3 text-xs text-muted-foreground">
        <div className="grid gap-1 sm:grid-cols-2">
          <div>
            <span className="text-foreground/80">VLM:</span> {status.vlm_model}{' '}
            {status.vlm_cached ? (
              <span className="text-success">(cached)</span>
            ) : (
              <span className="text-muted-foreground/70">(~1.5 GB)</span>
            )}
          </div>
          <div>
            <span className="text-foreground/80">CLIP:</span> {status.clip_model}{' '}
            {status.clip_cached ? (
              <span className="text-success">(loaded)</span>
            ) : (
              <span className="text-muted-foreground/70">(~600 MB)</span>
            )}
          </div>
        </div>
        {status.error && (
          <p className="mt-2 text-destructive">{status.error}</p>
        )}
      </div>
      {(running || status.done || status.error) && (
        <LogPane
          active={running}
          fetcher={api.warmupLogs}
          className="rounded-none border-t border-border/70"
        />
      )}
    </div>
  )
}
