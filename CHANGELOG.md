# CHANGELOG

Sequential what-changed-when at the file level, newest at the top.

---

## c623b4a — UI: Deep + AI toggles on the new-job wizard
**2026-04-30 · auto-cull**
- `frontend/src/types.ts` — `CreateJobRequest` gains `deep_analysis` + `cull_policy`
- `frontend/src/pages/HomePage.tsx` — Analysis Options panel with Deep / AI checkboxes, dynamic button text, state plumbing through to API call
- Frontend npm install fix needed on first pull (Mustafa's commit added `@tailwindcss/vite` but the lockfile didn't propagate)

## e37c44f — Hybrid AI grading: Claude vision rates each sub-segment
**2026-04-30 · auto-cull**
- New `backend/ai_grader.py` — frame hash cache + thread-pooled Claude calls + clean-env subprocess
- New `backend/probe_ai.py` — single-frame probe script for testing
- `backend/models.py` — `SubClipSegment` gets `ai_score`, `ai_shot_type`, `ai_issues`, `ai_subject`, `ai_why`. `CullPolicy` gets `ai_grading`, `ai_max_concurrent`, `ai_timeout_sec`, `ai_blend_weight`, `ai_min_score_to_keep`
- `backend/analyzer.py` — wires AI grading after metric cull, blends `ai_score` into `highlight_quality`, re-evaluates `is_highlight`
- `backend/resolve_export.py` — Highlights timeline ranks by `ai_score` (with metric fallback)
- Verified on Mackenzie & Drew footage: hero portrait 8/10, b-roll workhorses 6-7/10, first-dance reaction 8/10

## 93d4c55 — Style profiles: learn editor style from reference videos
**2026-04-30 · auto-cull**
- New `backend/style.py` — `extract_style_profile()` runs PySceneDetect on each reference, scores every shot, aggregates percentile stats. `apply_style_to_policy()` shifts CullPolicy thresholds.
- `backend/models.py` — `StyleProfile`, `StyleProfileRequest`. `CreateJobRequest` gains `style_profile_id`
- `backend/main.py` — `POST/GET/DELETE /style-profiles`, persists to `~/.wedding-culling/style_profiles.json`

## 184430e — Highlight-grade detection: face shots AND b-roll qualify
**2026-04-30 · auto-cull**
- `backend/models.py` — `SubClipSegment` gets `highlight_quality`, `is_highlight`, `face_frames`. `CullPolicy` gets `detect_highlights`, `highlight_quality_threshold`, `highlight_min_duration_sec`, `highlight_require_face`, `highlight_face_bonus`, `highlight_max_total_minutes`
- `backend/analyzer.py` — Haar cascade face detection, `_frame_richness()` (saturation + contrast), `_highlight_quality()` blends stability/sharpness/exposure/richness with face bonus
- `backend/resolve_export.py` — second timeline named "Highlights" with only `is_highlight=True` segments, ranked best first

## 003daa1 — Deep analysis: sliding-window sub-clip scoring + coverage clustering
**2026-04-30 · auto-cull**
- `backend/models.py` — `SubClipSegment`, `CullPolicy.deep_analysis` + tunables (sub_window_sec, sub_step_sec, sub_min_segment_sec, coverage_*)
- `backend/analyzer.py` — `analyze_clip_deep()` (windowed scoring), `cluster_by_coverage()` (cross-clip dHash union-find). `analyze_folder` branches on `policy.deep_analysis`. `apply_cull` respects sub_segments.
- `backend/main.py` — `CreateJobRequest.deep_analysis` convenience flag
- `backend/resolve_export.py` — uses sub-segment in/out points (frame-accurate via clip fps), falls back to whole-clip when sub_segments not present

## b31f177 — Fix false-flag in approve-all + score distribution log
**2026-04-30 · auto-cull**
- `backend/main.py` — `approve_all` literally approves every clip (was rejecting anything with shake/blur >= 0.4 — way too tight for handheld wedding work). New `reject_all` for clean-slate workflow.
- `backend/analyzer.py` — score distribution dump after every analysis run (min/p25/p50/p75/p90/max for shake & blur, exposure_ok ratio, duration stats) so we can see what real footage scores

## a2facc1 — Real auto-cull pass: actually drops bad takes, keeps best of duplicates
**2026-04-30 · auto-cull (force-pushed off main per user instruction)**
- `backend/models.py` — `CullPolicy`, `CullReason`, `CullStats`. `ClipReview` gets `cull_reason`. `AnalysisJob` gets `cull_policy`, `cull_stats`. New `RecullRequest`.
- `backend/analyzer.py` — `apply_cull()` runs after duplicate detection, sets approved/cull_reason per policy, picks best take per duplicate group
- `backend/main.py` — `POST /jobs/{id}/cull` for re-tuning thresholds without re-analysis. `CreateJobRequest.cull_policy` accepts an explicit policy.

## 4c2ff3d (main, Mustafa) — Frontend rebuild + backend video streaming + M1 dial-down
**2026-04-30 · main**
- Dark theme + Inter, Tailwind v4 + shadcn (16 ui primitives, components.json)
- HomePage stepped wizard with inline FolderBrowser, recent-jobs sidebar, live LogPane
- JobPage redesigned shell, Tabs filters, segment sidebar, paginated grid
- ClipCard thumbnail click → VideoPreview dialog with HTML5 video, inline mini score bars
- ExportModal as shadcn Dialog
- ProgressPage with progress bar + ETA + 3-step indicator + LogPane
- Backend: `included_files` for partial folder, `/fs/list`, `/clips/{job_id}/{clip_id}` HTTP Range stream, `/jobs/{id}/logs` per-job ring buffer
- Analyzer: `MAX_WORKERS 4 → 2`, `ENABLE_SCENE_DETECTION = False` (~30-40% faster on M1 Air 8GB)

## 793c7c9 (main, Claude initial) — Initial Wedding Footage Culling Tool
**2026-04-29 · main**
- Backend: FastAPI + analyzer.py (PyAV keyframes + OpenCV shake/blur + dedupe + segment classification), resolve_export.py (DaVinci scripting), fcpxml_export.py, main.py (REST API), models.py
- Frontend: React + Vite + TypeScript, Home/Progress/Review pages
- start.sh launcher, README.md, requirements.txt
