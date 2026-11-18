// 插件/宿主拉起外部子进程(shell.exec / plugin-shell-stream / git cat-file)前的两层兜底:
//
// 1. withGitHardeningEnv:恶意 workspace 的 `.git/config` 写 `core.fsmonitor = "<cmd>"`,任何在其中跑
//    `git status` 的插件即执行任意命令。用 git ≥2.31 的「命令行作用域」env(GIT_CONFIG_COUNT /
//    GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n,优先级高于仓库 config)强制 core.fsmonitor=false。对所有子进程
//    注入:非 git 程序忽略,git 被间接调用时同样受保护。不设 core.hooksPath(会破坏用户提交 hooks)。
//    **覆盖范围(如实说明):宿主兜底只覆盖 core.fsmonitor**。同一威胁(不可信仓库的 `.git/config` /
//    `.gitattributes` 让 git 执行命令)下还有:`filter.<driver>.clean/smudge/process` + `.gitattributes`、
//    `diff.<driver>.textconv` / `diff.external`、`core.sshCommand`、`core.pager` / `pager.<cmd>`、
//    `core.editor`、`credential.helper` 等 —— 驱动名由仓库自定,命令行作用域 env 无通配语法,宿主无法
//    一并禁用;强行置空 sshCommand/pager 等还会破坏用户合法配置。这些需**插件自行加固**:对不可信仓库
//    调用 git 时显式传 `--no-textconv` / `--no-ext-diff`、按需用 `-c <key>=<安全值>` 显式覆盖,只用不触发
//    过滤器 / 外部 diff 的子命令,或在受信判断后再调用。
// 2. resolveSpawnCommand:Windows 上 libuv 解析无路径命令名时**先查子进程 cwd** 再查 PATH,workspace 根放
//    `git.exe` 即被执行。spawn 前按 libuv 同款规则(原名若带扩展名先试,再 .com / .exe)只在 PATH 的绝对目录
//    中解析为绝对路径,解析不到 fail-closed。libuv 自实现搜索,不认 NoDefaultCurrentDirectoryInExePath,
//    故不能靠该 env。非 Windows 原样返回。

import { statSync } from 'node:fs';
import path from 'node:path';

/** 强制覆盖的 git 配置(命令行作用域)。只有 fsmonitor:其余执行命令的 git 配置见文件头「覆盖范围」。 */
const GIT_HARDENING_CONFIG: readonly (readonly [string, string])[] = [['core.fsmonitor', 'false']];

/**
 * 返回注入 git 命令行作用域配置后的新 env(不改入参)。调用方已带 GIT_CONFIG_COUNT 时从其后续编号追加,
 * 不覆盖调用方条目;同名键后出现者生效,故我们的值优先于调用方同名条目。
 */
export function withGitHardeningEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  const raw = out.GIT_CONFIG_COUNT;
  // 非法计数:git 会整体报错退出(fail-closed);这里按 0 起编号并覆盖,保证我们的条目生效。
  let n = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : 0;
  for (const [key, value] of GIT_HARDENING_CONFIG) {
    out[`GIT_CONFIG_KEY_${n}`] = key;
    out[`GIT_CONFIG_VALUE_${n}`] = value;
    n += 1;
  }
  out.GIT_CONFIG_COUNT = String(n);
  return out;
}

export interface ResolveSpawnDeps {
  platform: NodeJS.Platform;
  isFile: (p: string) => boolean;
}

const defaultIsFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * Windows:把不含路径成分的命令名解析为 PATH(仅绝对目录,不含 cwd)中的绝对路径;解析不到抛 ENOENT。
 * 含路径分隔符 / 盘符的命令由调用方显式指定,原样返回。非 Windows 原样返回。
 * @param env 子进程将使用的 env(libuv 也按子进程 env 的 PATH 搜索)
 */
export function resolveSpawnCommand(
  cmd: string,
  env: NodeJS.ProcessEnv,
  deps: ResolveSpawnDeps = { platform: process.platform, isFile: defaultIsFile },
): string {
  if (deps.platform !== 'win32') return cmd;
  if (/[\\/:]/.test(cmd)) return cmd;
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  const pathValue = pathKey !== undefined ? env[pathKey] ?? '' : '';
  const names = [
    ...(path.win32.extname(cmd) !== '' ? [cmd] : []),
    `${cmd}.com`,
    `${cmd}.exe`,
  ];
  for (const rawDir of pathValue.split(';')) {
    const dir = rawDir.replace(/^"(.*)"$/, '$1');
    // 空项 / 相对项按 cwd 解析(cwd 即不可信 workspace),跳过。
    if (dir === '' || !path.win32.isAbsolute(dir)) continue;
    for (const name of names) {
      const candidate = path.win32.join(dir, name);
      if (deps.isFile(candidate)) return candidate;
    }
  }
  const err = new Error(`spawn ${cmd} ENOENT: not found on PATH (current directory is not searched)`);
  (err as NodeJS.ErrnoException).code = 'ENOENT';
  throw err;
}
