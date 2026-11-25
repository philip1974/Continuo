// node-pty 的前台进程名(mac 为进程名、Linux 为 argv[0]、Windows 恒为 shell 文件名)的规整:
//  - 终端「有正在运行的子程序」判定(VSCode terminal.integrated.confirmOnKill):与 spawn 的 shell 比较;
//  - 终端 tab 标题(VSCode `${process}`):显示名。
// 都取 basename,去掉登录 shell 的「-」前缀与 .exe 后缀。

import { LABEL_MAX } from './terminal-create';

/** 进程显示名:basename,去「-」前缀与 .exe 后缀(保留大小写),截到 LABEL_MAX(会话标题字段上限)。 */
export function processDisplayName(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
  return base.replace(/^-/, '').replace(/\.exe$/i, '').slice(0, LABEL_MAX);
}

/** 前台进程是否就是 shell 本身(= 没有正在运行的子程序);大小写不敏感。 */
export function isShellProcessName(processName: string, shellPath: string): boolean {
  return processDisplayName(processName).toLowerCase() === processDisplayName(shellPath).toLowerCase();
}
