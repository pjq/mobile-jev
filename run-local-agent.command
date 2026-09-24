#!/bin/bash
# Double-click this file in Finder to run a local Jev task on the first connected adb device.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

pause_on_exit() {
  status=$?
  echo
  if [ "$status" -eq 0 ]; then
    echo "Task finished successfully."
  else
    echo "Task failed (exit $status)."
  fi
  read -r -p "Press Enter to close this window..." _ || true
  exit "$status"
}
trap pause_on_exit EXIT

if ! command -v adb >/dev/null 2>&1; then
  echo "adb was not found on PATH. Install Android platform-tools first."
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm was not found on PATH. Install pnpm first."
  exit 1
fi

serial="${ADB_SERIAL:-}"
if [ -z "$serial" ]; then
  serial="$(adb devices | awk 'NR > 1 && $2 == "device" { print $1; exit }')"
fi
if [ -z "$serial" ]; then
  echo "No ready adb device found. Start the emulator and trust the device, then try again."
  adb devices || true
  exit 1
fi

export ADB_SERIAL="$serial"
echo "Using adb device: $ADB_SERIAL"

if [ -z "${TYPESAFE_API_KEY:-}" ] && [ ! -f .env.local ] && [ ! -f .env ]; then
  echo "TYPESAFE_API_KEY is not configured. Add it to .env.local or export it first."
  exit 1
fi

echo
echo "Local Jev agent"
echo "Enter a goal, for example: Find order 42"
read -r -p "Goal: " goal
if [ -z "$goal" ]; then
  echo "A goal is required."
  exit 1
fi

read -r -p "Exact text value (optional, press Enter to skip): " exact_text
read -r -p "Maximum actions [10]: " max_steps
max_steps="${max_steps:-10}"

args=(agent --transport uiautomator --device "$serial" run "$goal" --execute --steps "$max_steps")
if [ -n "$exact_text" ]; then
  args+=(--text "$exact_text")
fi

echo
echo "Starting Jev..."
pnpm "${args[@]}"
