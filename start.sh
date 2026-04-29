#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Starting Wedding Culling Tool..."
echo ""

# ── Backend ───────────────────────────────────────────────────────────────
echo "[1/2] Starting Python backend on http://localhost:8000 ..."
cd "$SCRIPT_DIR/backend"
python3 -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload &
BACKEND_PID=$!
echo "      Backend PID: $BACKEND_PID"

# Give the backend a moment to bind before starting the frontend
sleep 1

# ── Frontend ──────────────────────────────────────────────────────────────
echo "[2/2] Starting Vite dev server on http://localhost:5173 ..."
cd "$SCRIPT_DIR/frontend"
npm run dev

# If the frontend exits (e.g. Ctrl+C), clean up the backend too
kill $BACKEND_PID 2>/dev/null || true
