# Wedding Culling Tool — DaVinci Resolve Plugin

Operator-facing reference. Source of truth for install, run, build, sign, test, fix.

---

## 1. Install

Fast path. Run from repo root.

```
python3 plugin/install.py
```

Uninstall.

```
python3 plugin/install.py --uninstall
```

Installer copies `plugin/CullingTool.py` to the Resolve scripts dir for the host OS.

| OS      | Target                                                                                              |
| ------- | --------------------------------------------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Edit/`              |
| Windows | `%APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Edit\`                          |
| Linux   | `~/.local/share/DaVinciResolve/Fusion/Scripts/Edit/`                                                |

Quit and reopen Resolve so the menu re-scans.

---

## 2. Two integration modes

The repo ships two ways to drive Resolve. Pick one or run both side-by-side.

### a) Workspace > Scripts (free Resolve + Studio)

- Single file: `plugin/CullingTool.py`.
- Installed via `plugin/install.py`.
- Triggered from: `Workspace > Scripts > Edit > CullingTool`.
- Action: pulls the latest `done` job from the backend and pushes it into the active Resolve project (Tk dialog asks near-miss / rejected / new-timeline-vs-append).
- Works on free Resolve **only when** External scripting is set to `Local` (see section 4).

### b) Workflow Integration panel (Studio only)

- Directory: `plugin/workflow-integration/` (`manifest.xml` + `index.html`).
- Embeds the Vite frontend (`http://127.0.0.1:5173`) inside a Resolve panel via iframe.
- Studio-only — free Resolve disables Workflow Integrations.
- Install by copying the directory into:

| OS      | Target                                                                                                    |
| ------- | --------------------------------------------------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins/CullingTool/` |
| Windows | `%APPDATA%\Blackmagic Design\DaVinci Resolve\Workflow Integration Plugins\CullingTool\`                   |
| Linux   | `~/.local/share/DaVinciResolveWorkflowIntegrationPlugins/CullingTool/`                                    |

Open with: `Workspace > Workflow Integrations > Wedding Culling Tool`.

---

## 3. End-to-end first run

Backend must be up before any Resolve action. Start it via the menu-bar launcher (shipped builds) or `bash start.sh` (dev).

### 3.1 Start services (dev)

```
bash start.sh
```

Backend on `http://127.0.0.1:8000`, frontend on `http://127.0.0.1:5173`.

### 3.2 Onboarding wizard (frontend)

Open `http://127.0.0.1:5173`. First-run wizard gates the rest of the UI.

Pick one provider:

**Gemini AI Studio (recommended for solo users)**

1. Paste API key into the wizard.
2. Click **Test** — frontend POSTs `/onboarding/test`.
3. Click **Save** — frontend POSTs `/onboarding/save` (key persists in OS keychain).
4. Provider selection POSTs `/onboarding/select` with `{ "provider": "gemini" }`.

**Vertex AI (Google Cloud service account)**

1. Paste project ID + region.
2. Upload service-account JSON.
3. Click **Test** — frontend POSTs `/onboarding/vertex/test`.
4. Click **Save** — frontend POSTs `/onboarding/vertex/save`.
5. Provider selection POSTs `/onboarding/select` with `{ "provider": "vertex" }`.

### 3.3 Analyze a folder

1. New Project (frontend).
2. Pick footage folder.
3. Run analysis. Wait for job status `done`.

### 3.4 Push to Resolve

Two options:

- **Frontend button**: directly POSTs `/jobs/{id}/resolve/push`.
- **Resolve menu**: `Workspace > Scripts > Edit > CullingTool` opens a Tk dialog (counts of approved / near-miss / rejected) → click **Push**. Same endpoint.

Result dialog reports `clips_added`, `clips_skipped`, `timeline_name`, `project_name`.

---

## 4. Resolve preferences

The one toggle every user must flip:

```
DaVinci Resolve > Preferences > System > General >
  External scripting using = Local
```

Without this, free Resolve refuses script connections and the Tk dialog will fail to find the project. Studio respects the same toggle.

Restart Resolve after changing.

---

## 5. Build the bundle (developer-only)

PyInstaller spec lives at `installer/culling-backend.spec`. Entry: `installer/run_backend.py`.

### 5.1 Build the backend binary

```
pyinstaller installer/culling-backend.spec --noconfirm
```

Output:

```
dist/
  culling-backend/
    culling-backend            # macOS/Linux executable
    culling-backend.exe        # Windows (when built on Windows)
    _internal/                 # PyInstaller bundled libs + datas
```

Run standalone:

```
./dist/culling-backend/culling-backend
```

Honors `CULL_HOST` and `CULL_PORT` env vars. Defaults to `127.0.0.1:8000`. Default `AI_BACKEND=cloud`.

### 5.2 Ship the menu-bar launcher

`installer/launcher.py` is the user-facing entry. It owns the backend subprocess and exposes a tray menu (Open Web UI / Open API docs / Restart backend / Quit).

The launcher discovers the backend in this order:

1. `CULL_BACKEND_BIN` env override.
2. `<launcher_dir>/culling-backend/culling-backend(.exe)`.
3. `<launcher_dir>/run_backend.py` via current Python (dev fallback).

Build the launcher into a windowed app:

```
# TODO verify exact flags for shipped builds
pyinstaller --noconfirm --windowed --name CullingTool installer/launcher.py
```

Layout to ship to end users:

```
CullingTool.app/                     (or CullingTool.exe + folder on Windows)
  Contents/MacOS/CullingTool         (launcher binary)
  Contents/Resources/culling-backend/
    culling-backend
    _internal/...
```

Place the `culling-backend/` directory next to the launcher binary so step 2 of discovery resolves.

---

## 6. Signing & notarization

Required for distribution. macOS Gatekeeper rejects unsigned `.app`s; Windows SmartScreen warns on unsigned `.exe`s.

### 6.1 macOS — Apple Developer ID

Prereqs: Apple Developer ID Application certificate in login keychain, app-specific password stored via `notarytool`.

Sign the launcher and the embedded backend.

```
codesign --deep --force --options runtime \
  --entitlements installer/entitlements.plist \
  --sign "Developer ID Application: <YOUR NAME> (<TEAMID>)" \
  dist/CullingTool.app
```

```
codesign --verify --deep --strict --verbose=2 dist/CullingTool.app
```

Notarize.

```
xcrun notarytool submit dist/CullingTool.zip \
  --keychain-profile "<NOTARY_PROFILE>" \
  --wait
```

```
xcrun stapler staple dist/CullingTool.app
```

```
spctl --assess --type execute --verbose=4 dist/CullingTool.app
```

`# TODO verify` — `installer/entitlements.plist` is referenced but not yet committed; create with `com.apple.security.cs.allow-unsigned-executable-memory` if PyInstaller bootloader requires it.

### 6.2 Windows — EV code-signing certificate

Prereqs: EV cert on hardware token, `signtool.exe` from the Windows SDK.

```
signtool sign /tr http://timestamp.digicert.com /td sha256 /fd sha256 ^
  /a dist\CullingTool\CullingTool.exe
```

```
signtool verify /pa /v dist\CullingTool\CullingTool.exe
```

Sign the backend exe too.

```
signtool sign /tr http://timestamp.digicert.com /td sha256 /fd sha256 ^
  /a dist\CullingTool\culling-backend\culling-backend.exe
```

---

## 7. Testing matrix

Run this checklist before every release. Each cell = full first-run flow (sections 3.1–3.4).

| Resolve version | Edition | macOS (Apple Silicon) | macOS (Intel) | Windows 10/11 |
| --------------- | ------- | --------------------- | ------------- | ------------- |
| 18.6            | Free    | [ ]                   | [ ]           | [ ]           |
| 18.6            | Studio  | [ ]                   | [ ]           | [ ]           |
| 19.x            | Free    | [ ]                   | [ ]           | [ ]           |
| 19.x            | Studio  | [ ]                   | [ ]           | [ ]           |

Per cell, verify:

- [ ] `python3 plugin/install.py` lands `CullingTool.py` in correct dir.
- [ ] Resolve menu shows `Workspace > Scripts > Edit > CullingTool`.
- [ ] External scripting = Local toggled (section 4).
- [ ] Onboarding wizard accepts Gemini key, `/onboarding/test` returns ok.
- [ ] Onboarding wizard accepts Vertex SA JSON, `/onboarding/vertex/test` returns ok.
- [ ] Folder analysis completes to `done`.
- [ ] Tk push dialog opens, shows correct approved/near-miss/rejected counts.
- [ ] Push creates new timeline; clips_added > 0.
- [ ] Push in append mode adds to active timeline.
- [ ] Studio only: Workflow Integration panel loads frontend in iframe.
- [ ] Studio only: fallback message appears if backend killed mid-session.

---

## 8. Troubleshooting

### 8.1 "Couldn't reach the Wedding Culling backend"

**Cause**: Backend not running or crashed.
**Fix**: Open menu-bar launcher → status should read `Backend up`. If grey, click **Restart backend**. Dev: re-run `bash start.sh`. Probe: `curl http://127.0.0.1:8000/ai/info`.

### 8.2 "No completed jobs yet"

**Cause**: No job has reached status `done`. Tk script only pushes the latest done job.
**Fix**: Open frontend, run an analysis to completion, retry `Workspace > Scripts > Edit > CullingTool`.

### 8.3 Push fails with "External scripting not enabled" / project handle null

**Cause**: External scripting preference is `None` (default on free Resolve).
**Fix**: Section 4 — set External scripting using = `Local`, restart Resolve.

### 8.4 Workflow Integration panel shows "Backend not reachable" fallback

**Cause**: Frontend (`:5173`) or API (`:8000`) didn't respond within 4 s of the iframe loading.
**Fix**: Confirm both ports listening. In packaged builds the launcher only starts the API; the frontend is served by the bundled API at the same port — `# TODO verify final packaging serves frontend assets`. Click **Refresh** in the fallback once services are up.

### 8.5 Resolve menu does not show CullingTool after install

**Cause**: Menu cached from previous session.
**Fix**: Fully quit Resolve (not just close window), reopen. Verify file landed:

```
ls "$HOME/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Edit/CullingTool.py"
```

### 8.6 Port 8000 already in use

**Cause**: Stale backend or another app bound to 8000.
**Fix**: Set `CULL_PORT` before launching:

```
CULL_PORT=8010 ./dist/culling-backend/culling-backend
```

Frontend currently hardcodes `127.0.0.1:8000` — `# TODO verify` whether `CULL_PORT` override propagates to the embedded iframe.
