# installer/culling-backend.spec — PyInstaller spec for the FastAPI backend.
# Build with: pyinstaller installer/culling-backend.spec --noconfirm
# Output:    dist/culling-backend/   (run ./culling-backend/run_backend on the user's Mac)

from pathlib import Path
from PyInstaller.utils.hooks import collect_submodules, collect_data_files

block_cipher = None
HERE = Path(SPECPATH).resolve()
ROOT = HERE.parent
BACKEND_DIR = ROOT / "backend"

backend_modules = [
    "main",
    "ai_backend",
    "cloud_video", "cloud_gemini", "cloud_rerank", "cloud_credentials",
    "vertex_video", "vertex_gemini", "vertex_rerank",
    "local_video", "local_vlm", "local_rerank",
    "resolve_bridge", "resolve_export", "fcpxml_export", "srt_export",
    "dense_features", "stability_trim", "archetypes",
    "download_progress", "hardware_detect", "dialogue_trim",
    "whisper_transcribe", "models",
]

hiddenimports: list[str] = list(backend_modules)
hiddenimports += [
    # uvicorn lazy loaders that PyInstaller can't see statically
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.loops.uvloop",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.http.httptools_impl",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.wsproto_impl",
    "uvicorn.protocols.websockets.websockets_impl",
    "uvicorn.lifespan.on",
    "uvicorn.lifespan.off",
]
# Pull every keyring backend so the user's OS keychain works on macOS/Win/Linux.
hiddenimports += collect_submodules("keyring.backends")
# faster_whisper + ctranslate2 register transformers dynamically
hiddenimports += collect_submodules("faster_whisper")
hiddenimports += collect_submodules("ctranslate2")
# google-genai is a wrapper that imports concrete model handlers lazily
hiddenimports += collect_submodules("google.genai")

datas: list = []
# Bundle the model JSON config files, prompt files, etc.
datas += collect_data_files("faster_whisper")
datas += collect_data_files("google.genai")
datas += collect_data_files("scenedetect")

a = Analysis(
    [str(HERE / "run_backend.py")],
    pathex=[str(BACKEND_DIR)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Heavy and unused on cloud-only path; remove if a future build
        # needs them.
        "mlx", "mlx_vlm", "mlx_lm", "mlx_metal",
        "torch", "torchvision", "transformers", "datasets", "open_clip",
        "huggingface_hub.commands",
        "tkinter",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="culling-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,                # surface tracebacks during early adoption
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,            # PyInstaller picks current arch
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="culling-backend",
)
