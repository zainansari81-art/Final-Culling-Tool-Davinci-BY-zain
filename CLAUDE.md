# CLAUDE.md — fresh-Claude orientation

You are a fresh Claude session being asked to continue work on the **Wedding Footage Culling Tool**. Read this entire file first; it captures everything from prior sessions that matters.

## What this is

A local Mac app that takes raw wedding video footage (typically 200-400 clips, multi-camera, on an external HDD) and produces a *culled* edit-ready output: only the usable clips, organized by wedding segment, with a Highlights timeline of the best-of-the-best moments. Exports directly to a DaVinci Resolve project (or FCPXML for Premiere/FCPX).

Inspired by Spingle.ai (which is Premiere-only) — this is Mac/Resolve-native, runs entirely local, no cloud upload of video, uses the user's existing Claude.ai subscription via OAuth for AI grading.

## Current state — branches

- **`main`** — the version Mustafa is iterating on. Frontend rebuild (dark theme, stepped wizard, log pane, video preview), backend video streaming, M1 Air dial-down. Shallow analysis only; *no* deep mode, *no* AI grading, *no* highlight detection, *no* style profiles.
- **`auto-cull`** — the version Claude (this session) has been building on top of Mustafa's `main`. Adds the full hybrid pipeline. **All recent feature work lives here.** Do NOT push new feature work to `main` — that's Mustafa's branch. PR auto-cull → main when the user reviews and approves.

To switch:
```bash
cd /Users/zain/culling-tool
git checkout auto-cull
git pull
```

## Repo layout

```
culling-tool/
├── README.md                       # public-facing usage docs
├── CLAUDE.md                       # this file
├── DECISIONS.md                    # why we made specific calls
├── CHANGELOG.md                    # sequential what-changed
├── start.sh                        # one-click launcher
├── backend/                        # FastAPI + Python
│   ├── main.py                     # routes
│   ├── analyzer.py                 # the analysis pipeline (shallow + deep)
│   ├── ai_grader.py                # Claude vision grading + cache
│   ├── style.py                    # learn editor style from reference videos
│   ├── resolve_export.py           # DaVinci Resolve scripting integration
│   ├── fcpxml_export.py            # Premiere/FCPX fallback
│   ├── models.py                   # all Pydantic models
│   ├── probe_ai.py                 # standalone single-frame AI probe
│   └── requirements.txt
└── frontend/                       # React + Vite + TS + Tailwind v4 + shadcn
    └── src/
        ├── pages/HomePage.tsx      # wizard step 1: choose footage + analysis options
        ├── pages/ProgressPage.tsx  # live progress + log pane
        ├── pages/JobPage.tsx       # review grid
        ├── components/             # FolderBrowser, ClipCard, LogPane, VideoPreview, etc.
        ├── api.ts                  # backend client
        └── types.ts                # shared types
```

## Pipeline — three modes

The pipeline modes stack: deep includes shallow, AI requires deep.

### 1. Shallow (the original Mustafa pipeline)

- Sample keyframes every 2s using `PyAV` with `skip_frame="NONREF"`
- Per clip: one `shake_score` (Farneback optical flow), one `blur_score` (Laplacian variance), one `exposure_ok`, one `duplicate_of` (dHash on the middle keyframe)
- Apply `CullPolicy` thresholds → approved/rejected per clip
- Resolve export: whole-clip append per approved clip

**Limitation: all-or-nothing.** A 5-min clip with 30 great seconds + 4 bad minutes = either the whole clip is on the timeline or none of it.

### 2. Deep (added by `auto-cull` branch)

Adds two new passes:

**a. Sliding-window sub-segment scoring** (per clip)
- Sample frames at `sub_step_sec` (default 1s)
- Score every `sub_window_sec` window (default 5s) for shake/blur/exposure
- Threshold each window; merge consecutive passing windows into segments
- Drop merged segments shorter than `sub_min_segment_sec` (default 2s)
- A clip approves if it has ANY usable sub-segment
- Resolve export: places each sub-segment on the timeline using frame-accurate in/out points (computed from the clip's fps)

**b. Coverage clustering** (across clips)
- Hash every clip every `coverage_hash_interval_sec` (default 5s)
- For each pair of clips, count fraction of mutually-near hashes (hamming ≤ `coverage_match_distance`, default 12)
- Pairs above `coverage_min_overlap` (default 35%) link → connected components form clusters
- Coverage clusters treated as duplicates for the auto-cull dedup pass — best take wins (lowest combined shake+blur)

**c. Highlight grade detection** (added in same deep pass)
- For each sub-segment, compute `highlight_quality` (0-1) blending:
  - 30% stability (1 - shake)
  - 28% sharpness (Laplacian variance ramp 25..150)
  - 14% exposure quality (peak at brightness 130)
  - 18% visual richness (saturation + contrast)
  - +`highlight_face_bonus` (default 0.15) when faces detected (Haar cascade)
- Mark `is_highlight=True` when `highlight_quality >= highlight_quality_threshold` (default 0.65) AND `duration_sec >= highlight_min_duration_sec` (default 2.0)
- Resolve export: builds a SECOND timeline named "Highlights" with only highlight segments, ranked by quality (or `ai_score` when AI is on) within each wedding segment

### 3. Deep + AI grading

After metric culling, sends one representative frame per surviving sub-segment to Claude vision via `claude -p`. Claude returns:
```json
{
  "highlight_score": 1-10,
  "shot_type": "face_closeup" | "b_roll_detail" | "drone_aerial" | "reaction" | ...,
  "issues": ["shaky" | "blurry" | "cluttered_background" | ...],
  "subject": "groom kissing bride",
  "why": "classic emotional first-dance hero moment"
}
```

- Score blends into `highlight_quality` via `ai_blend_weight` (default 0.50)
- `is_highlight` re-evaluated after blend
- Resolve Highlights timeline ranks by `ai_score` (with metric fallback)
- Frame cache: SHA256 of JPEG bytes → grade, persisted at `~/.wedding-culling/ai_cache.json` so re-runs are free
- Concurrency: thread pool, default 4 parallel Claude calls
- AI ONLY runs on metric-survivors — failed-by-metrics segments don't waste budget

## Style profiles — learn from reference edits

Feature for matching an editor's style to drive thresholds:

1. User submits 1-3 fully-edited reference wedding videos (`POST /style-profiles`)
2. Backend runs PySceneDetect on each — every detected cut = "a shot the editor chose"
3. Each shot is sampled, scored, aggregated into a `StyleProfile` with percentile stats (shot length, sharpness, shake, saturation, contrast, brightness, face ratio, highlight quality)
4. When creating a job with `style_profile_id`, `apply_style_to_policy()` shifts the `CullPolicy`:
   - `shake_threshold` → editor's shake_p75 + buffer
   - `blur_threshold` → tighter when reference is sharp
   - `sub_min_segment_sec` → editor's shortest typical shots
   - `highlight_quality_threshold` → editor's median (their ship bar)

Profiles persist to `~/.wedding-culling/style_profiles.json`.

## Key files to know

| File | Purpose | When to touch |
|---|---|---|
| `backend/analyzer.py` | All analysis logic. `analyze_folder` is the entry point; branches on `policy.deep_analysis`. | Any change to scoring, thresholds, sub-segment logic, coverage clustering, AI integration |
| `backend/ai_grader.py` | Claude vision calls + frame hash cache. Spawns `claude -p` subprocesses with cleaned env (strips parent's `CLAUDE_CODE_*` vars to avoid Claude Desktop auth interference). | AI prompt tweaks, cache changes, concurrency tuning |
| `backend/style.py` | Style profile extractor + `apply_style_to_policy()`. Uses PySceneDetect for cut detection on reference videos. | Adding new style dimensions |
| `backend/models.py` | All Pydantic models. Source of truth for shapes. | Any new data flowing through the API |
| `backend/main.py` | FastAPI routes. Job lifecycle, log streaming, exports, style profiles. | New endpoints |
| `backend/resolve_export.py` | DaVinci Resolve scripting API integration. Builds Selects + Highlights timelines. | Resolve-side changes |
| `frontend/src/pages/HomePage.tsx` | New-job wizard step 1. Folder browser + analysis options (Deep + AI checkboxes). | Adding more analysis toggles |

## How to run (developer mode)

```bash
cd /Users/zain/culling-tool

# One-time install (after fresh clone or new Python version)
cd backend && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && cd ..
cd frontend && npm install && cd ..

# Every time
bash start.sh
# → backend: http://127.0.0.1:8000
# → frontend: http://localhost:5173
```

**Python 3.14 is fine** but `pip install` needs a venv on Apple Silicon Homebrew Python (PEP 668). Don't try `pip install -r requirements.txt` in the system Python — it'll fail.

## Auth chain (this matters)

The backend's `claude -p` subprocess calls (used for AI grading + style profile extraction's Claude calls if any) authenticate via OAuth token, NOT API key:

- Token: `sk-ant-oat01-...` (1-year validity)
- Generated by `claude setup-token` (interactive)
- Read from `CLAUDE_CODE_OAUTH_TOKEN` env var when claude is spawned

**Critical bug history**: when the backend is launched from a Terminal opened inside Claude Desktop, Claude Desktop leaks `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` and similar env vars into the subprocess. The standalone `claude` CLI then tries to use the host (Desktop) for auth — which fails. The fix in `ai_grader.py` and across all spawn sites: strip every `CLAUDE_CODE_*`, `CLAUDE_AGENT_SDK_*`, `CLAUDECODE`, `AI_AGENT`, `BAGGAGE` env var before spawning, leaving only `CLAUDE_CODE_OAUTH_TOKEN` intact.

If you see "claude exited 1" with no obvious error, check this first.

## Test footage location

User has wedding footage at:
```
/Volumes/Florida 2tb/Ashley & Justin/Mackenzie & Drew/
├── Camera 1/                 # 318 raw .MP4 clips
├── Camera 2/
├── Camera 3/                 # 10 raw .MP4 clips (dd2_1748.MP4 .. dd2_1757.MP4)
├── Audio/
├── Mackenzie and Drew Ahsan Muneer.mov   # 2.5GB EDITED final cut — usable as a style reference
└── Mackenzie+Drew Notes.pdf
```

The edited `.mov` is the editor's actual final cut. Perfect material for `POST /style-profiles` to learn from.

For probing AI grading on a single clip, use `python3 backend/probe_ai.py "<path>"`.

## Verified behavior so far

Real frames from the Mackenzie & Drew wedding tested with `probe_ai.py`:

| Clip | AI score | Type | Subject | Editorial call |
|---|---|---|---|---|
| Camera 1 / C0138 | 8 | wide_venue | bride + groom rooftop city | "editorial hero portrait" |
| Camera 3 / dd2_1748 | 6-7 | b_roll_detail | candles on marble bar | "atmospheric texture cutaway" |
| Camera 3 / dd2_1753 | 7 | b_roll_detail | white rose + hydrangea aisle | "workhorse establishing" |
| Camera 3 / dd2_1757 | 8 | reaction | groom smiling at bride first dance | "classic emotional hero moment" |

Notes:
- AI is non-deterministic by ~1 point across runs (acceptable)
- Cache hit on second call: instant
- Score-7 vs 8 distinction (workhorse vs hero) tracks human editor judgment

## Known limits / open work

1. **JobPage.tsx (frontend) doesn't yet render the new fields.** `ai_score`, `ai_subject`, `ai_why`, `is_highlight`, `sub_segments` come back from the API but ClipCard doesn't show them. They're queryable via `GET /jobs/{id}` but not visible in the UI yet. Next frontend work.
2. **No StyleProfile picker in the UI.** API works (POST/GET/DELETE /style-profiles + style_profile_id in CreateJobRequest), but frontend has no upload-references-then-pick-profile flow. Curl-only for now.
3. **No music-aware highlight pacing.** Concept floated but not built — would auto-align highlight cuts to a reference song's beats.
4. **No multi-Mac coordination.** Single-Mac deployment only. The `style_profiles.json` and `ai_cache.json` live in the user's home dir, not synced.
5. **Bash 2-min timeout in `claude -p` subprocess (used by engineer subagent in agent-team)** — discovered earlier when an engineer subagent tried `pip install opencv` and hit the timeout, retried, hit it again, runaway loop. Important to know if you're going to dispatch any "verify it works" tasks that involve slow installs.
6. **Resolve scripting API requires Resolve to be open** with Preferences → System → Enable scripting API. Otherwise `resolve_export.py` raises a clear error. FCPXML works without it.

## Quick reference: API surface

```
GET    /                                  health check
GET    /fs/list?path=...                  filesystem browser

GET    /jobs                              list jobs
POST   /jobs                              create job (body: CreateJobRequest)
GET    /jobs/{id}                         full job state
GET    /jobs/{id}/progress                lightweight poll
GET    /jobs/{id}/logs?since=N            live log lines
PATCH  /jobs/{id}/clips/{clip_id}         edit one clip
POST   /jobs/{id}/cull                    re-run cull pass with new policy
POST   /jobs/{id}/approve-all             hard-approve every clip
POST   /jobs/{id}/reject-all              hard-reject every clip

POST   /jobs/{id}/export/resolve          build Resolve project
POST   /jobs/{id}/export/fcpxml           write FCPXML

GET    /clips/{job_id}/{clip_id}          source video stream (HTTP Range)
GET    /thumbnails/{job_id}/{clip_id}     keyframe thumbnail

GET    /style-profiles                    list profiles
POST   /style-profiles                    extract from reference videos
GET    /style-profiles/{id}               one profile
DELETE /style-profiles/{id}               remove
```

`CreateJobRequest` body shape:
```json
{
  "folder_path": "/Volumes/...",
  "included_files": ["...", "..."],            // optional, partial-folder subset
  "deep_analysis": true,                        // convenience flag
  "cull_policy": {                              // any field; defaults are sensible
    "deep_analysis": true,
    "ai_grading": true,
    "ai_max_concurrent": 4,
    "detect_highlights": true,
    "shake_threshold": 0.70,
    "blur_threshold": 0.70,
    "sub_window_sec": 5.0,
    "sub_step_sec": 1.0,
    "sub_min_segment_sec": 2.0,
    "highlight_quality_threshold": 0.65
  },
  "style_profile_id": "..."                     // optional, applies learned style
}
```

## Working agreements with the user

- **Don't push to `main`.** That's Mustafa's branch. New work → `auto-cull`.
- **Always commit + push after meaningful changes** — the user wants to see them live.
- **Be transparent when AI is non-deterministic or limits hit** — don't pretend.
- **Frontend toggles are preferred over curl** for any feature the user will exercise repeatedly.
- **Don't spawn anything that involves `pip install` from inside an AI-graded subagent loop** — the 2-min Bash timeout will produce a runaway retry.
