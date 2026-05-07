import { useState } from 'react'
import { CheckCircle2, ExternalLink, Key, Loader2, ShieldAlert, Sparkles } from 'lucide-react'
import { api } from '../api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface Props {
  onDone: () => void
}

type Stage = 'intro' | 'paste' | 'testing' | 'saving' | 'done' | 'error'

const AI_STUDIO_URL = 'https://aistudio.google.com/apikey'

export default function OnboardingWizard({ onDone }: Props) {
  const [stage, setStage] = useState<Stage>('intro')
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState('')

  const openAiStudio = () => {
    window.open(AI_STUDIO_URL, '_blank', 'noopener,noreferrer')
    setStage('paste')
  }

  const validateAndSave = async () => {
    setError('')
    const key = apiKey.trim()
    if (key.length < 30 || !key.startsWith('AIza')) {
      setError("That doesn't look like a Google AI Studio key. They start with 'AIza' and are at least 30 characters.")
      return
    }
    setStage('testing')
    try {
      const test = await api.onboardingTest(key)
      if (!test.ok) {
        setError(test.error ?? 'Validation failed. Try again.')
        setStage('error')
        return
      }
      setStage('saving')
      await api.onboardingSave(key)
      setStage('done')
      setTimeout(onDone, 700)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Network error reaching the backend.')
      setStage('error')
    }
  }

  return (
    <div className="rounded-md border border-border/70 bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">Connect Cloud AI</span>
          <Badge variant="outline" className="font-normal">
            One-time setup
          </Badge>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          Google · Gemini
        </span>
      </div>

      <div className="space-y-3 px-4 py-4 text-sm">
        {stage === 'intro' && (
          <>
            <p className="text-foreground/90">
              The cloud engine uses Google&apos;s Gemini model. Free tier is plenty
              for typical wedding jobs (~100 clips/day).
            </p>
            <ol className="space-y-1.5 pl-5 text-[13px] text-muted-foreground [counter-reset:step]">
              <li>Click the button below to open Google AI Studio.</li>
              <li>Sign in with your Google account if asked.</li>
              <li>Click <span className="font-medium text-foreground">Create API key</span>.</li>
              <li>Copy the generated key, paste it back here.</li>
            </ol>
            <div className="flex flex-wrap items-center gap-2 pt-2">
              <Button onClick={openAiStudio}>
                <ExternalLink className="h-3.5 w-3.5" />
                Open Google AI Studio
              </Button>
              <span className="font-mono text-[11px] text-muted-foreground/80">
                aistudio.google.com/apikey
              </span>
            </div>
          </>
        )}

        {(stage === 'paste' || stage === 'error' || stage === 'testing' || stage === 'saving') && (
          <>
            <label className="block text-[12px] font-medium text-foreground">
              Paste your API key
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="AIza..."
                autoFocus
                disabled={stage === 'testing' || stage === 'saving'}
                className={cn(
                  'flex-1 rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-[12px]',
                  'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary',
                  stage === 'error' && 'border-destructive focus:ring-destructive',
                )}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') validateAndSave()
                }}
              />
              <Button
                onClick={validateAndSave}
                disabled={!apiKey.trim() || stage === 'testing' || stage === 'saving'}
              >
                {stage === 'testing' ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Testing…
                  </>
                ) : stage === 'saving' ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Saving…
                  </>
                ) : (
                  <>
                    <Key className="h-3.5 w-3.5" />
                    Connect
                  </>
                )}
              </Button>
            </div>
            <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
              <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" />
              Stored in your OS keychain (macOS Keychain / Windows Credential
              Manager). Never sent to any server other than Google.
            </p>
            {stage === 'error' && error && (
              <div className="rounded border border-destructive/50 bg-destructive/10 px-2.5 py-2 text-[12px] text-destructive">
                {error}
              </div>
            )}
            {stage !== 'error' && (
              <button
                type="button"
                onClick={openAiStudio}
                className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Re-open Google AI Studio
              </button>
            )}
          </>
        )}

        {stage === 'done' && (
          <div className="flex items-center gap-2 rounded border border-success/40 bg-success/10 px-3 py-2 text-success">
            <CheckCircle2 className="h-4 w-4" />
            <span className="text-sm">Connected. Ready to analyze.</span>
          </div>
        )}
      </div>
    </div>
  )
}
