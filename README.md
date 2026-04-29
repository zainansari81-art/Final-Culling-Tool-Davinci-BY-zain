# Wedding Video Culling Tool

A local Mac app for analysing large wedding video files (500 GB–1 TB) on an external HDD and exporting organised clips to DaVinci Resolve or FCPXML.

## Requirements

- macOS (Apple Silicon or Intel)
- Python 3.10+
- Node.js 18+
- DaVinci Resolve (free or Studio) — only needed for the Resolve export path

## Setup

### 1. Install Python dependencies

```bash
cd backend
pip install -r requirements.txt
```

> Tip: use a virtual environment to keep things tidy:
> ```bash
> python -m venv .venv && source .venv/bin/activate
> pip install -r requirements.txt
> ```

### 2. Install frontend dependencies

```bash
cd ../frontend
npm install
```

### 3. Start both servers

```bash
bash start.sh
```

This starts:
- Python/FastAPI backend on `http://localhost:8765`
- Vite dev server on `http://localhost:5173`

### 4. Open the app

Navigate to **http://localhost:5173** in your browser.

---

## How to use

1. Plug in your external HDD.
2. In the app, enter the path to your footage folder (e.g. `/Volumes/WeddingHDD/2026-04-28`).
3. Click **Analyse**. The backend will scan every video file recursively and score each clip for:
   - Shake (optical flow)
   - Blur (Laplacian variance)
   - Exposure (mean brightness)
   - Duplicates (perceptual hash)
4. Review clips and their auto-assigned wedding segments.
5. Click **Approve All** to bulk-approve everything that passes the quality thresholds.
6. Fine-tune individual approvals/rejections if needed.
7. Click **Export**:
   - **DaVinci Resolve** — Resolve must already be running. Creates a new project, bins per segment, and a "Selects" timeline with colour-coded clips.
   - **FCPXML** — Exports to `~/Desktop/{ProjectName}_{date}.fcpxml` for any NLE.

---

## DaVinci Resolve scripting setup

To use the Resolve export:

1. Open Resolve → Preferences → System → General
2. Enable **"External scripting using"** → set to **"Local"**
3. Make sure Resolve is running before you click Export in the app

---

## Architecture

```
culling-tool/
├── backend/
│   ├── main.py              # FastAPI app + all endpoints
│   ├── models.py            # Pydantic data models
│   ├── analyzer.py          # Video analysis engine (PyAV + OpenCV)
│   ├── resolve_export.py    # DaVinci Resolve export
│   ├── fcpxml_export.py     # FCPXML 1.9 fallback export
│   ├── requirements.txt
│   └── thumbnails/          # Auto-generated JPEG thumbnails
│       └── {job_id}/
│           └── {clip_id}.jpg
└── frontend/                # (built separately by frontend engineer)
```

---

## API reference for frontend engineers

### Base URL
`http://localhost:8765`

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Health check |
| POST | `/jobs` | Start analysis job |
| GET | `/jobs` | List all jobs |
| GET | `/jobs/{job_id}` | Job status + progress (0–100) |
| GET | `/jobs/{job_id}/clips` | All clips with scores |
| PATCH | `/jobs/{job_id}/clips/{clip_id}` | Update approval/segment |
| POST | `/jobs/{job_id}/approve-all` | Bulk approve quality clips |
| POST | `/export` | Export to Resolve or FCPXML |
| GET | `/thumbnails/{job_id}/{clip_id}.jpg` | Thumbnail image (static file) |

### ClipResult shape

```json
{
  "id": "uuid-string",
  "file_path": "/Volumes/HDD/clip.mp4",
  "filename": "clip.mp4",
  "duration_sec": 42.5,
  "thumbnail_path": "/thumbnails/{job_id}/{clip_id}.jpg",
  "shake_score": 0.08,
  "blur_score": 0.12,
  "exposure_score": 0.91,
  "is_duplicate": false,
  "duplicate_of": null,
  "suggested_segment": "Ceremony",
  "approved": null,
  "reject_reason": null
}
```

### Score interpretation

| Field | 0 | 1 |
|-------|---|---|
| `shake_score` | Perfectly stable | Very shaky |
| `blur_score` | Perfectly sharp | Very blurry |
| `exposure_score` | Bad exposure | Good exposure |

**Auto-reject thresholds (approve-all endpoint):**
- `shake_score > 0.15` → rejected as shaky
- `blur_score > 0.70` → rejected as blurry
- `is_duplicate = true` → rejected as duplicate

### Thumbnail URL

```
GET http://localhost:8765/thumbnails/{job_id}/{clip_id}.jpg
```

The `thumbnail_path` field on each `ClipResult` is this path relative to the API root — prepend the base URL to get a fully-qualified image URL:

```js
const thumbUrl = `http://localhost:8765${clip.thumbnail_path}`;
```

### Polling for progress

```js
// Poll until status === "done" or "failed"
const res = await fetch(`http://localhost:8765/jobs/${jobId}`);
const job = await res.json();
// job.progress: 0–100
// job.status: "queued" | "running" | "done" | "failed"
```

### Wedding segments (canonical names)

```
Groomsmen Getting Ready
Bride Getting Ready
First Look
Ceremony
Cocktail Hour
Reception / First Dance
Toasts
Drone / Aerial
Ambiance / BTS
Backup
```

Use these exact strings when sending `suggested_segment` in PATCH requests.
