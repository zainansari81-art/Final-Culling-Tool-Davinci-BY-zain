import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  Clapperboard,
  Loader2,
  Mic,
  MicOff,
  Save,
} from 'lucide-react'
import {
  api,
  BASE_URL,
  type SequenceItem,
  type SequenceResponse,
  type SequenceWord,
} from '../api'
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
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({})
  const [savingSpeakers, setSavingSpeakers] = useState(false)
  const [savedSpeakers, setSavedSpeakers] = useState(false)

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    try {
      const res = await api.getSequence(id)
      setData(res)
      setSpeakerNames(res.speaker_names || {})
    } catch (err: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg = (err as any)?.response?.data?.detail ?? 'Failed to load'
      setError(String(msg))
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
    if (!id || !data) return
    // Find clip's neighbors within its own segment, swap sequence_position
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

  if (loading) {
    return (
      <div className="flex min-h-svh items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading sequence…
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-3">
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
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="tabular-nums">{stats.total}</span> clips
            <span className="text-muted-foreground/50">·</span>
            <span className="tabular-nums text-success">{stats.aroll}</span> A-roll
            <span className="text-muted-foreground/50">·</span>
            <span className="tabular-nums">{stats.broll}</span> B-roll
            <span className="text-muted-foreground/50">·</span>
            <span className="tabular-nums">{stats.words}</span> words
            <span className="text-muted-foreground/50">·</span>
            <span className="tabular-nums">{stats.avgConf}%</span> avg confidence
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        {/* Speaker names */}
        {data.speaker_tags.length > 0 && (
          <section className="mb-8 rounded-xl border border-border/70 bg-card p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold tracking-tight">Speakers</h2>
              <Button
                size="sm"
                onClick={saveSpeakers}
                disabled={savingSpeakers}
              >
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
              AI detected {data.speaker_tags.length} speaker
              {data.speaker_tags.length === 1 ? '' : 's'}. Give them names so
              the transcript reads naturally.
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
              <h2 className="text-base font-semibold tracking-tight">
                {segment}
              </h2>
              <span className="text-xs text-muted-foreground tabular-nums">
                {items.length} clip{items.length === 1 ? '' : 's'}
              </span>
            </div>
            <div className="space-y-3">
              {items.map((it, idx) => (
                <ClipRow
                  key={it.clip_id}
                  jobId={id!}
                  item={it}
                  speakerNames={speakerNames}
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

  useEffect(() => {
    setTrim([item.ai_in_sec ?? 0, item.ai_out_sec ?? item.duration_sec])
  }, [item.ai_in_sec, item.ai_out_sec, item.duration_sec])

  const dirty =
    trim[0] !== (item.ai_in_sec ?? 0) ||
    trim[1] !== (item.ai_out_sec ?? item.duration_sec)

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

  // Click a word in the transcript -> set as in or out
  const onWordClick = async (w: SequenceWord, e: React.MouseEvent) => {
    if (e.shiftKey) {
      // Shift-click sets out-point
      const newOut = Math.max(trim[0] + 0.1, w.end_sec + 0.3)
      setTrim([trim[0], newOut])
      await api.patchClip(jobId, item.clip_id, { ai_out_sec: newOut })
      onChanged()
    } else {
      // Click sets in-point
      const newIn = Math.max(0, w.start_sec - 0.2)
      const newOut = Math.max(newIn + 0.1, trim[1])
      setTrim([newIn, newOut])
      await api.patchClip(jobId, item.clip_id, { ai_in_sec: newIn })
      onChanged()
    }
  }

  const conf = item.placement_confidence ?? 0

  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-card">
      <div className="flex">
        {/* Reorder column */}
        <div className="flex w-10 shrink-0 flex-col items-center justify-center gap-1 border-r border-border/70 bg-muted/30 py-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={onMoveUp}
            disabled={!canMoveUp}
            className="h-7 w-7"
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
          <span className="text-xs font-medium tabular-nums">
            {item.timeline_position}
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={onMoveDown}
            disabled={!canMoveDown}
            className="h-7 w-7"
          >
            <ArrowDown className="h-4 w-4" />
          </Button>
        </div>

        {/* Thumbnail */}
        <div className="hidden w-44 shrink-0 sm:block">
          <img
            src={`${BASE_URL}${item.thumbnail_url}`}
            alt={item.filename}
            className="aspect-video h-full w-full object-cover"
          />
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1 p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge
              variant="secondary"
              className={cn(
                'gap-1',
                item.clip_type === 'AROLL'
                  ? 'bg-success/15 text-success'
                  : 'bg-info/15 text-info',
              )}
            >
              {item.clip_type === 'AROLL' ? (
                <Mic className="h-3 w-3" />
              ) : (
                <MicOff className="h-3 w-3" />
              )}
              {item.clip_type}
            </Badge>
            <span className="text-sm font-medium" title={item.filename}>
              {item.filename}
            </span>
            {item.ai_quality != null && (
              <Badge variant="outline" className="text-[10px]">
                Q {item.ai_quality.toFixed(1)}/10
              </Badge>
            )}
            <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
              <span>placement</span>
              <div className="w-20">
                <Progress value={conf} className="h-1" />
              </div>
              <span className="w-9 text-right tabular-nums">{Math.round(conf)}%</span>
            </div>
          </div>

          {item.ai_caption && (
            <p className="mb-3 text-xs text-muted-foreground">{item.ai_caption}</p>
          )}

          {/* Transcript with click-to-trim */}
          {item.words.length > 0 ? (
            <div className="mb-3 rounded-md border border-border/60 bg-muted/30 p-3">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Transcript
                </span>
                <span className="text-[10px] text-muted-foreground/70">
                  click to set in · shift+click to set out
                </span>
              </div>
              <div className="text-sm leading-relaxed">
                {renderTranscript(item.words, trim, speakerNames, onWordClick)}
              </div>
            </div>
          ) : (
            <p className="mb-3 text-xs italic text-muted-foreground/70">
              No dialogue detected.
            </p>
          )}

          {/* Trim slider */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>
                In <span className="tabular-nums">{fmtTime(trim[0])}</span>
              </span>
              <span className="text-foreground/80 tabular-nums">
                Keep {fmtTime(trim[1] - trim[0])}
              </span>
              <span>
                Out <span className="tabular-nums">{fmtTime(trim[1])}</span>
              </span>
            </div>
            <Slider
              value={trim}
              min={0}
              max={Math.max(item.duration_sec, 0.1)}
              step={0.1}
              onValueChange={(v) => setTrim([v[0], v[1]] as [number, number])}
              minStepsBetweenThumbs={1}
            />
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground/60">
                Full clip {fmtTime(item.duration_sec)}
              </span>
              {dirty && (
                <Button size="sm" onClick={saveTrim} disabled={savingTrim}>
                  {savingTrim ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <>
                      <Save className="h-3.5 w-3.5" />
                      Save trim
                    </>
                  )}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function renderTranscript(
  words: SequenceWord[],
  trim: [number, number],
  speakerNames: Record<string, string>,
  onClick: (w: SequenceWord, e: React.MouseEvent) => void,
) {
  // Group consecutive words by speaker for nicer rendering
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
      <span key={bi} className="mr-2">
        {speakerLabel && (
          <span className="mr-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {speakerLabel}:
          </span>
        )}
        {blk.words.map((w, wi) => {
          const inRange = w.start_sec >= trim[0] && w.end_sec <= trim[1]
          return (
            <button
              key={wi}
              type="button"
              onClick={(e) => onClick(w, e)}
              title={`${w.start_sec.toFixed(2)}s – ${w.end_sec.toFixed(2)}s`}
              className={cn(
                'rounded px-0.5 py-0 transition-colors hover:bg-foreground/10',
                inRange ? 'text-foreground' : 'text-muted-foreground/40 line-through',
              )}
            >
              {w.word}{' '}
            </button>
          )
        })}
      </span>
    )
  })
}
