import * as React from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import {
  Cpu,
  Film,
  FolderOpen,
  ListChecks,
  ListOrdered,
  Maximize2,
  Minimize2,
  PanelLeft,
  PanelLeftClose,
  Settings,
} from 'lucide-react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from '@/components/ui/sheet'
import { api, type AiInfo } from '../api'
import { cn } from '@/lib/utils'

type TabKey = 'library' | 'review' | 'sequence' | 'settings'

interface ShellProps {
  /** Optional content for the contextual left sidebar. */
  sidebar?: React.ReactNode
  sidebarTitle?: string
  /** Hide sidebar entirely (e.g. for full-bleed pages). */
  hideSidebar?: boolean
  children: React.ReactNode
}

const SIDEBAR_KEY = 'cull.sidebar.open'

export default function Shell({
  sidebar,
  sidebarTitle = 'Panel',
  hideSidebar,
  children,
}: ShellProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const [aiInfo, setAiInfo] = React.useState<AiInfo | null>(null)
  const [sidebarOpen, setSidebarOpen] = React.useState<boolean>(() => {
    if (typeof window === 'undefined') return true
    const stored = localStorage.getItem(SIDEBAR_KEY)
    return stored === null ? true : stored === '1'
  })
  const [mobileOpen, setMobileOpen] = React.useState(false)
  const [maxOpen, setMaxOpen] = React.useState(false)

  React.useEffect(() => {
    api.aiInfo().then(setAiInfo).catch(() => setAiInfo(null))
  }, [])

  React.useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, sidebarOpen ? '1' : '0')
  }, [sidebarOpen])

  // Derive active tab from URL
  const activeTab: TabKey = location.pathname.startsWith('/jobs/')
    ? location.pathname.endsWith('/sequence')
      ? 'sequence'
      : 'review'
    : location.pathname === '/settings'
      ? 'settings'
      : 'library'

  // Capture last visited job for Review/Sequence tabs
  const jobIdMatch = location.pathname.match(/^\/jobs\/([^/]+)/)
  const currentJobId = jobIdMatch ? jobIdMatch[1] : null
  const lastJobIdRef = React.useRef<string | null>(currentJobId)
  React.useEffect(() => {
    if (currentJobId) lastJobIdRef.current = currentJobId
  }, [currentJobId])

  const handleTab = (val: string) => {
    const last = lastJobIdRef.current
    switch (val as TabKey) {
      case 'library':
        navigate('/')
        break
      case 'review':
        navigate(last ? `/jobs/${last}` : '/')
        break
      case 'sequence':
        navigate(last ? `/jobs/${last}/sequence` : '/')
        break
      case 'settings':
        navigate('/settings')
        break
    }
  }

  const reviewDisabled = !lastJobIdRef.current
  const sequenceDisabled = !lastJobIdRef.current

  return (
    <div className="flex h-svh min-h-0 flex-col bg-background text-foreground">
      {/* TOP BAR */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-panel-header px-3">
        <div className="flex min-w-0 items-center gap-3">
          {!hideSidebar && (
            <>
              {/* Desktop sidebar toggle */}
              <Button
                variant="ghost"
                size="icon"
                className="hidden h-8 w-8 sm:inline-flex"
                onClick={() => setSidebarOpen((v) => !v)}
                aria-label="Toggle sidebar"
              >
                {sidebarOpen ? (
                  <PanelLeftClose className="h-4 w-4" />
                ) : (
                  <PanelLeft className="h-4 w-4" />
                )}
              </Button>
              {/* Mobile drawer trigger */}
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 sm:hidden"
                onClick={() => setMobileOpen(true)}
                aria-label="Open panel"
              >
                <PanelLeft className="h-4 w-4" />
              </Button>
            </>
          )}
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded-sm bg-primary text-white shadow-[0_0_0_1px_color-mix(in_srgb,var(--primary)_60%,black),inset_0_1px_0_color-mix(in_srgb,white_18%,transparent)]">
              <Film className="h-3.5 w-3.5" />
            </div>
            <span className="text-[13px] font-semibold tracking-tight">
              Cull
            </span>
            <span className="hidden text-[11px] text-muted-foreground sm:inline">
              for DaVinci Resolve
            </span>
          </div>
        </div>

        {/* TABS */}
        <Tabs value={activeTab} onValueChange={handleTab} className="hidden sm:block">
          <TabsList className="h-8 bg-muted">
            <TabsTrigger value="library" className="gap-1.5 px-3 text-[12px]">
              <FolderOpen className="h-3.5 w-3.5" />
              Library
            </TabsTrigger>
            <TabsTrigger
              value="review"
              disabled={reviewDisabled}
              className="gap-1.5 px-3 text-[12px]"
            >
              <ListChecks className="h-3.5 w-3.5" />
              Review
            </TabsTrigger>
            <TabsTrigger
              value="sequence"
              disabled={sequenceDisabled}
              className="gap-1.5 px-3 text-[12px]"
            >
              <ListOrdered className="h-3.5 w-3.5" />
              Sequence
            </TabsTrigger>
            <TabsTrigger value="settings" className="gap-1.5 px-3 text-[12px]">
              <Settings className="h-3.5 w-3.5" />
              Settings
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {/* MOBILE compact tab strip */}
        <Tabs value={activeTab} onValueChange={handleTab} className="sm:hidden">
          <TabsList className="h-8 bg-muted">
            <TabsTrigger value="library" className="px-2 text-[11px]">Lib</TabsTrigger>
            <TabsTrigger value="review" disabled={reviewDisabled} className="px-2 text-[11px]">Review</TabsTrigger>
            <TabsTrigger value="sequence" disabled={sequenceDisabled} className="px-2 text-[11px]">Seq</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="flex items-center gap-2">
          <Badge
            variant="secondary"
            className={cn(
              'gap-1.5 rounded-sm px-1.5 py-0 text-[10.5px] font-medium',
              aiInfo
                ? 'bg-success/15 text-[var(--success)]'
                : 'bg-destructive/15 text-destructive',
            )}
          >
            <Cpu className="h-2.5 w-2.5" />
            <span className="hidden sm:inline">
              {aiInfo
                ? aiInfo.backend === 'local'
                  ? 'Local'
                  : 'Cloud'
                : 'Offline'}
            </span>
            <span className="relative flex h-1.5 w-1.5">
              <span
                className={cn(
                  'absolute inline-flex h-full w-full animate-ping rounded-full opacity-70',
                  aiInfo ? 'bg-success' : 'bg-destructive',
                )}
              />
              <span
                className={cn(
                  'relative inline-flex h-1.5 w-1.5 rounded-full',
                  aiInfo ? 'bg-success' : 'bg-destructive',
                )}
              />
            </span>
          </Badge>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setMaxOpen((v) => !v)}
            aria-label="Toggle max"
            title={maxOpen ? 'Compact mode' : 'Expand to full screen'}
          >
            {maxOpen ? (
              <Minimize2 className="h-4 w-4" />
            ) : (
              <Maximize2 className="h-4 w-4" />
            )}
          </Button>
        </div>
      </header>

      {/* BODY */}
      <div
        data-max={maxOpen ? '1' : '0'}
        className="relative flex min-h-0 flex-1 overflow-hidden"
      >
        {/* Desktop sidebar */}
        {!hideSidebar && sidebar && (
          <aside
            className={cn(
              'hidden shrink-0 border-r border-border bg-card transition-[width] duration-200 sm:block',
              sidebarOpen ? 'w-60' : 'w-0',
            )}
          >
            <div
              className={cn(
                'flex h-full min-h-0 flex-col overflow-hidden',
                !sidebarOpen && 'invisible',
              )}
            >
              <div className="titlebar">{sidebarTitle}</div>
              <div className="min-h-0 flex-1 overflow-auto">{sidebar}</div>
            </div>
          </aside>
        )}

        {/* Mobile drawer (Sheet) */}
        {!hideSidebar && sidebar && (
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetContent side="left" width="280px" className="p-0">
              <SheetTitle className="sr-only">{sidebarTitle}</SheetTitle>
              <div className="titlebar">{sidebarTitle}</div>
              <div className="min-h-0 flex-1 overflow-auto">{sidebar}</div>
            </SheetContent>
          </Sheet>
        )}

        {/* MAIN CONTENT PANE */}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {children}
        </main>
      </div>

      {/* STATUS BAR */}
      <footer className="flex h-6 shrink-0 items-center justify-between border-t border-border bg-panel-header px-3 font-mono text-[10.5px] text-muted-foreground">
        <span className="flex items-center gap-2">
          <span
            className={cn(
              'inline-block h-1.5 w-1.5 rounded-full',
              aiInfo ? 'bg-success' : 'bg-destructive',
            )}
          />
          {aiInfo
            ? `${aiInfo.label ?? 'Engine'} · ${aiInfo.backend}`
            : 'Backend offline'}
        </span>
        <span className="hidden sm:inline">
          {location.pathname}
        </span>
        <span>v1.0</span>
      </footer>

      {/* Use shell-link for sub-routing convenience (silence unused) */}
      <Link to="/" className="hidden" aria-hidden />
    </div>
  )
}
