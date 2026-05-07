import { useEffect, useState } from 'react'
import { Cpu } from 'lucide-react'
import { api, type AiInfo } from '../api'
import Shell from '../components/Shell'

export default function SettingsPage() {
  const [aiInfo, setAiInfo] = useState<AiInfo | null>(null)
  useEffect(() => {
    api.aiInfo().then(setAiInfo).catch(() => setAiInfo(null))
  }, [])

  const sidebar = (
    <div className="flex flex-col">
      <SidebarItem active label="Engine" />
      <SidebarItem label="Shortcuts" />
      <SidebarItem label="Export" />
      <SidebarItem label="About" />
    </div>
  )

  return (
    <Shell sidebar={sidebar} sidebarTitle="Settings">
      <div className="min-h-0 flex-1 overflow-auto p-5">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-[18px] font-semibold tracking-tight">Engine</h2>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            Backend that runs analysis. Local stays on this Mac, Cloud uses
            Vertex Gemini and your GCP quota.
          </p>

          <div className="panel mt-5 p-4">
            <div className="flex items-center gap-2">
              <Cpu className="h-4 w-4 text-[var(--primary)]" />
              <span className="text-[13px] font-medium">
                {aiInfo?.label ?? '—'}
              </span>
            </div>
            <p className="mt-1 text-[12px] text-muted-foreground">
              Backend: {aiInfo?.backend ?? 'offline'}
            </p>
            {aiInfo?.vlm_model && (
              <p className="mt-0.5 font-mono text-[11px] text-muted-foreground/80">
                Model: {aiInfo.vlm_model}
              </p>
            )}
          </div>

          <div className="panel mt-4 p-4">
            <h3 className="text-[13px] font-medium">Status</h3>
            <p className="mt-1 text-[12px] text-muted-foreground">
              {aiInfo
                ? 'Backend reachable. Ready to run analysis.'
                : 'Backend offline. Start it via `start.sh` or check the logs.'}
            </p>
          </div>
        </div>
      </div>
    </Shell>
  )
}

function SidebarItem({
  label,
  active,
}: {
  label: string
  active?: boolean
}) {
  return (
    <button
      className={`flex items-center justify-between border-l-2 px-3 py-2 text-left text-[12.5px] transition-colors ${
        active
          ? 'border-l-[var(--primary)] bg-primary/10 text-foreground'
          : 'border-l-transparent text-muted-foreground hover:bg-accent/40 hover:text-foreground'
      }`}
    >
      {label}
    </button>
  )
}
