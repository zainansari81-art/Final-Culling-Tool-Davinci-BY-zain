import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  ChevronRight,
  Film,
  Folder,
  HardDrive,
  Loader2,
} from 'lucide-react'
import { api, type FsEntry } from '../api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

interface FolderBrowserProps {
  onSelectionChange: (
    folderPath: string,
    includedFiles: string[] | null,
    selectedCount: number,
  ) => void
}

const fmtSize = (bytes: number): string => {
  if (!bytes) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

const breadcrumbsFromPath = (p: string): { label: string; path: string }[] => {
  if (p === '/') return [{ label: '/', path: '/' }]
  const parts = p.split('/').filter(Boolean)
  const crumbs = [{ label: '/', path: '/' }]
  let acc = ''
  for (const part of parts) {
    acc += `/${part}`
    crumbs.push({ label: part, path: acc })
  }
  return crumbs
}

export default function FolderBrowser({ onSelectionChange }: FolderBrowserProps) {
  const [currentPath, setCurrentPath] = useState<string>('')
  const [parent, setParent] = useState<string | null>(null)
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [videoCount, setVideoCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [excluded, setExcluded] = useState<Set<string>>(new Set())

  const videos = useMemo(() => entries.filter((e) => e.is_video), [entries])
  const folders = useMemo(() => entries.filter((e) => e.is_dir), [entries])

  const loadPath = async (path?: string) => {
    setLoading(true)
    setError('')
    try {
      const data = await api.fsList(path)
      setCurrentPath(data.path)
      setParent(data.parent)
      setEntries(data.entries)
      setVideoCount(data.video_count)
      setExcluded(new Set())
    } catch (err: unknown) {
      const msg =
        err && typeof err === 'object' && 'response' in err
          ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ((err as any).response?.data?.detail ?? 'Failed to load folder')
          : err instanceof Error
            ? err.message
            : 'Failed to load folder'
      setError(String(msg))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadPath()
  }, [])

  // Bubble selection up to parent
  useEffect(() => {
    const selectedCount = videos.length - excluded.size
    if (videos.length === 0 || selectedCount === 0) {
      onSelectionChange(currentPath, null, 0)
      return
    }
    const all = excluded.size === 0
    const included = all
      ? null
      : videos.filter((v) => !excluded.has(v.path)).map((v) => v.path)
    onSelectionChange(currentPath, included, selectedCount)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath, videos, excluded])

  const toggleExcluded = (path: string) => {
    setExcluded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const allOff = videos.length > 0 && videos.every((v) => excluded.has(v.path))
  const toggleAll = () => {
    setExcluded(allOff ? new Set() : new Set(videos.map((v) => v.path)))
  }

  const crumbs = breadcrumbsFromPath(currentPath || '/')
  const isVolumes = currentPath === '/Volumes'
  const selectedCount = videos.length - excluded.size

  return (
    <div className="flex flex-col">
      {/* Breadcrumb / nav row */}
      <div className="flex items-center gap-3 px-4 py-3">
        <Button
          variant="ghost"
          size="icon"
          disabled={!parent || loading}
          onClick={() => parent && loadPath(parent)}
          aria-label="Up one folder"
          className="h-8 w-8 shrink-0"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex flex-1 items-center gap-1 overflow-x-auto whitespace-nowrap text-sm">
          {crumbs.map((c, i) => (
            <span key={c.path} className="flex items-center gap-1">
              {i > 0 && (
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60" />
              )}
              <button
                type="button"
                className={cn(
                  'rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50',
                  i === crumbs.length - 1 && 'text-foreground',
                )}
                onClick={() => loadPath(c.path)}
                disabled={loading}
              >
                {c.label}
              </button>
            </span>
          ))}
        </div>
        {videoCount > 0 && (
          <Badge variant="secondary" className="shrink-0 gap-1.5">
            <Film className="h-3 w-3" />
            {videoCount} clip{videoCount === 1 ? '' : 's'}
          </Badge>
        )}
      </div>

      <Separator />

      {/* Two panes */}
      <div className="grid grid-cols-2 h-[420px] overflow-hidden">
        <div className="flex min-h-0 flex-col border-r border-border/70">
          <div className="px-4 pt-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Folders
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-0.5 px-2 pb-3">
              {loading && (
                <div className="flex items-center gap-2 px-3 py-6 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading…
                </div>
              )}
              {!loading && error && (
                <div className="px-3 py-6 text-sm text-destructive">{error}</div>
              )}
              {!loading && !error && folders.length === 0 && (
                <div className="px-3 py-6 text-sm text-muted-foreground">
                  No subfolders here.
                </div>
              )}
              {!loading &&
                folders.map((f) => {
                  const Icon = isVolumes ? HardDrive : Folder
                  return (
                    <button
                      key={f.path}
                      type="button"
                      onClick={() => loadPath(f.path)}
                      className="group flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                    >
                      <Icon className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
                      <span className="flex-1 truncate">{f.name}</span>
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                    </button>
                  )
                })}
            </div>
          </ScrollArea>
        </div>

        <div className="flex min-h-0 flex-col">
          <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-2">
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Clips · {videos.length > 0 ? `${selectedCount} of ${videos.length}` : 'none'}
            </div>
            {videos.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={toggleAll}
                className="h-auto px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
              >
                {allOff ? 'Select all' : 'Deselect all'}
              </Button>
            )}
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-0.5 px-2 pb-3">
              {!loading && videos.length === 0 && (
                <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
                  <Film className="h-6 w-6 text-muted-foreground/40" />
                  <p className="text-sm text-muted-foreground">
                    No video clips in this folder.
                  </p>
                </div>
              )}
              {videos.map((v) => {
                const checked = !excluded.has(v.path)
                return (
                  <label
                    key={v.path}
                    className={cn(
                      'flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 transition-colors hover:bg-accent',
                      !checked && 'opacity-55',
                    )}
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => toggleExcluded(v.path)}
                    />
                    <Film className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="flex-1 truncate text-sm">{v.name}</span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {fmtSize(v.size_bytes)}
                    </span>
                  </label>
                )
              })}
            </div>
          </ScrollArea>
        </div>
      </div>
    </div>
  )
}
