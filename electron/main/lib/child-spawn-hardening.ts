// 插件/宿主拉起外部子进程(shell.exec / plugin-shell-stream / git cat-file)前的两层兜底:
//
// 1. withGitHardeningEnv:恶意 workspace 的 `.git/config` 写 `core.fsmonitor = "<cmd>"`,任何在其中跑
//    `git status` 的插件即执行任意命令。用 git ≥2.31 的「命令行作用域」env(GIT_CONFIG_COUNT /
//    GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n,优先级高于仓库 config)强制 core.fsmonitor=false。对所有子进程
//    注入:非 git 程序忽略,git 被间接调用时同样受保护。不设 core.hooksPath(会破坏用户提交 hooks)。
//    **覆盖范围(如实说明):插件子进程的宿主兜底只覆盖 core.fsmonitor**(宿主自己跑的资源管理器 git 状态另外置空
//    仓库定义的 filter 驱动并不进子模块,见 services/git-status.service)。同一威胁(不可信仓库的 `.git/config` /
//    `.gitattributes` 让 git 执行命令)下还有:`filter.<driver>.clean/smudge/process` + `.gitattributes`、
//    `diff.<driver>.textconv` / `diff.external`、`core.sshCommand`、`core.pager` / `pager.<cmd>`、
//    `core.editor`、`credential.helper` 等 —— 驱动名由仓库自定,命令行作用域 env 无通配语法,宿主无法
//    一并禁用;强行置空 sshCommand/pager 等还会破坏用户合法配置。这些需**插件自行加固**:对不可信仓库
//    调用 git 时显式传 `--no-textconv` / `--no-ext-diff`、按需用 `-c <key>=<安全值>` 显式覆盖,只用不触发
//    过滤器 / 外部 diff 的子命令,或在受信判断后再调用。
//    另有 git ≥ 2.54 的**配置式 hooks**(仓库 config 的 `[hook "<name>"] event = … / command = …`):在
//    `git add` 与会刷新 index 的 `git status` 时执行,不受 `core.hooksPath` 影响。hook 名由仓库自定,宿主
//    无法统一禁用(会连同用户自己的 hooks 一起关掉)→ 经 shell.exec 调 git 的插件须自行处理:把仓库作用域的
//    `hook.*` 视为不可信,或对非 commit 子命令加 `-c hook.<event>.enabled=false`(git ≥ 2.55)。
// 2.resolveSpawnCommand:Windows 上 libuv 解析无路径命令名时**先查子进程 cwd** 再查 PATH,workspace 根放
//    `git.exe` 即被执行。spawn 前按 libuv 同款规则(原名若带扩展名先试,再 .com / .exe)只在 PATH 的绝对目录
//    中解析为绝对路径,解析不到 fail-closed。libuv v1.x(src/win/process.c search_path)虽会调
//    NeedCurrentDirectoryForExePathW 而遵守 NoDefaultCurrentDirectoryInExePath,但该 env 默认未设、可被插件
//    env 覆盖,且旧版 libuv 不认,故不依赖它,仍自行只查 PATH 绝对目录。PATH 切分、候选判定也照 libuv:
//    以 " 或 ' 开头的项到同种引号闭合前的 ; 不算分隔符;候选「存在且不是目录」即可(见 isSpawnCandidate)。
//    非 Windows 原样返回。

import { lstatSync, statSync } from 'node:fs';
import path from 'node:path';
import { CONTINUO_MCP_TOKEN_ENV } from './continuo-env-keys';

/** 强制覆盖的 git 配置(命令行作用域)。只有 fsmonitor:其余执行命令的 git 配置见文件头「覆盖范围」。 */
const GIT_HARDENING_CONFIG: readonly (readonly [string, string])[] = [['core.fsmonitor', 'false']];

/**
 * 返回注入 git 命令行作用域配置后的新 env(不改入参)。调用方已带 GIT_CONFIG_COUNT 时从其后续编号追加,
 * 不覆盖调用方条目;同名键后出现者生效,故我们的值优先于调用方同名条目。
 * Windows env 键大小写不敏感:插件传 `git_config_count` 也按计数读取(多个大小写变体取最大合法值,保证排在
 * 全部调用方条目之后);写入经 mergeSpawnEnv,不留与我们的键仅大小写不同的副本(否则子进程取到哪份不确定)。
 */
export function withGitHardeningEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  /** 调用方专属的额外命令行作用域配置,排在 GIT_HARDENING_CONFIG 之后(如插件 git 安装的 filter.lfs.*)。 */
  extraConfig: readonly (readonly [string, string])[] = [],
): NodeJS.ProcessEnv {
  const counts =
    platform === 'win32'
      ? Object.keys(env).filter((k) => k.toUpperCase() === 'GIT_CONFIG_COUNT').map((k) => env[k])
      : [env.GIT_CONFIG_COUNT];
  // 非法计数:git 会整体报错退出(fail-closed);这里按 0 起编号并覆盖,保证我们的条目生效。
  let n = 0;
  for (const raw of counts) if (raw !== undefined && /^\d+$/.test(raw)) n = Math.max(n, Number(raw));
  const extra: NodeJS.ProcessEnv = {};
  for (const [key, value] of [...GIT_HARDENING_CONFIG, ...extraConfig]) {
    extra[`GIT_CONFIG_KEY_${n}`] = key;
    extra[`GIT_CONFIG_VALUE_${n}`] = value;
    n += 1;
  }
  extra.GIT_CONFIG_COUNT = String(n);
  return mergeSpawnEnv(env, extra, platform);
}

/**
 * 只读本地对象库的 git 预设:GIT_NO_LAZY_FETCH=1(git ≥2.45 禁 partial clone 惰性拉取)+ GIT_ALLOW_PROTOCOL=''
 * (空白名单:git ≥2.12 忽略全部 protocol.*.allow 配置、拒绝一切传输,仓库 config 无法覆盖)
 * + GIT_NO_REPLACE_OBJECTS=1(不跟随 refs/replace:否则读 <sha> 实际读到的是 replace-ref 指向的另一个对象,
 * 调用方按 <sha> 做的对象路径校验 —— 如 readGitBlob 的扇出目录 scope 校验 —— 被绕过)。
 */
export const GIT_OFFLINE_ENV: Readonly<
  Record<'GIT_NO_LAZY_FETCH' | 'GIT_ALLOW_PROTOCOL' | 'GIT_NO_REPLACE_OBJECTS', string>
> = Object.freeze({
  GIT_NO_LAZY_FETCH: '1',
  GIT_ALLOW_PROTOCOL: '',
  GIT_NO_REPLACE_OBJECTS: '1',
});

/**
 * 宿主内部机密 env 名单:不得进入插件 / 调试适配器等非宿主自身的子进程。Continuo 从带 token 的终端启动时
 * process.env 即含它;持有 token 即可经 MCP HTTP 以该窗口身份调用工具。
 * 只列机密:CONTINUO_MCP_SOCKET(路径,本就可由 userData 推得;连上仍需 hello token)、CONTINUO_WINDOW_ID /
 * CONTINUO_TERMINAL_SESSION_ID(标识符,无 token 不能据以调用)不是凭据,保留以免破坏依赖它们定位实例的工具。
 */
export const INTERNAL_SECRET_ENV_KEYS: readonly string[] = Object.freeze([CONTINUO_MCP_TOKEN_ENV]);

function stripEnvKeys(env: NodeJS.ProcessEnv, keys: readonly string[], platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of Object.keys(out)) {
    const name = platform === 'win32' ? k.toUpperCase() : k;
    if (keys.includes(name)) delete out[k];
  }
  return out;
}

/** 返回剥离 INTERNAL_SECRET_ENV_KEYS 后的新 env(不改入参);Windows 按大小写不敏感匹配。 */
export function stripInternalSecretEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return stripEnvKeys(env, INTERNAL_SECRET_ENV_KEYS, platform);
}

/**
 * 会让 git 改读别的仓库 / 对象库 / 工作树 / 索引的 env。宿主代插件跑「只许读某个已校验仓库」的 git 命令
 * (readGitBlob)以及宿主自己 clone 插件仓库(plugins.service runGit)时必须剥离:否则 Continuo 从设了 GIT_DIR / GIT_ALTERNATE_OBJECT_DIRECTORIES 等的终端启动时,
 * git 读的不是 cwd 所在的仓库,scope 校验形同虚设。GIT_CEILING_DIRECTORIES 会改变向上发现的结果,一并剥离
 * (发现到的位置另有 scope 校验)。不用于 shell.exec:那里的 git 由插件凭 shell 权限自行调用,env 归用户。
 */
const GIT_REPO_REDIRECT_ENV_KEYS: readonly string[] = Object.freeze([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
]);

/** 返回剥离 GIT_REPO_REDIRECT_ENV_KEYS 后的新 env(不改入参);Windows 按大小写不敏感匹配。 */
export function stripGitRepoRedirectEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return stripEnvKeys(env, GIT_REPO_REDIRECT_ENV_KEYS, platform);
}

/**
 * 合并子进程 env(`extra` 覆盖 `base`,不改入参)。Windows env 键大小写不敏感:宿主 `{...process.env}` 带
 * `Path`、插件传 `PATH` 时,朴素展开会两键并存 —— resolveSpawnCommand 取到宿主的,Node 给子进程按排序选键,
 * 插件补充的 PATH 在命令解析时被忽略、解析与子进程 env 不一致。故 Windows 上同名(忽略大小写)只保留后者的键。
 */
export function mergeSpawnEnv(
  base: NodeJS.ProcessEnv,
  extra: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (platform === 'win32') {
      const upper = key.toUpperCase();
      for (const k of Object.keys(out)) if (k !== key && k.toUpperCase() === upper) delete out[k];
    }
    out[key] = value;
  }
  return out;
}

export interface ResolveSpawnDeps {
  platform: NodeJS.Platform;
  isFile: (p: string) => boolean;
}

/**
 * 与 libuv search_path_join_test 对齐:GetFileAttributesW 成功且不带 FILE_ATTRIBUTE_DIRECTORY 即为候选。
 * 不能用 `statSync().isFile()`:Store 版 python.exe / pwsh.exe / winget.exe 等是 App Execution Alias
 * (IO_REPARSE_TAG_APPEXECLINK),stat 跟随时抛 EACCES,但 libuv 可正常执行(npm/node-which#157)。
 * 故 lstat 成功即存在;是链接时再 stat 排除指向目录者(GetFileAttributesW 对目录链接带 DIRECTORY 位),
 * stat 失败(如上述 alias)仍视为存在。
 */
export function isSpawnCandidate(p: string): boolean {
  try {
    const st = lstatSync(p);
    if (st.isDirectory()) return false;
    if (!st.isSymbolicLink()) return true;
  } catch {
    return false;
  }
  try {
    return !statSync(p).isDirectory();
  } catch {
    return true;
  }
}

/** 按 libuv search_path 切分 Windows PATH:以 " 或 ' 开头的项到同种引号闭合处之前的 ; 不切分;首尾引号各自剥除。 */
function splitWindowsPath(value: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i <= value.length) {
    let scanFrom = i;
    const q = value[i];
    if (q === '"' || q === "'") {
      const close = value.indexOf(q, i + 1);
      scanFrom = close === -1 ? value.length : close;
    }
    let end = value.indexOf(';', scanFrom);
    if (end === -1) end = value.length;
    let item = value.slice(i, end);
    if (item.startsWith('"') || item.startsWith("'")) item = item.slice(1);
    if (item.endsWith('"') || item.endsWith("'")) item = item.slice(0, -1);
    out.push(item);
    i = end + 1;
  }
  return out;
}

/**
 * PATH 中的**绝对**目录(按平台切分:Windows 按 libuv 规则处理引号项,其它平台按 `:`)。空项与相对项跳过 —— 相对项
 * 按 cwd 解析(cwd 即不可信 workspace)。spawn 命令解析与 debug 的 node 运行时查找共用(此前后者自己
 * `split(path.delimiter)`,Windows 上带引号的 `"C:\Program Files\nodejs"` 项被判为相对而跳过)。
 */
export function absolutePathDirs(pathValue: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') {
    return splitWindowsPath(pathValue).filter((dir) => dir !== '' && path.win32.isAbsolute(dir));
  }
  return pathValue.split(':').filter((dir) => dir !== '' && path.posix.isAbsolute(dir));
}

/**
 * Windows:把不含路径成分的命令名解析为 PATH(仅绝对目录,不含 cwd)中的绝对路径;解析不到抛 ENOENT。
 * 含路径分隔符 / 盘符的命令由调用方显式指定,原样返回。非 Windows 原样返回。
 * @param env 子进程将使用的 env(libuv 也按子进程 env 的 PATH 搜索)
 */
export function resolveSpawnCommand(
  cmd: string,
  env: NodeJS.ProcessEnv,
  deps: ResolveSpawnDeps = { platform: process.platform, isFile: isSpawnCandidate },
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
  for (const dir of absolutePathDirs(pathValue, 'win32')) {
    for (const name of names) {
      const candidate = path.win32.join(dir, name);
      if (deps.isFile(candidate)) return candidate;
    }
  }
  const err = new Error(`spawn ${cmd} ENOENT: not found on PATH (current directory is not searched)`);
  (err as NodeJS.ErrnoException).code = 'ENOENT';
  throw err;
}
