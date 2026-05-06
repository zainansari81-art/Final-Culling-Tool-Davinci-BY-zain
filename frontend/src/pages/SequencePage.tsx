import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Clapperboard,
  Loader2,
  Mic,
  MicOff,
  Pause,
  Play,
  Save,
  ScissorsLineDashed,
} from 'lucide-react'
import {
  api,
  BASE_URL,
  type SequenceItem,
  type SequenceResponse,
  type SequenceWord,
} from '../api'
import BackendError from '../components/BackendError'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Slider } from '@/components/ui/slider'
import { cn } from '@/lib/utils'

const SEGMENT_ORDER = [
  'Bride Getting Ready',
  'Groomsmen Getting Ready',
  'Groomsmen',
  'First Look',
  'Ceremony',
  'Cocktail Hour',
  'Cocktail',
  'Reception / First Dance',
  'First Dance',
  'Toasts',
  'Drone / Aerial',
  'Drone',
  'Ambiance / BTS',
  'Ambiance',
  'Backup',
]

function fmtTime(sec: number): string {
  if (!isFinite(sec)) return '0:00.0'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  const ms = Math.floor((sec - Math.floor(sec)) * 10)
  return `${m}:${s.toString().padStart(2, '0')}.${ms}`
}

export default function SequencePage() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<SequenceResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notFound, setNotFound] = useState(false)
  const [backendDown, setBackendDown] = useState(false)
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({})
  const [savingSpeakers, setSavingSpeakers] = useState(false)
  const [savedSpeakers, setSavedSpeakers] = useState(false)
  const [expandedClipId, setExpandedClipId] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    setError('')
    try {
      const res = await api.getSequence(id)
      setData(res)
      setSpeakerNames(res.speaker_names || {})
      setBackendDown(false)
      setNotFound(false)
    } catch (err: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const status = (err as any)?.response?.status
      if (status === 404) {
        setNotFound(true)
      } else if (status === undefined) {
        setBackendDown(true)
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setError((err as any)?.response?.data?.detail ?? 'Failed to load')
      }
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  const grouped = useMemo(() => {
    if (!data) return [] as { segment: string; items: SequenceItem[] }[]
    const map = new Map<string, SequenceItem[]>()
    for (const it of data.items) {
      const key = it.segment || 'Backup'
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(it)
    }
    const sortedKeys = Array.from(map.keys()).sort((a, b) => {
      const ai = SEGMENT_ORDER.indexOf(a)
      const bi = SEGMENT_ORDER.indexOf(b)
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
    })
    return sortedKeys.map((segment) => ({
      segment,
      items: map.get(segment)!,
    }))
  }, [data])

  const stats = useMemo(() => {
    if (!data) return { total: 0, aroll: 0, broll: 0, avgConf: 0, words: 0 }
    let aroll = 0, broll = 0, words = 0, confSum = 0, confN = 0
    for (const it of data.items) {
      if (it.clip_type === 'AROLL') aroll++
      else broll++
      words += it.words.length
      if (it.placement_confidence != null) {
        confSum += it.placement_confidence
        confN++
      }
    }
    return {
      total: data.items.length,
      aroll,
      broll,
      words,
      avgConf: confN > 0 ? Math.round(confSum / confN) : 0,
    }
  }, [data])

  const reorder = async (clip: SequenceItem, dir: -1 | 1) => {
    if (!id) return
    const seg = grouped.find((g) => g.items.some((it) => it.clip_id === clip.clip_id))
    if (!seg) return
    const idx = seg.items.findIndex((it) => it.clip_id === clip.clip_id)
    const swapWith = seg.items[idx + dir]
    if (!swapWith) return

    const a = clip.sequence_position ?? idx + 1
    const b = swapWith.sequence_position ?? idx + 1 + dir

    try {
      await Promise.all([
        api.patchClip(id, clip.clip_id, { sequence_position: b }),
        api.patchClip(id, swapWith.clip_id, { sequence_position: a }),
      ])
      await load()
    } catch (err) {
      console.error('reorder failed', err)
    }
  }

  const saveSpeakers = async () => {
    if (!id) return
    setSavingSpeakers(true)
    try {
      await api.putSpeakers(id, speakerNames)
      setSavedSpeakers(true)
      setTimeout(() => setSavedSpeakers(false), 1500)
    } finally {
      setSavingSpeakers(false)
    }
  }

  if (backendDown) return <div className="p-6"><BackendError /></div>

  if (loading) {
    return (
      <div className="flex min-h-svh items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading sequence…
      </div>
    )
  }

  if (notFound) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-3 px-6 text-center">
        <h2 className="text-base font-semibold tracking-tight">Job not found</h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          This job is no longer in memory (backend was restarted). Start a new
          analysis from home.
        </p>
        <Button asChild>
          <Link to="/">Go home</Link>
        </Button>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm text-destructive">{error || 'No data'}</p>
        <Button asChild variant="outline">
          <Link to={`/jobs/${id}`}>Back to review</Link>
        </Button>
      </div>
    )
  }

  return (
    <div className="min-h-svh bg-background pb-20">
      <header className="sticky top-0 z-20 border-b border-border/70 bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-3">
          <div className="flex items-center gap-3">
            <Button asChild variant="ghost" size="icon" className="h-8 w-8">
              <Link to={`/jobs/${id}`} aria-label="Back to review">
                <ArrowLeft className="h-4 w-4" />
              </Link>
            </Button>
            <Clapperboard className="h-4 w-4 text-muted-foreground" />
            <h1 className="text-sm font-medium tracking-tight">Sequence editor</h1>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span><span className="tabular-nums text-foreground">{stats.total}</span> clips</span>
            <span className="text-muted-foreground/40">·</span>
            <span><span className="tabular-nums text-success">{stats.aroll}</span> A-roll</span>
            <span className="text-muted-foreground/40">·</span>
            <span><span className="tabular-nums">{stats.broll}</span> B-roll</span>
            <span className="text-muted-foreground/40">·</span>
            <span><span className="tabular-nums">{stats.words}</span> words</span>
            <span className="text-muted-foreground/40">·</span>
            <span><span className="tabular-nums">{stats.avgConf}%</span> avg conf</span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        {/* Speakers */}
        {data.speaker_tags.length > 0 && (
          <section className="mb-8 rounded-xl border border-border/70 bg-card p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold tracking-tight">Speakers</h2>
              <Button size="sm" onClick={saveSpeakers} disabled={savingSpeakers}>
                {savingSpeakers ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : savedSpeakers ? (
                  '✓ Saved'
                ) : (
                  <>
                    <Save className="h-3.5 w-3.5" />
                    Save names
                  </>
                )}
              </Button>
            </div>
            <p className="mb-4 text-xs text-muted-foreground">
              Name each speaker so the transcript reads naturally.
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {data.speaker_tags.map((tag) => {
                const key = `speaker_${tag}`
                return (
                  <div key={tag} className="grid gap-1.5">
                    <Label htmlFor={key} className="text-xs">
                      Speaker {tag}
                    </Label>
                    <Input
                      id={key}
                      placeholder={`e.g. "Bride", "Officiant"`}
                      value={speakerNames[key] ?? ''}
                      onChange={(e) =>
                        setSpeakerNames({
                          ...speakerNames,
                          [key]: e.target.value,
                        })
                      }
                    />
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {/* Per-segment timeline */}
        {grouped.map(({ segment, items }) => (
          <section key={segment} className="mb-10">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-base font-semibold tracking-tight">{segment}</h2>
              <span className="text-xs tabular-nums text-muted-foreground">
                {items.length} clip{items.length === 1 ? '' : 's'}
              </span>
            </div>
            <div className="space-y-2">
              {items.map((it, idx) => (
                <ClipRow
                  key={it.clip_id}
                  jobId={id!}
                  item={it}
                  speakerNames={speakerNames}
                  expanded={expandedClipId === it.clip_id}
                  onToggle={() =>
                    setExpandedClipId(expandedClipId === it.clip_id ? null : it.clip_id)
                  }
                  canMoveUp={idx > 0}
                  canMoveDown={idx < items.length - 1}
                  onMoveUp={() => reorder(it, -1)}
                  onMoveDown={() => reorder(it, 1)}
                  onChanged={load}
                />
              ))}
            </div>
          </section>
        ))}

        {grouped.length === 0 && (
          <div className="rounded-xl border border-dashed border-border bg-muted/20 p-12 text-center text-sm text-muted-foreground">
            No clips in this job.
          </div>
        )}
      </main>
    </div>
  )
}

interface ClipRowProps {
  jobId: string
  item: SequenceItem
  speakerNames: Record<string, string>
  expanded: boolean
  onToggle: () => void
  canMoveUp: boolean
  canMoveDown: boolean
  onMoveUp: () => void
  onMoveDown: () => void
  onChanged: () => void
}

function ClipRow({
  jobId,
  item,
  speakerNames,
  expanded,
  onToggle,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onChanged,
}: ClipRowProps) {
  const [trim, setTrim] = useState<[number, number]>([
    item.ai_in_sec ?? 0,
    item.ai_out_sec ?? item.duration_sec,
  ])
  const [savingTrim, setSavingTrim] = useState(false)
  const [currentTime, setCurrentTime] = useState(item.ai_in_sec ?? 0)
  const [playing, setPlaying] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    setTrim([item.ai_in_sec ?? 0, item.ai_out_sec ?? item.duration_sec])
  }, [item.ai_in_sec, item.ai_out_sec, item.duration_sec])

  // When the video advances past trim[1], pause.
  useEffect(() => {
    if (!playing) return
    if (currentTime >= trim[1]) {
      videoRef.current?.pause()
      setPlaying(false)
    }
  }, [currentTime, trim, playing])

  const dirty =
    Math.abs(trim[0] - (item.ai_in_sec ?? 0)) > 0.05 ||
    Math.abs(trim[1] - (item.ai_out_sec ?? item.duration_sec)) > 0.05

  const seek = (t: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = t
      setCurrentTime(t)
    }
  }

  const togglePlay = () => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      if (currentTime < trim[0] || currentTime >= trim[1]) v.currentTime = trim[0]
      v.play().catch(() => {})
      setPlaying(true)
    } else {
      v.pause()
      setPlaying(false)
    }
  }

  const saveTrim = async () => {
    setSavingTrim(true)
    try {
      await api.patchClip(jobId, item.clip_id, {
        ai_in_sec: trim[0],
        ai_out_sec: trim[1],
      })
      await onChanged()
    } finally {
      setSavingTrim(false)
    }
  }

  // Click word -> set in. Shift-click -> set out. Alt-click -> seek video.
  const onWordClick = (w: SequenceWord, e: React.MouseEvent) => {
    if (e.altKey) {
      seek(w.start_sec)
      return
    }
    if (e.shiftKey) {
      const newOut = Math.max(trim[0] + 0.1, w.end_sec + 0.3)
      setTrim([trim[0], Math.min(item.duration_sec, newOut)])
    } else {
      const newIn = Math.max(0, w.start_sec - 0.2)
      setTrim([newIn, Math.max(newIn + 0.1, trim[1])])
      seek(newIn)
    }
  }

  const conf = item.placement_confidence ?? 0
  const segName = item.clip_type === 'AROLL'
  const trimRangePct = (trim[1] - trim[0]) / Math.max(0.01, item.duration_sec) * 100
  const trimStartPct = trim[0] / Math.max(0.01, item.duration_sec) * 100

  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-card transition-colors hover:border-border">
      {/* Compact summary row — always visible */}
      <div className="flex items-stretch">
        {/* Reorder column */}
        <div className="flex w-9 shrink-0 flex-col items-center justify-center gap-0.5 border-r border-border/70 bg-muted/30 py-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={onMoveUp}
            disabled={!canMoveUp}
            className="h-6 w-6"
            aria-label="Move up"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
          <span className="text-[11px] font-medium tabular-nums">
            {item.timeline_position}
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={onMoveDown}
            disabled={!canMoveDown}
            className="h-6 w-6"
            aria-label="Move down"
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Thumbnail */}
        <button
          type="button"
          onClick={onToggle}
          className="hidden w-32 shrink-0 overflow-hidden bg-muted sm:block"
        >
          <img
            src={`${BASE_URL}${item.thumbnail_url}`}
            alt={item.filename}
            className="aspect-video h-full w-full object-cover"
            onError={(e) => {
              e.currentTarget.style.display = 'none'
            }}
          />
        </button>

        {/* Summary */}
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1.5 px-3 py-2 text-left"
        >
          <div className="flex items-center gap-2">
            <Badge
              variant="secondary"
              className={cn(
                'gap-1 px-1.5 py-0 text-[10px]',
                segName
                  ? 'bg-success/15 text-success'
                  : 'bg-info/15 text-info',
              )}
            >
              {segName ? <Mic className="h-2.5 w-2.5" /> : <MicOff className="h-2.5 w-2.5" />}
              {item.clip_type}
            </Badge>
            <span
              className="min-w-0 flex-1 truncate text-xs font-medium"
              title={item.filename}
            >
              {item.filename}
            </span>
            {item.ai_quality != null && (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                Q {item.ai_quality.toFixed(1)}
              </Badge>
            )}
            <span className="text-[10px] text-muted-foreground tabular-nums">
              {fmtTime(trim[0])} → {fmtTime(trim[1])}
            </span>
            {expanded ? (
              <ChevronUp className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            )}
          </div>

          {/* Mini track showing trim region within full clip */}
          <div className="relative h-1 overflow-hidden rounded-full bg-muted">
            <div
              className="absolute top-0 bottom-0 bg-success/70"
              style={{ left: `${trimStartPct}%`, width: `${trimRangePct}%` }}
            />
          </div>

          <div className="flex items-center gap-2">
            {item.ai_caption && (
              <p className="line-clamp-1 flex-1 text-[11px] text-muted-foreground">
                {item.ai_caption}
              </p>
            )}
            <div className="flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground">
              <span>{Math.round(conf)}%</span>
              <Progress value={conf} className="h-1 w-14" />
            </div>
          </div>
        </button>
      </div>

      {/* Expanded editor */}
      {expanded && (
        <div className="border-t border-border/70 bg-muted/20">
          <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr]">
            {/* Video player + scrubber */}
            <div className="flex flex-col gap-3 p-4">
              <div className="relative overflow-hidden rounded-lg bg-black">
                <video
                  ref={videoRef}
                  src={`${BASE_URL}${item.stream_url}`}
                  className="aspect-video w-full"
                  onTimeUpdate={(e) =>
                    setCurrentTime((e.target as HTMLVideoElement).currentTime)
                  }
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  preload="metadata"
                />
                {/* Trim overlay */}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1.5 bg-black/60">
                  <div
                    className="absolute top-0 bottom-0 bg-success/80"
                    style={{ left: `${trimStartPct}%`, width: `${trimRangePct}%` }}
                  />
                  <div
                    className="absolute top-[-2px] bottom-[-2px] w-0.5 bg-foreground"
                    style={{
                      left: `${(currentTime / Math.max(0.01, item.duration_sec)) * 100}%`,
                    }}
                  />
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={togglePlay}>
                  {playing ? (
                    <Pause className="h-3.5 w-3.5" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )}
                  {playing ? 'Pause' : 'Play trimmed'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => seek(trim[0])}>
                  Jump to in
                </Button>
                <Button size="sm" variant="ghost" onClick={() => seek(trim[1])}>
                  Jump to out
                </Button>
                <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
                  {fmtTime(currentTime)} / {fmtTime(item.duration_sec)}
                </span>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>In <span className="tabular-nums">{fmtTime(trim[0])}</span></span>
                  <span className="text-foreground/80 tabular-nums">
                    Keep {fmtTime(trim[1] - trim[0])}
                  </span>
                  <span>Out <span className="tabular-nums">{fmtTime(trim[1])}</span></span>
                </div>
                <Slider
                  value={trim}
                  min={0}
                  max={Math.max(item.duration_sec, 0.1)}
                  step={0.05}
                  onValueChange={(v) =>
                    setTrim([v[0], v[1]] as [number, number])
                  }
                  minStepsBetweenThumbs={1}
                />
              </div>

              <div className="flex items-center justify-between">
                <span className="text-[10px] text-muted-foreground/60">
                  Click a word to set in · Shift-click to set out · Alt-click to seek
                </span>
                {dirty && (
                  <Button size="sm" onClick={saveTrim} disabled={savingTrim}>
                    {savingTrim ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <>
                        <ScissorsLineDashed className="h-3.5 w-3.5" />
                        Save trim
                      </>
                    )}
                  </Button>
                )}
              </div>
            </div>

            {/* Transcript */}
            <div className="border-l border-border/70 p-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Transcript
                </span>
                <span className="text-[10px] text-muted-foreground/60 tabular-nums">
                  {item.words.length} words
                </span>
              </div>
              {item.words.length > 0 ? (
                <div className="max-h-[55vh] overflow-y-auto pr-1 text-[13px] leading-relaxed">
                  {renderTranscript(
                    item.words,
                    trim,
                    speakerNames,
                    onWordClick,
                    currentTime,
                  )}
                </div>
              ) : (
                <p className="text-xs italic text-muted-foreground/70">
                  No dialogue detected — this is B-roll.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function renderTranscript(
  words: SequenceWord[],
  trim: [number, number],
  speakerNames: Record<string, string>,
  onClick: (w: SequenceWord, e: React.MouseEvent) => void,
  currentTime: number,
) {
  const blocks: { tag: number | null; words: SequenceWord[] }[] = []
  for (const w of words) {
    const last = blocks[blocks.length - 1]
    if (!last || last.tag !== w.speaker_tag) {
      blocks.push({ tag: w.speaker_tag, words: [w] })
    } else {
      last.words.push(w)
    }
  }

  return blocks.map((blk, bi) => {
    const speakerLabel = blk.tag
      ? speakerNames[`speaker_${blk.tag}`] || `Speaker ${blk.tag}`
      : null
    return (
      <div key={bi} className="mb-2">
        {speakerLabel && (
          <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {speakerLabel}
          </div>
        )}
        <div>
          {blk.words.map((w, wi) => {
            const inRange = w.start_sec >= trim[0] && w.end_sec <= trim[1]
            const playing = currentTime >= w.start_sec && currentTime <= w.end_sec
            return (
              <button
                key={wi}
                type="button"
                onClick={(e) => onClick(w, e)}
                title={`${w.start_sec.toFixed(2)}s – ${w.end_sec.toFixed(2)}s · alt-click to seek`}
                className={cn(
                  'rounded px-0.5 py-0 transition-colors',
                  inRange
                    ? 'text-foreground hover:bg-foreground/15'
                    : 'text-muted-foreground/40 line-through hover:bg-foreground/5',
                  playing && 'bg-success/30 text-foreground',
                )}
              >
                {w.word}{' '}
              </button>
            )
          })}
        </div>
      </div>
    )
  })
}
