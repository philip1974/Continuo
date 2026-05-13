#!/usr/bin/env bash
# relaunch: graceful quit running Continuo.app → build:app → open the fresh build.
# 用 osascript 而非 pkill,走 Electron before-quit/will-quit 钩子,允许窗口状态/
# explorer.json 正常落盘。pgrep 轮询确认进程真退出,避免 builder 撞 EBUSY。
set -euo pipefail

APP_NAME="Continuo"
APP_PATH="dist-electron/mac-arm64/${APP_NAME}.app"

if pgrep -x "$APP_NAME" >/dev/null; then
  echo "[relaunch] quitting running ${APP_NAME}.app..."
  osascript -e "tell application \"${APP_NAME}\" to quit" || true
  # 等真退出(最多 10s),否则 electron-builder 会撞 EBUSY。
  for _ in $(seq 1 50); do
    pgrep -x "$APP_NAME" >/dev/null || break
    sleep 0.2
  done
  if pgrep -x "$APP_NAME" >/dev/null; then
    echo "[relaunch] still running after 10s, force kill"
    pkill -x "$APP_NAME" || true
    sleep 0.5
  fi
fi

echo "[relaunch] building..."
pnpm build:app

echo "[relaunch] launching ${APP_PATH}..."
open "$APP_PATH"
