// 插件/宿主拉起外部子进程(shell.exec / plugin-shell-stream / git cat-file)前的两层兜底:
//
// 1. withGitHardeningEnv:恶意 workspace 的 `.git/config` 写 `core.fsmonitor = "<cmd>"`,任何在其中跑
//    `git status` 的插件即执行任意命令。用 git ≥2.31 的「命令行作用域」env(GIT_CONFIG_COUNT /
//    GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n,优先级高于仓库 config)强制 core.fsmonitor=false。对所有子进程
//    注入:非 git 程序忽略,git 被间接调用时同样受保护。不设 core.hooksPath(会破坏用户提交 hooks)。

/** 强制覆盖的 git 配置(命令行作用域)。 */
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
