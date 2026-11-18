#!/usr/bin/env bash
# CI:把 sibling 依赖 ContinuoTerminal 检出到工作区同级目录(package.json 的 file:../ContinuoTerminal/...),
# 并固定到 .continuo-terminal-ref 记录的 commit —— 不再跟随其默认分支的最新提交,
# 避免 sibling 仓库被推入未审查代码后静默进入本仓 CI / 构建。
# 在仓库根目录执行。
set -euo pipefail

ref="$(tr -d '[:space:]' < .continuo-terminal-ref)"
if [[ ! "$ref" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::.continuo-terminal-ref 不是 40 位 commit SHA" >&2
  exit 1
fi

dest=../ContinuoTerminal
git clone --depth 1 https://github.com/philip1974/ContinuoTerminal.git "$dest"
# 浅克隆只有默认分支 tip,按 SHA 单独浅取记录的 commit 再检出。
git -C "$dest" fetch --depth 1 origin "$ref"
git -C "$dest" checkout --detach "$ref"
test "$(git -C "$dest" rev-parse HEAD)" = "$ref"
echo "ContinuoTerminal pinned at $ref"
