import { ServerCrash } from 'lucide-react'

export default function BackendError() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-2xl border border-destructive/30 bg-destructive/5 p-8 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/15 text-destructive">
        <ServerCrash className="h-6 w-6" />
      </div>
      <div>
        <h2 className="text-base font-semibold tracking-tight">
          Cannot reach backend
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Start the FastAPI server, then retry.
        </p>
      </div>
      <code className="rounded-md border border-border bg-muted px-3 py-2 text-xs">
        cd backend &amp;&amp; uvicorn main:app --port 8000
      </code>
    </div>
  )
}
