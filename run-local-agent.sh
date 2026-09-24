#!/bin/bash
# Run Jev locally through ADB/UiAutomator.
# Usage: ./run-local-agent.sh "Open Gmail" [exact text] [max steps]
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

if ! command -v adb >/dev/null 2>&1; then
  echo "adb was not found on PATH. Install Android platform-tools first." >&2
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm was not found on PATH. Install pnpm first." >&2
  exit 1
fi

serial="${ADB_SERIAL:-}"
if [ -z "$serial" ]; then
  serial="$(adb devices | awk 'NR > 1 && $2 == "device" { print $1; exit }')"
fi
if [ -z "$serial" ]; then
  echo "No ready adb device found. Start the emulator and trust the device." >&2
  adb devices || true
  exit 1
fi
export ADB_SERIAL="$serial"

# The Node CLI loads .env.local/.env itself. This check provides an earlier, clearer error.
if [ -z "${TYPESAFE_API_KEY:-}" ] && [ ! -f .env.local ] && [ ! -f .env ]; then
  echo "TYPESAFE_API_KEY is not configured. Add it to .env.local or export it first." >&2
  exit 1
fi

if [ "$#" -gt 3 ]; then
  echo "Usage: $0 \"goal\" [exact text] [max steps]" >&2
  exit 2
fi

goal="${1:-}"
exact_text="${2:-}"
max_steps="${3:-10}"
if [ -z "$goal" ]; then
  echo "Usage: $0 \"goal\" [exact text] [max steps]" >&2
  exit 2
fi
if ! [[ "$max_steps" =~ ^[1-9][0-9]*$ ]] || [ "$max_steps" -gt 100 ]; then
  echo "max steps must be an integer from 1 to 100." >&2
  exit 2
fi

args=(agent --transport uiautomator --device "$serial" run "$goal" --execute --steps "$max_steps")
if [ -n "$exact_text" ]; then
  args+=(--text "$exact_text")
fi

echo "Using adb device: $serial"
echo "Goal: $goal"
pnpm "${args[@]}"
