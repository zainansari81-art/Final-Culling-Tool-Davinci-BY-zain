import * as React from 'react'
import { cn } from '@/lib/utils'

type DivProps = React.HTMLAttributes<HTMLDivElement>

interface HudFrameProps extends DivProps {
  state?: 'idle' | 'active' | 'done' | 'pending'
  scanline?: boolean
}

/**
 * Friendly rounded panel. State adds a soft amber outline + glow when active.
 * Kept the original `HudFrame` name so call sites stay stable.
 */
export function HudFrame({
  state,
  className,
  children,
  ...rest
}: HudFrameProps) {
  return (
    <div data-state={state} className={cn('panel', className)} {...rest}>
      {children}
    </div>
  )
}

interface HudTitleBarProps {
  label: string
  index?: string | number
  status?: React.ReactNode
  meta?: React.ReactNode
  className?: string
  icon?: React.ReactNode
}

export function HudTitleBar({
  label,
  index,
  status,
  meta,
  className,
  icon,
}: HudTitleBarProps) {
  return (
    <div className={cn('panel-header', className)}>
      <div className="flex min-w-0 items-center gap-2">
        {index != null && (
          <span className="flex h-5 w-5 items-center justify-center rounded-full border border-border-strong bg-muted text-[10px] font-semibold tabular-nums text-muted-foreground">
            {index}
          </span>
        )}
        {icon && <span className="text-muted-foreground">{icon}</span>}
        <span className="truncate text-[13px] font-medium text-foreground">
          {label}
        </span>
        {status && (
          <span className="ml-1 text-[11.5px] font-normal text-muted-foreground">
            · {status}
          </span>
        )}
      </div>
      {meta && (
        <div className="ml-3 truncate text-[11.5px] text-muted-foreground/80">
          {meta}
        </div>
      )}
    </div>
  )
}

export function HudLabel({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return <div className={cn('eyebrow', className)}>{children}</div>
}

interface HudReadoutProps {
  label: string
  value: React.ReactNode
  hint?: string
  align?: 'left' | 'right'
  accent?: 'default' | 'primary' | 'success' | 'destructive' | 'warning'
}

export function HudReadout({
  label,
  value,
  hint,
  align = 'left',
  accent = 'default',
}: HudReadoutProps) {
  const accentClass = {
    default: 'text-foreground',
    primary: 'text-[var(--primary)]',
    success: 'text-[var(--success)]',
    destructive: 'text-destructive',
    warning: 'text-[var(--warning)]',
  }[accent]
  return (
    <div
      className={cn(
        'flex flex-col gap-1',
        align === 'right' && 'items-end text-right',
      )}
    >
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className={cn('text-[18px] font-semibold tabular-nums leading-none', accentClass)}>
        {value}
      </span>
      {hint && <span className="text-[10.5px] text-muted-foreground/70">{hint}</span>}
    </div>
  )
}

interface SegProgressProps {
  value: number
  segments?: number
  variant?: 'primary' | 'success'
  className?: string
}

/**
 * Smooth gradient progress bar. (Name kept for compat with old call sites
 * that imported `SegProgress` — chunked-segment styling is gone.)
 */
export function SegProgress({
  value,
  variant = 'primary',
  className,
}: SegProgressProps) {
  const pct = Math.max(0, Math.min(100, value))
  return (
    <div
      className={cn(
        'smooth-progress',
        variant === 'success' && 'success',
        className,
      )}
    >
      <i style={{ width: `${pct}%` }} />
    </div>
  )
}

export function HudDivider({ className }: { className?: string }) {
  return <div className={cn('soft-divider', className)} />
}

interface HudPillProps {
  children: React.ReactNode
  tone?: 'default' | 'success' | 'destructive' | 'primary' | 'warning'
  className?: string
  title?: string
}

export function HudPill({
  children,
  tone = 'default',
  className,
  title,
}: HudPillProps) {
  const toneClass = {
    default: 'border-border bg-muted/50 text-foreground/80',
    success: 'border-success/40 bg-success/12 text-[var(--success)]',
    destructive: 'border-destructive/40 bg-destructive/12 text-destructive',
    primary: 'border-primary/40 bg-primary/12 text-[var(--primary)]',
    warning: 'border-warning/40 bg-warning/12 text-[var(--warning)]',
  }[tone]
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none',
        toneClass,
        className,
      )}
    >
      {children}
    </span>
  )
}
