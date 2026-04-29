import * as React from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

export type StepState = 'pending' | 'active' | 'done'

interface StepProps {
  index: number
  state: StepState
  title: string
  subtitle?: string
  open?: boolean
  onToggle?: () => void
  isLast?: boolean
  children?: React.ReactNode
  /** show chevron (collapsible). When false, header is non-interactive. */
  collapsible?: boolean
}

export function Step({
  index,
  state,
  title,
  subtitle,
  open,
  onToggle,
  isLast,
  children,
  collapsible = true,
}: StepProps) {
  const isOpen = open ?? state === 'active'
  const showContent = isOpen && children !== undefined

  return (
    <div className="relative">
      {/* Vertical connector */}
      {!isLast && (
        <span
          aria-hidden
          className={cn(
            'absolute left-[15px] top-8 -bottom-2 w-px',
            state === 'done'
              ? 'bg-success/60'
              : state === 'active'
                ? 'bg-gradient-to-b from-success/60 via-border to-border'
                : 'bg-border',
          )}
        />
      )}

      <div className="flex gap-4">
        {/* Numbered indicator */}
        <div className="relative z-10 shrink-0 pt-0.5">
          <div
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-full border text-xs font-medium transition-colors',
              state === 'done' &&
                'border-success bg-success text-success-foreground',
              state === 'active' &&
                'border-success bg-success/15 text-success ring-4 ring-success/15',
              state === 'pending' &&
                'border-border bg-muted text-muted-foreground',
            )}
          >
            {state === 'done' ? <Check className="h-4 w-4" /> : index}
          </div>
        </div>

        {/* Card */}
        <div className="flex-1 pb-6">
          <button
            type="button"
            onClick={collapsible ? onToggle : undefined}
            disabled={!collapsible}
            className={cn(
              'group flex w-full items-center justify-between gap-4 rounded-lg text-left',
              collapsible && 'cursor-pointer',
            )}
          >
            <div className="min-w-0 flex-1">
              <h3
                className={cn(
                  'truncate text-sm font-medium leading-6 tracking-tight',
                  state === 'pending'
                    ? 'text-muted-foreground'
                    : 'text-foreground',
                )}
              >
                {title}
              </h3>
              {subtitle && (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {subtitle}
                </p>
              )}
            </div>
            {collapsible && children !== undefined && (
              <ChevronDown
                className={cn(
                  'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
                  isOpen && 'rotate-180',
                )}
              />
            )}
          </button>

          {showContent && (
            <div className="mt-4 overflow-hidden rounded-xl border border-border/70 bg-card">
              {children}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

interface StepperProps {
  children: React.ReactNode
  className?: string
}

export function Stepper({ children, className }: StepperProps) {
  return <div className={cn('flex flex-col', className)}>{children}</div>
}
