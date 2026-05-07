import * as React from 'react'
import { cn } from '@/lib/utils'

type DivProps = React.HTMLAttributes<HTMLDivElement>

interface HudFrameProps extends DivProps {
  state?: 'idle' | 'active' | 'done' | 'pending'
  scanline?: boolean
}

export function HudFrame({
  state,
  scanline,
  className,
  children,
  ...rest
}: HudFrameProps) {
  return (
    <div
      data-state={state}
      className={cn('hud-frame', scanline && 'scanline', className)}
      {...rest}
    >
      <span aria-hidden className="hud-corners" />
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
}

export function HudTitleBar({
  label,
  index,
  status,
  meta,
  className,
}: HudTitleBarProps) {
  return (
    <div className={cn('hud-titlebar', className)}>
      <div className="flex items-center gap-2">
        {index != null && (
          <span className="text-foreground/80">
            {String(index).padStart(2, '0')}
          </span>
        )}
        <span className="text-foreground/80">// {label}</span>
        {status && (
          <span className="ml-2 text-[var(--primary)]">·· {status}</span>
        )}
      </div>
      {meta && <div className="text-muted-foreground/80">{meta}</div>}
    </div>
  )
}

interface HudLabelProps {
  children: React.ReactNode
  className?: string
}

export function HudLabel({ children, className }: HudLabelProps) {
  return <div className={cn('hud-label', className)}>{children}</div>
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
        'flex flex-col gap-0.5 font-mono leading-none',
        align === 'right' && 'items-end',
      )}
    >
      <span className="text-[9px] uppercase tracking-[0.18em] text-muted-foreground/80">
        {label}
      </span>
      <span className={cn('text-[13px] tabular-nums', accentClass)}>
        {value}
      </span>
      {hint && (
        <span className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground/60">
          {hint}
        </span>
      )}
    </div>
  )
}

interface SegProgressProps {
  value: number // 0..100
  segments?: number
  variant?: 'primary' | 'success'
  className?: string
}

export function SegProgress({
  value,
  segments = 24,
  variant = 'primary',
  className,
}: SegProgressProps) {
  const filled = Math.round((Math.max(0, Math.min(100, value)) / 100) * segments)
  return (
    <div
      className={cn('seg-progress', variant === 'success' && 'success', className)}
      style={{ '--seg-count': segments } as React.CSSProperties}
    >
      {Array.from({ length: segments }).map((_, i) => (
        <i key={i} className={i < filled ? 'on' : ''} />
      ))}
    </div>
  )
}

export function HudDivider({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'h-px w-full bg-[linear-gradient(90deg,transparent,var(--border-strong),transparent)]',
        className,
      )}
    />
  )
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
    default: 'border-border bg-muted/40 text-foreground',
    success: 'border-success/40 bg-success/10 text-[var(--success)]',
    destructive: 'border-destructive/40 bg-destructive/10 text-destructive',
    primary: 'border-primary/40 bg-primary/10 text-[var(--primary)]',
    warning: 'border-warning/40 bg-warning/10 text-[var(--warning)]',
  }[tone]
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em]',
        toneClass,
        className,
      )}
    >
      {children}
    </span>
  )
}
