// Shell 白名单(决策 #2,沿用 Mind)+ 默认 shell 选择(VSCode 风:$SHELL)。
// 严格白名单防止任意可执行被作为 shell 注入。

import path from 'node:path';
import os from 'node:os';

const SHELL_NAMES = [
  'zsh',
  'bash',
  'sh',
  'fish',
  // Windows
  'powershell.exe',
  'pwsh.exe',
  'cmd.exe',
  'wsl.exe',
];

const UNIX_PREFIXES = [
  '/bin/',
  '/usr/bin/',
  '/usr/local/bin/',
  '/opt/homebrew/bin/',
];

export function isAllowedShell(shellPath: string): boolean {
  const norm = path.normalize(shellPath);
  if (process.platform === 'win32') {
    const base = path.basename(norm).toLowerCase();
    return SHELL_NAMES.includes(base);
  }
  // Unix:必须是允许的前缀 + 允许的名字
  return UNIX_PREFIXES.some((pre) => {
    if (!norm.startsWith(pre)) return false;
    const name = norm.slice(pre.length);
    return SHELL_NAMES.includes(name);
  });
}

/**
 * 默认 shell:优先用户 `$SHELL`(VSCode 行为);
 * 否则平台默认(Mac/Linux 用 /bin/zsh;Windows 用 powershell.exe)。
 */
export function getDefaultShell(): string {
  if (process.platform === 'win32') return 'powershell.exe';
  const envShell = process.env['SHELL'];
  if (envShell && isAllowedShell(envShell)) return envShell;
  return '/bin/zsh';
}

/** 测试用:导出常量便于断言. */
export const _internals = { SHELL_NAMES, UNIX_PREFIXES, defaultHomedir: os.homedir };
