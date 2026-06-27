// 默认终端启动参数(用户没显式传 args 时)。
//
// 旧实现无条件给 `['-l', '-i']`(对齐 iTerm `exec -l zsh`,让 zsh ZLE / autosuggestions
// 等 widget 正常启动)。但这两个 flag 是 POSIX 交互 shell 语义:
//   - Windows 默认 shell powershell.exe / cmd.exe 不识别 `-l -i` → 开终端直接失败(P0)。
//   - Linux 上 /bin/sh(dash)不支持 `-l`,自定义/未知 shell 也未必支持 → 启动异常(P1)。
// 因此只对确定支持的 login+interactive shell(zsh/bash/fish)追加,其余返回空数组,
// 由 shell 自身默认行为启动。

import type { ShellFamily } from '@continuo-terminal/shell-quote';

const POSIX_LOGIN_SHELLS = new Set(['zsh', 'bash', 'fish']);

/** 取 shell 路径的 basename(吃 `/` 与 `\`),小写并去掉 `.exe` 后缀。 */
function shellBaseName(shell: string): string {
  const idx = Math.max(shell.lastIndexOf('/'), shell.lastIndexOf('\\'));
  const base = idx >= 0 ? shell.slice(idx + 1) : shell;
  return base.toLowerCase().replace(/\.exe$/, '');
}

/** 用户未传 args 时的默认参数:仅 zsh/bash/fish 用 login+interactive,其余为空。 */
export function defaultShellArgs(shell: string): string[] {
  return POSIX_LOGIN_SHELLS.has(shellBaseName(shell)) ? ['-l', '-i'] : [];
}

/**
 * 由 shell 二进制路径推断引号族(用于终端拖拽文件时按 shell 正确引用路径)。
 * main 在创建会话时算好并写进 snapshot,renderer 不再按 navigator.platform 盲猜
 * (盲猜把 Windows 的 cmd.exe 当 PowerShell quoting → 引用错误,跨平台审计 P2)。
 */
export function shellFamilyForPath(shell: string): ShellFamily {
  const base = shellBaseName(shell);
  if (base === 'powershell' || base === 'pwsh') return 'powershell';
  if (base === 'cmd') return 'cmd';
  return 'posix';
}
