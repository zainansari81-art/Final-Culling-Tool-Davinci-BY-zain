import { useState } from 'react'
import { Check, Download, FileVideo, Loader2 } from 'lucide-react'
import { api } from '../api'
import type { AnalysisJob } from '../types'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

function defaultFcpxmlPath(): string {
  const date = new Date().toISOString().slice(0, 10)
  const home =
    (globalThis as unknown as { process?: { env?: Record<string, string> } })
      ?.process?.env?.HOME ?? '~'
  return `${home}/Desktop/wedding-${date}.fcpxml`
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const detail = (err as any)?.response?.data?.detail
      const msg = detail ?? (err instanceof Error ? err.message : 'Export failed')
      setErrorMsg(String(msg))
      setStatus('error')
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        {status === 'success' ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-success/15 text-success">
              <Check className="h-6 w-6" />
            </div>
            <div>
              <h3 className="text-base font-semibold">
                {exportType === 'resolve'
                  ? 'Project created in DaVinci Resolve'
                  : 'FCPXML exported'}
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {exportType === 'resolve'
                  ? 'Open DaVinci Resolve to find your new project.'
                  : 'Import the .fcpxml file in Final Cut Pro.'}
              </p>
            </div>
            <Button onClick={onClose} className="mt-2 w-full">
              Done
            </Button>
          </div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Export project</DialogTitle>
              <DialogDescription>
                Send approved clips to your editor.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2">
              <div className="grid gap-2">
                <Label htmlFor="project-name">Project name</Label>
                <Input
                  id="project-name"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  disabled={status === 'loading'}
                  autoFocus
                />
              </div>

              <div className="grid gap-2">
                <Label>Format</Label>
                <div className="grid grid-cols-2 gap-2">
                  <FormatChoice
                    selected={exportType === 'resolve'}
                    disabled={status === 'loading'}
                    onClick={() => setExportType('resolve')}
                    title="DaVinci Resolve"
                    sub="Direct to a new project"
                  />
                  <FormatChoice
                    selected={exportType === 'fcpxml'}
                    disabled={status === 'loading'}
                    onClick={() => setExportType('fcpxml')}
                    title="FCPXML"
                    sub="For any NLE"
                  />
                </div>
              </div>

              {status === 'error' && (
                <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {errorMsg}
                </p>
              )}
            </div>

            <DialogFooter>
              <Button
                variant="ghost"
                onClick={onClose}
                disabled={status === 'loading'}
              >
                Cancel
              </Button>
              <Button
                onClick={handleExport}
                disabled={status === 'loading' || !projectName.trim()}
              >
                {status === 'loading' ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Exporting…
                  </>
                ) : (
                  <>
                    <Download className="h-4 w-4" />
                    Export
                  </>
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function FormatChoice({
  selected,
  disabled,
  onClick,
  title,
  sub,
}: {
  selected: boolean
  disabled: boolean
  onClick: () => void
  title: string
  sub: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex flex-col items-start gap-1 rounded-lg border bg-card px-3 py-2.5 text-left transition-colors disabled:opacity-50',
        selected
          ? 'border-foreground/40 bg-accent'
          : 'border-border/70 hover:border-border hover:bg-accent/50',
      )}
    >
      <div className="flex w-full items-center justify-between">
        <span className="text-sm font-medium">{title}</span>
        <FileVideo
          className={cn(
            'h-4 w-4',
            selected ? 'text-foreground' : 'text-muted-foreground',
          )}
        />
      </div>
      <span className="text-xs text-muted-foreground">{sub}</span>
    </button>
  )
}
