// 终端「有正在运行的子程序」判定用(VSCode terminal.integrated.confirmOnKill):node-pty 的前台进程名
// (mac 为进程名、Linux 为 argv[0]、Windows 恒为 shell 文件名)与 spawn 的 shell 比较。
// 比较 basename,去掉登录 shell 的「-」前缀与 .exe 后缀,大小写不敏感。

function normalizeProcessName(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
  return base.replace(/^-/, '').replace(/\.exe$/i, '').toLowerCase();
}

/** 前台进程是否就是 shell 本身(= 没有正在运行的子程序)。 */
export function isShellProcessName(processName: string, shellPath: string): boolean {
  return normalizeProcessName(processName) === normalizeProcessName(shellPath);
}
