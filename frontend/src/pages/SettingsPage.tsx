import { useEffect, useState } from 'react'
import {
  Cpu,
  Download,
  Info,
  Keyboard,
  Server,
} from 'lucide-react'
import { api, type AiInfo } from '../api'
import Shell from '../components/Shell'
import { cn } from '@/lib/utils'

type Section = 'engine' | 'shortcuts' | 'export' | 'about'

const SECTIONS: { key: Section; label: string; icon: React.ElementType }[] = [
  { key: 'engine', label: 'Engine', icon: Cpu },
  { key: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
  { key: 'export', label: 'Export', icon: Download },
  { key: 'about', label: 'About', icon: Info },
]

export default function SettingsPage() {
  const [aiInfo, setAiInfo] = useState<AiInfo | null>(null)
  const [section, setSection] = useState<Section>('engine')

  useEffect(() => {
    api.aiInfo().then(setAiInfo).catch(() => setAiInfo(null))
  }, [])

  const sidebar = (
    <div className="flex flex-col py-1">
      {SECTIONS.map((s) => {
        const Icon = s.icon
        const active = section === s.key
        return (
          <button
            key={s.key}
            onClick={() => setSection(s.key)}
            className={cn(
              'mx-1 flex items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-[12.5px] transition-colors',
              active
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
          >
            <Icon
              className={cn(
                'h-3.5 w-3.5',
                active ? 'text-[var(--primary)]' : 'text-muted-foreground/80',
              )}
            />
            <span className="flex-1">{s.label}</span>
          </button>
        )
      })}
    </div>
  )

  return (
    <Shell sidebar={sidebar} sidebarTitle="Settings">
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-2xl px-6 py-8">
          {section === 'engine' && <EngineSection aiInfo={aiInfo} />}
          {section === 'shortcuts' && <ShortcutsSection />}
          {section === 'export' && <ExportSection />}
          {section === 'about' && <AboutSection />}
        </div>
      </div>
    </Shell>
  )
}

function SectionHeader({
  title,
  subtitle,
}: {
  title: string
  subtitle: string
}) {
  return (
    <div className="mb-6">
      <h2 className="text-[18px] font-semibold tracking-tight">{title}</h2>
      <p className="mt-1 text-[12.5px] text-muted-foreground">{subtitle}</p>
    </div>
  )
}

function Row({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-6 border-b border-border py-3 last:border-b-0">
      <div className="flex-1">
        <div className="text-[12.5px] font-medium">{label}</div>
        {hint && (
          <div className="mt-0.5 text-[11.5px] text-muted-foreground">
            {hint}
          </div>
        )}
      </div>
      <div className="text-right text-[12.5px]">{children}</div>
    </div>
  )
}

function EngineSection({ aiInfo }: { aiInfo: AiInfo | null }) {
  return (
    <>
      <SectionHeader
        title="Engine"
        subtitle="Backend that runs analysis. Local stays on this Mac, Cloud uses Vertex Gemini."
      />
      <div className="panel">
        <Row
          label="Status"
          hint={aiInfo ? 'Backend reachable' : 'Backend offline'}
        >
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 text-[11px] font-medium',
              aiInfo
                ? 'bg-success/15 text-[var(--success)]'
                : 'bg-destructive/15 text-destructive',
            )}
          >
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                aiInfo ? 'bg-success' : 'bg-destructive',
              )}
            />
            {aiInfo ? 'Online' : 'Offline'}
          </span>
        </Row>
        <div className="px-4">
          <Row label="Backend" hint="Where analysis runs">
            <span className="font-medium">
              {aiInfo?.backend === 'local'
                ? 'Local'
                : aiInfo?.backend === 'cloud'
                  ? 'Cloud'
                  : '—'}
            </span>
          </Row>
          <Row label="Engine" hint="Model used by AI analysis">
            <span className="font-medium">{aiInfo?.label ?? '—'}</span>
          </Row>
          {aiInfo?.vlm_model && (
            <Row label="Model id" hint="Underlying VLM identifier">
              <span className="font-mono text-[11px] text-muted-foreground">
                {aiInfo.vlm_model}
              </span>
            </Row>
          )}
        </div>
      </div>

      <div className="panel mt-5">
        <div className="border-b border-border bg-panel-header px-4 py-2 text-[11.5px] font-medium text-muted-foreground">
          <Server className="mr-1.5 inline-block h-3 w-3" />
          Backend
        </div>
        <div className="px-4">
          <Row label="Host">
            <span className="font-mono text-[11.5px]">127.0.0.1</span>
          </Row>
          <Row label="Build">
            <span className="font-mono text-[11.5px]">v1.0</span>
          </Row>
        </div>
      </div>
    </>
  )
}

function ShortcutsSection() {
  const groups: { title: string; items: [string, string][] }[] = [
    {
      title: 'Review',
      items: [
        ['A', 'Approve'],
        ['R', 'Reject'],
        ['N', 'Near miss'],
        ['1–9', 'Set segment'],
        ['←/→', 'Previous / next clip'],
        ['Space', 'Play preview'],
      ],
    },
    {
      title: 'Global',
      items: [
        ['⌘N', 'New session'],
        ['⌘F', 'Search clips'],
        ['⌘K', 'Quick search'],
      ],
    },
  ]
  return (
    <>
      <SectionHeader
        title="Shortcuts"
        subtitle="Keyboard shortcuts available across the app."
      />
      <div className="space-y-5">
        {groups.map((g) => (
          <div key={g.title} className="panel">
            <div className="border-b border-border bg-panel-header px-4 py-2 text-[11.5px] font-medium text-muted-foreground">
              {g.title}
            </div>
            <div className="px-4">
              {g.items.map(([k, v]) => (
                <Row key={k} label={v}>
                  <kbd className="rounded-sm border border-border-strong bg-muted px-2 py-0.5 font-mono text-[10.5px] tabular-nums">
                    {k}
                  </kbd>
                </Row>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

function ExportSection() {
  return (
    <>
      <SectionHeader
        title="Export"
        subtitle="Where Cull sends your selects when you finish a review."
      />
      <div className="panel">
        <div className="px-4">
          <Row label="DaVinci Resolve" hint="Connect via Resolve API">
            <span className="text-[var(--success)]">Connected</span>
          </Row>
          <Row label="FCPXML" hint="Export to .fcpxml">
            <span className="text-muted-foreground">Available</span>
          </Row>
          <Row label="CSV" hint="Plain table of selects">
            <span className="text-muted-foreground">Available</span>
          </Row>
        </div>
      </div>
    </>
  )
}

function AboutSection() {
  return (
    <>
      <SectionHeader
        title="About"
        subtitle="Cull for DaVinci Resolve — wedding footage culler."
      />
      <div className="panel">
        <div className="px-4">
          <Row label="Version">
            <span className="font-mono text-[11.5px]">1.0.0</span>
          </Row>
          <Row label="Branch">
            <span className="font-mono text-[11.5px]">feature/local-mlx</span>
          </Row>
        </div>
      </div>
    </>
  )
}
