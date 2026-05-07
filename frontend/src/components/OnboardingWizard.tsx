import { useState } from 'react'
import { CheckCircle2, Cog, ExternalLink, Key, Loader2, ShieldAlert, Sparkles } from 'lucide-react'
import { api } from '../api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface Props {
  onDone: () => void
}

type Stage =
  | 'pick'
  | 'gemini-intro' | 'gemini-paste' | 'gemini-testing' | 'gemini-saving' | 'gemini-error'
  | 'vertex-intro' | 'vertex-paste' | 'vertex-testing' | 'vertex-saving' | 'vertex-error'
  | 'done'

type Provider = 'gemini' | 'vertex' | null

const AI_STUDIO_URL = 'https://aistudio.google.com/apikey'
const GCP_IAM_URL = 'https://console.cloud.google.com/iam-admin/serviceaccounts'

function safeError(e: unknown, fallback: string): string {
  if (e instanceof Error) {
    const msg = e.message || ''
    if (/network|timeout|fetch|ECONN|ENOTFOUND/i.test(msg)) {
      return 'Network error reaching the backend.'
    }
    if (msg.length > 0 && msg.length < 240) return msg
  }
  return fallback
}

export default function OnboardingWizard({ onDone }: Props) {
  const [stage, setStage] = useState<Stage>('pick')
  const [provider, setProvider] = useState<Provider>(null)
  const [error, setError] = useState('')

  // Gemini state
  const [apiKey, setApiKey] = useState('')

  // Vertex state
  const [projectId, setProjectId] = useState('')
  const [region, setRegion] = useState('us-central1')
  const [saJson, setSaJson] = useState('')

  const pickGemini = async () => {
    setError('')
    setProvider('gemini')
    try {
      await api.onboardingSelect('gemini')
    } catch {
      // non-fatal; proceed to intro anyway
    }
    setStage('gemini-intro')
  }

  const pickVertex = async () => {
    setError('')
    setProvider('vertex')
    try {
      await api.onboardingSelect('vertex')
    } catch {
      // non-fatal
    }
    setStage('vertex-intro')
  }

  const openAiStudio = () => {
    window.open(AI_STUDIO_URL, '_blank', 'noopener,noreferrer')
    setStage('gemini-paste')
  }

  const openGcpIam = () => {
    window.open(GCP_IAM_URL, '_blank', 'noopener,noreferrer')
    setStage('vertex-paste')
  }

  const validateAndSaveGemini = async () => {
    setError('')
    const key = apiKey.trim()
    if (key.length < 30 || !key.startsWith('AIza')) {
      setError("That doesn't look like a Google AI Studio key. They start with 'AIza' and are at least 30 characters.")
      setStage('gemini-error')
      return
    }
    setStage('gemini-testing')
    try {
      const test = await api.onboardingTest(key)
      if (!test.ok) {
        setError(test.error ?? 'Validation failed. Try again.')
        setStage('gemini-error')
        return
      }
      setStage('gemini-saving')
      await api.onboardingSave(key)
      setStage('done')
      setTimeout(onDone, 700)
    } catch (e: unknown) {
      setError(safeError(e, 'Could not validate the API key.'))
      setStage('gemini-error')
    }
  }

  const validateAndSaveVertex = async () => {
    setError('')
    const pid = projectId.trim()
    const reg = region.trim() || 'us-central1'
    const sa = saJson.trim()
    if (!pid) {
      setError('Project ID is required.')
      setStage('vertex-error')
      return
    }
    if (!sa) {
      setError('Service account JSON is required.')
      setStage('vertex-error')
      return
    }
    try {
      const parsed = JSON.parse(sa)
      if (!parsed || typeof parsed !== 'object' || !parsed.client_email) {
        setError("That doesn't look like a service-account JSON (missing client_email).")
        setStage('vertex-error')
        return
      }
    } catch {
      setError('Service account JSON is not valid JSON.')
      setStage('vertex-error')
      return
    }
    setStage('vertex-testing')
    const creds = { project_id: pid, region: reg, service_account_json: sa }
    try {
      const test = await api.onboardingVertexTest(creds)
      if (!test.ok) {
        setError(test.error ?? 'Validation failed. Check project, region, and credentials.')
        setStage('vertex-error')
        return
      }
      setStage('vertex-saving')
      await api.onboardingVertexSave(creds)
      setStage('done')
      setTimeout(onDone, 700)
    } catch (e: unknown) {
      setError(safeError(e, 'Could not validate Vertex credentials.'))
      setStage('vertex-error')
    }
  }

  const isGeminiPasteView =
    stage === 'gemini-paste' ||
    stage === 'gemini-testing' ||
    stage === 'gemini-saving' ||
    stage === 'gemini-error'

  const isVertexPasteView =
    stage === 'vertex-paste' ||
    stage === 'vertex-testing' ||
    stage === 'vertex-saving' ||
    stage === 'vertex-error'

  const providerChip =
    provider === 'gemini'
      ? 'Google · Gemini'
      : provider === 'vertex'
      ? 'Google · Vertex AI'
      : 'Choose provider'

  return (
    <div className="rounded-md border border-border/40 bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">Connect Cloud AI</span>
          <Badge variant="outline" className="font-normal">
            One-time setup
          </Badge>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {providerChip}
        </span>
      </div>

      <div className="space-y-3 px-4 py-4 text-sm">
        {stage === 'pick' && (
          <>
            <p className="text-foreground/90">
              Pick a cloud backend. You can switch later from Settings.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={pickGemini}
                className="flex flex-col gap-1.5 rounded-md border border-border/60 bg-muted/20 px-3 py-3 text-left hover:border-primary/60 hover:bg-muted/40"
              >
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-primary" />
                  <span className="text-sm font-semibold">Gemini AI Studio</span>
                  <Badge variant="outline" className="ml-auto font-normal">
                    Recommended
                  </Badge>
                </div>
                <p className="text-[12px] text-muted-foreground">
                  Free tier covers a typical wedding job. Just paste an API key.
                </p>
              </button>
              <button
                type="button"
                onClick={pickVertex}
                className="flex flex-col gap-1.5 rounded-md border border-border/60 bg-muted/20 px-3 py-3 text-left hover:border-primary/60 hover:bg-muted/40"
              >
                <div className="flex items-center gap-2">
                  <Cog className="h-4 w-4 text-primary" />
                  <span className="text-sm font-semibold">Vertex AI + GCP</span>
                  <Badge variant="outline" className="ml-auto font-normal">
                    Advanced
                  </Badge>
                </div>
                <p className="text-[12px] text-muted-foreground">
                  Use a GCP service account. Higher quotas, billing on your project.
                </p>
              </button>
            </div>
          </>
        )}

        {stage === 'gemini-intro' && (
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
              <button
                type="button"
                onClick={() => setStage('pick')}
                className="ml-auto text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Back
              </button>
            </div>
          </>
        )}

        {isGeminiPasteView && (
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
                disabled={stage === 'gemini-testing' || stage === 'gemini-saving'}
                className={cn(
                  'flex-1 rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-[12px]',
                  'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary',
                  stage === 'gemini-error' && 'border-destructive focus:ring-destructive',
                )}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') validateAndSaveGemini()
                }}
              />
              <Button
                onClick={validateAndSaveGemini}
                disabled={!apiKey.trim() || stage === 'gemini-testing' || stage === 'gemini-saving'}
              >
                {stage === 'gemini-testing' ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Testing…
                  </>
                ) : stage === 'gemini-saving' ? (
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
            {stage === 'gemini-error' && error && (
              <div className="rounded border border-destructive/50 bg-destructive/10 px-2.5 py-2 text-[12px] text-destructive">
                {error}
              </div>
            )}
            <div className="flex items-center gap-3">
              {stage !== 'gemini-error' && (
                <button
                  type="button"
                  onClick={openAiStudio}
                  className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  Re-open Google AI Studio
                </button>
              )}
              <button
                type="button"
                onClick={() => setStage('pick')}
                className="ml-auto text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Switch provider
              </button>
            </div>
          </>
        )}

        {stage === 'vertex-intro' && (
          <>
            <p className="text-foreground/90">
              Vertex AI uses a GCP service account. You&apos;ll need a project with
              the Vertex AI API enabled and a service account with the{' '}
              <span className="font-medium text-foreground">Vertex AI User</span> role.
            </p>
            <ol className="space-y-1.5 pl-5 text-[13px] text-muted-foreground">
              <li>Open GCP IAM &amp; Admin → Service Accounts.</li>
              <li>Create or pick a service account; grant it Vertex AI User.</li>
              <li>Add a JSON key, download it.</li>
              <li>Paste the JSON, project ID, and region back here.</li>
            </ol>
            <div className="flex flex-wrap items-center gap-2 pt-2">
              <Button onClick={openGcpIam}>
                <ExternalLink className="h-3.5 w-3.5" />
                Open GCP IAM
              </Button>
              <span className="font-mono text-[11px] text-muted-foreground/80">
                console.cloud.google.com/iam-admin/serviceaccounts
              </span>
              <button
                type="button"
                onClick={() => setStage('pick')}
                className="ml-auto text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Back
              </button>
            </div>
          </>
        )}

        {isVertexPasteView && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <label className="text-[12px] font-medium text-foreground">Project ID</label>
                <input
                  type="text"
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  placeholder="my-gcp-project"
                  autoFocus
                  disabled={stage === 'vertex-testing' || stage === 'vertex-saving'}
                  className={cn(
                    'rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-[12px]',
                    'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary',
                    stage === 'vertex-error' && 'border-destructive focus:ring-destructive',
                  )}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-[12px] font-medium text-foreground">Region</label>
                <input
                  type="text"
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                  placeholder="us-central1"
                  disabled={stage === 'vertex-testing' || stage === 'vertex-saving'}
                  className={cn(
                    'rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-[12px]',
                    'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary',
                    stage === 'vertex-error' && 'border-destructive focus:ring-destructive',
                  )}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[12px] font-medium text-foreground">
                Service Account JSON
              </label>
              <textarea
                value={saJson}
                onChange={(e) => setSaJson(e.target.value)}
                placeholder='{ "type": "service_account", "project_id": "...", ... }'
                rows={6}
                disabled={stage === 'vertex-testing' || stage === 'vertex-saving'}
                className={cn(
                  'rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-[11px] leading-snug',
                  'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary',
                  stage === 'vertex-error' && 'border-destructive focus:ring-destructive',
                )}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={validateAndSaveVertex}
                disabled={
                  !projectId.trim() ||
                  !saJson.trim() ||
                  stage === 'vertex-testing' ||
                  stage === 'vertex-saving'
                }
              >
                {stage === 'vertex-testing' ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Testing…
                  </>
                ) : stage === 'vertex-saving' ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Saving…
                  </>
                ) : (
                  <>
                    <Cog className="h-3.5 w-3.5" />
                    Test &amp; connect
                  </>
                )}
              </Button>
              <button
                type="button"
                onClick={openGcpIam}
                className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Re-open GCP IAM
              </button>
              <button
                type="button"
                onClick={() => setStage('pick')}
                className="ml-auto text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Switch provider
              </button>
            </div>
            <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
              <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" />
              Service-account JSON is stored locally in your OS keychain. Never
              sent anywhere except Google&apos;s Vertex AI endpoint.
            </p>
            {stage === 'vertex-error' && error && (
              <div className="rounded border border-destructive/50 bg-destructive/10 px-2.5 py-2 text-[12px] text-destructive">
                {error}
              </div>
            )}
          </>
        )}

        {stage === 'done' && (
          <div className="flex items-center gap-2 rounded border border-success/40 bg-success/10 px-3 py-2 text-success">
            <CheckCircle2 className="h-4 w-4" />
            <span className="text-sm">
              {provider === 'vertex'
                ? 'Vertex AI connected. Ready to analyze.'
                : 'Connected. Ready to analyze.'}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
