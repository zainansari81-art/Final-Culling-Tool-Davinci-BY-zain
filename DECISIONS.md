# DECISIONS.md — short ADRs for the Wedding Culling Tool

Why-we-did-it-this-way notes. Each entry is one trade-off we made deliberately. Newest at the top.

---

## 2026-04-30 — Hybrid AI grading, not pure AI

**Decision:** Run cheap metrics first; only call Claude vision on segments that survived the metric filter. Blend AI score with metric score (50/50 default).

**Why:**
- Pure AI on every clip = ~$15-30 of Claude subscription burn per wedding (200-400 clips × $0.05/call). Too expensive for routine use.
- Metrics catch obvious failures (severely shaky, blurry, dark) reliably without judgment. No reason to waste an AI call on those.
- The interesting decisions ARE creative (workhorse vs hero, b-roll quality, "is this composition working") — that's where AI earns its keep.
- Hybrid: metrics filter ~40% of obvious rejects → AI only sees the ~60% worth a creative read → ~$5-10/wedding instead of $15-30.

**Trade-off accepted:** AI is non-deterministic by ~1 point per call. Same clip might score 7 one run, 8 next. We chose creativity over repeatability.

---

## 2026-04-30 — B-roll qualifies for highlights without faces

**Decision:** Highlight quality score uses `0.30 stability + 0.28 sharpness + 0.14 exposure + 0.18 visual_richness + face_bonus`. Visual richness (saturation + contrast) is what lets b-roll qualify on its own.

**Why:**
- Wedding highlights aren't only people-shots. Rings, decor, drone aerials, dance lights, venue, food are essential bridge material.
- Earlier draft was face-centric; would have downgraded gorgeous b-roll just because no face was present. User explicitly flagged this.
- Saturation + contrast captures "visually interesting" without semantic understanding.

**Trade-off accepted:** A boring shot that happens to be sharp + colorful could pass. Mitigated by requiring high stability + sharpness + good exposure together.

---

## 2026-04-30 — Sub-clip extraction over whole-clip approve/reject

**Decision:** In deep mode, scoring runs on rolling 5-second windows. The output is per-clip *sub-segments* (the usable portions of long clips), not just an approve/reject flag on the whole clip.

**Why:**
- Real wedding footage is messy. A 5-min clip can have 30 great seconds and 4 bad minutes. Whole-clip cull means either you keep all 5 minutes or you keep none — neither matches what an editor actually does.
- Sub-segments let us put just the good 30 seconds on the timeline using frame-accurate in/out points (computed from clip fps).
- The `is_highlight` flag operates on sub-segments, not clips, so the Highlights timeline can mix segments from different parts of different clips.

**Trade-off accepted:** ~2-3× analysis time vs shallow mode. Acceptable for quality of result.

---

## 2026-04-30 — Coverage clustering via dense perceptual hashing, not filename heuristics

**Decision:** To detect multi-camera coverage of the same moment (the Spingle trick), hash every clip every 5s and pair-wise compare hashes across clips. Pairs above 35% mutual-match overlap link → connected components = coverage clusters.

**Why:**
- Filename-based dedup misses real coverage (`C001_A.mp4` and `dd2_1753.MP4` could be the same moment from different cams).
- Single-frame hashing per clip misses coverage when the cameras roll for different durations.
- Dense per-time-window hashing catches "same moment, different angle" reliably.
- Within a cluster, the auto-cull keeps the BEST take (lowest combined shake+blur).

**Trade-off accepted:** O(N²) pairwise comparison. At 200-400 clips this is still cheap (microseconds per hash compare).

---

## 2026-04-30 — Style profiles via reference video analysis, not user-tunable sliders

**Decision:** Editor style is captured by extracting percentile stats from cuts in fully-edited reference videos. The profile then shifts thresholds at job start.

**Why:**
- "What looks good for a wedding video" is editor-specific. Cinematic vs documentary vs bright/airy vs moody all need different thresholds.
- Asking the user to tune `shake_threshold=0.62`, `blur_threshold=0.58` is a UX dead end. They don't think in those terms.
- Editors DO know their own past work. Pointing the tool at 2-3 finished films lets us derive thresholds automatically.
- PySceneDetect treats every cut as "a shot the editor chose" — high signal training data.

**Trade-off accepted:** This is statistical style match, not perceptual. Captures pacing/quality/aesthetic but not "always cut to the bride's mom." Style match is one tool, not the whole answer.

---

## 2026-04-29 — Don't push to main; use auto-cull branch

**Decision:** All Claude-driven feature work lives on `auto-cull`. `main` belongs to Mustafa.

**Why:**
- Two collaborators on the same repo, doing different things. Mustafa is iterating on UI/UX (theme, wizard, video preview). Claude is building the analysis pipeline.
- Force-pushing to main when the other person is working there destroys their work.
- Branch lets either side iterate fast; PR auto-cull → main when the user reviews the diff and decides.

**Trade-off accepted:** Need to manually pull main into auto-cull periodically to stay in sync. So far Mustafa's commits have been UI-only and merge cleanly.

---

## 2026-04-29 — `claude -p` subprocess + clean env, not direct Anthropic API

**Decision:** AI grading spawns `claude -p` as a child process with `CLAUDE_CODE_OAUTH_TOKEN` set, *all other inherited `CLAUDE_CODE_*` env vars stripped*.

**Why:**
- User has Claude.ai subscription (OAuth token), not API key. SDK auth path doesn't apply.
- `claude -p` works with OAuth tokens directly. Subprocess is slower (~3-5s per call) but works with the user's existing setup.
- The env-stripping: when launched from a Terminal opened inside Claude Desktop, the parent leaks `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` etc., which tells the child claude to defer auth to a host that isn't there → "claude exited 1" with no error. Stripping fixes it.

**Trade-off accepted:** ~3-5s per call instead of ~1-2s for direct API. Mitigated by 4-way parallelism + frame cache.

---

## 2026-04-29 — Frame hash cache, not URL/path cache

**Decision:** AI grade cache key = SHA256 of the JPEG bytes sent to Claude. Stored at `~/.wedding-culling/ai_cache.json`.

**Why:**
- Same frame might appear in multiple sub-segments (boundary cases).
- Same clip re-analyzed at different sub_step_sec might generate slightly different middle frames — those should re-grade.
- Same exact JPEG bytes always have the same content; hash collision-free for our scale.
- Cheap (one hash per call), survives renames/moves/copies.

**Trade-off accepted:** Cache grows with every distinct frame. Realistically <100MB after several weddings.

---

## 2026-04-29 — Local-only video, never cloud upload

**Decision:** All analysis runs on the Mac. The Claude API only sees individual JPEG frames (downsampled to 1280px wide), never source video.

**Why:**
- Wedding footage is 500GB-1TB. Uploading is impractical and expensive.
- Privacy — clients' raw footage stays on the photographer's machine.
- DaVinci Resolve scripting only works with a local Resolve instance anyway.
- Apple Silicon hardware decoding is faster than any reasonable cloud GPU.

**Trade-off accepted:** Mac must be awake during analysis. Asleep = queued. Acceptable for a single-photographer workflow.
