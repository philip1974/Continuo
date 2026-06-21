// 插件目录扫描 + 文件读取(M-Plugin v4.1,主进程端)。
// 纯函数风格,便于单测;真正的 IPC 注册在 plugins.ipc.ts。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  IpcPathScope,
  IpcPermissionDecision,
  IpcPermissionsMap,
  IpcPluginDir,
} from '../../shared/plugins-channels';
import { ERROR_CODES } from '../../shared/error-codes';
import { errorMessage } from '../../shared/error-message';

function isAbsolutePathLike(value: string): boolean {
  return (
    path.isAbsolute(value) ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    value.startsWith('\\\\') ||
    value.startsWith('//')
  );
}

export function resolvePluginMainPath(
  pluginDir: string,
  mainName: string,
): string | null {
  if (!mainName || mainName.includes('\0')) return null;
  if (isAbsolutePathLike(mainName)) return null;
  if (mainName.split(/[\\/]+/).includes('..')) return null;

  const root = path.resolve(pluginDir);
  const resolved = path.resolve(root, mainName);
  const rel = path.relative(root, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return resolved;
}

/**
 * 插件 id 安全性:仅允许小写字母数字与 `. _ -`,且**不得**为 `.` 或 `..`。
 * 旧正则 `^[a-z0-9._-]+$` 允许纯点段,`id='..'` 会让 `path.join(baseDir, id)` 解析到
 * baseDir 的父目录;overwrite 安装(marketplace「更新」)随即 rename 覆盖父目录 →
 * 路径穿越(审计 P1)。与 fs `renameEntry` 拒 `.`/`..` 同款防御。
 */
export function isSafePluginId(id: string): boolean {
  if (!/^[a-z0-9._-]+$/.test(id)) return false;
  if (id === '.' || id === '..') return false;
  return true;
}

/**
 * 可维护性 M20:从(已 JSON.parse 的)manifest 取入口名 —— 非空 string 则用,否则默认
 * main.js。扫描(listPluginDirs)/ 安装(installFromGit)/ watch(createPluginsWatcher)
 * 三处共用,避免入口选择规则漂移。解析失败的策略由各调用方自留(fallback / 跳过 / 抛)。
 */
function getPluginMainName(manifest: unknown): string {
  if (manifest && typeof manifest === 'object') {
    const main = (manifest as Record<string, unknown>).main;
    if (typeof main === 'string' && main.length > 0) return main;
  }
  return 'main.js';
}

/**
 * 扫描 baseDir/<id>/manifest.json 模式;返回所有合法目录的 manifestText +
 * mainText(默认 main.js 或 manifest.main 指向)+ 可选 stylesText。
 *
 * 子目录读 fail / 缺 manifest / 缺 main 都跳过该目录(不抛),由 renderer 端
 * PluginManager 决定是否报告。
 */
export async function listPluginDirs(baseDir: string): Promise<IpcPluginDir[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(baseDir);
  } catch {
    // baseDir 不存在视为无插件
    return [];
  }

  const out: IpcPluginDir[] = [];
  for (const id of entries) {
    if (id.startsWith('.') || id.startsWith('_')) continue;

    const dir = path.join(baseDir, id);
    let stat: import('node:fs').Stats;
    try {
      stat = await fs.stat(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    let manifestText: string;
    try {
      manifestText = await fs.readFile(path.join(dir, 'manifest.json'), 'utf-8');
    } catch {
      continue;
    }

    // 解析 manifest.main(若失败用默认 main.js,M20:共用 getPluginMainName)
    let mainName = 'main.js';
    try {
      mainName = getPluginMainName(JSON.parse(manifestText));
    } catch {
      // manifest 解析失败由 renderer 端 parseManifest 报错,我们继续给 mainText 尝试默认
    }

    let mainText: string;
    const mainPath = resolvePluginMainPath(dir, mainName);
    if (!mainPath) continue;
    try {
      mainText = await fs.readFile(mainPath, 'utf-8');
    } catch {
      // 主入口缺失 → 跳过整个 plugin
      continue;
    }

    let stylesText: string | undefined;
    try {
      stylesText = await fs.readFile(path.join(dir, 'styles.css'), 'utf-8');
    } catch {
      // 没 styles.css 也 OK
    }

    out.push({ id, manifestText, mainText, stylesText });
  }
  return out;
}

const ENABLED_FILE = '_enabled.json';

export async function readEnabledIds(baseDir: string): Promise<string[]> {
  const file = path.join(baseDir, ENABLED_FILE);
  try {
    const text = await fs.readFile(file, 'utf-8');
    const json = JSON.parse(text) as unknown;
    if (Array.isArray(json) && json.every((x) => typeof x === 'string')) {
      return json as string[];
    }
    return [];
  } catch {
    return [];
  }
}

export async function writeEnabledIds(
  baseDir: string,
  ids: readonly string[],
): Promise<void> {
  await fs.mkdir(baseDir, { recursive: true });
  const file = path.join(baseDir, ENABLED_FILE);
  // 简单写入(非原子);插件 enabled 列表小且变更频率低,不投资 atomic
  await fs.writeFile(file, JSON.stringify(ids, null, 2), 'utf-8');
}

// ── v4.2 权限决策持久化 ─────────────────────────────────

const PERMISSIONS_FILE = '_permissions.json';

function isDecision(x: unknown): x is IpcPermissionDecision {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.permission === 'string' &&
    typeof o.granted === 'boolean' &&
    typeof o.decidedAt === 'number'
  );
}

export async function readPermissions(
  baseDir: string,
): Promise<IpcPermissionsMap> {
  const file = path.join(baseDir, PERMISSIONS_FILE);
  try {
    const text = await fs.readFile(file, 'utf-8');
    const json = JSON.parse(text) as unknown;
    if (!json || typeof json !== 'object' || Array.isArray(json)) return {};
    const out: Record<string, IpcPermissionDecision[]> = {};
    for (const [pid, value] of Object.entries(json as Record<string, unknown>)) {
      if (Array.isArray(value) && value.every(isDecision)) {
        out[pid] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export async function writePermissions(
  baseDir: string,
  data: IpcPermissionsMap,
): Promise<void> {
  await fs.mkdir(baseDir, { recursive: true });
  const file = path.join(baseDir, PERMISSIONS_FILE);
  await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf-8');
}

// ── path-scope 持久化(plugin-fs 授权跨重启保留)──────────────
//
// 设计:与决策(_permissions.json,renderer 写)分文件,由主进程独占读写
// `_plugin-path-scopes.json`,规避跨进程并发覆盖。grant 时由 request-scope handler
// 写入;冷启动由 handler 读回水合进 PathScopeRegistry;uninstall 连同 id 一并清除
// (防同 id 重装继承旧 scope,与 _permissions.json 清理对称)。

const PATH_SCOPES_FILE = '_plugin-path-scopes.json';

function isIpcPathScope(x: unknown): x is IpcPathScope {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return typeof o.path === 'string' && (o.mode === 'r' || o.mode === 'rw');
}

async function readAllPathScopes(
  baseDir: string,
): Promise<Record<string, IpcPathScope[]>> {
  const file = path.join(baseDir, PATH_SCOPES_FILE);
  try {
    const text = await fs.readFile(file, 'utf-8');
    const json = JSON.parse(text) as unknown;
    if (!json || typeof json !== 'object' || Array.isArray(json)) return {};
    const out: Record<string, IpcPathScope[]> = {};
    for (const [pid, value] of Object.entries(json as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      const scopes = value.filter(isIpcPathScope);
      if (scopes.length > 0) out[pid] = scopes;
    }
    return out;
  } catch {
    return {};
  }
}

/** 读取单个 plugin 上次会话持久化的 path scope(canonical);无则空数组。 */
export async function readPluginPathScopes(
  baseDir: string,
  id: string,
): Promise<IpcPathScope[]> {
  const all = await readAllPathScopes(baseDir);
  return all[id] ?? [];
}

// 同文件 read-modify-write 串行化,防并发 grant 互相覆盖(镜像 installLocks 思路)。
let pathScopesWriteChain: Promise<unknown> = Promise.resolve();

/**
 * 持久化单个 plugin 的全部已授 path scope(覆盖式)。空数组 → 删除该 id 条目。
 * 非法 id 直接忽略(防注入畸形 key)。写入串行化避免并发 grant 互踩。
 */
export function writePluginPathScopes(
  baseDir: string,
  id: string,
  scopes: readonly IpcPathScope[],
): Promise<void> {
  const run = pathScopesWriteChain.then(async () => {
    if (!isSafePluginId(id)) return;
    const all = await readAllPathScopes(baseDir);
    const normalized = scopes
      .filter(isIpcPathScope)
      .map((s) => ({ path: s.path, mode: s.mode }));
    if (normalized.length === 0) {
      if (!(id in all)) return; // 无变化,不为删除空条目而触盘
      delete all[id];
    } else {
      all[id] = normalized;
    }
    await fs.mkdir(baseDir, { recursive: true });
    const file = path.join(baseDir, PATH_SCOPES_FILE);
    await fs.writeFile(file, JSON.stringify(all, null, 2), 'utf-8');
  });
  pathScopesWriteChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

// ── v4.5 git URL 安装 ──────────────────────────────────

import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// 同 id 并发安装串行化:防两个安装同时 swap 进 baseDir/<id> 互相踩(审计 #5)。
const installLocks = new Map<string, Promise<unknown>>();
function withInstallLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = installLocks.get(id) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  installLocks.set(
    id,
    run.then(
      () => {},
      () => {},
    ),
  );
  return run;
}

/**
 * 卸载插件:rm -rf baseDir/<id>/,顺手清 _enabled.json 和 _permissions.json
 * 中可能残留的 id。
 *
 * - id 不合法 → 抛 INVALID_ID
 * - 目录不存在 → 抛 NOT_INSTALLED
 * - rm 失败 → 抛 RM_FAILED
 */
export async function uninstallPlugin(
  baseDir: string,
  id: string,
): Promise<void> {
  // 必须用 isSafePluginId(显式拒纯点段 `.`/`..`),不能用裸正则 `^[a-z0-9._-]+$`:
  // 后者放行 `..` → path.join(baseDir,'..') 解析到 baseDir 父目录 → rm -rf 父目录
  // (recursive+force)= 灾难性数据丢失/路径穿越。install 侧(manifest.id)已用 isSafePluginId,
  // uninstall 此前漏改(helper 未传播到兄弟入口)。
  if (!isSafePluginId(id)) {
    throw Object.assign(new Error(`非法 plugin id: ${id}`), {
      code: ERROR_CODES.INVALID_ID,
    });
  }
  const targetDir = path.join(baseDir, id);
  try {
    await fs.access(targetDir);
  } catch {
    throw Object.assign(new Error(`插件未安装: ${id}`), {
      code: ERROR_CODES.NOT_INSTALLED,
    });
  }
  try {
    await rm(targetDir, { recursive: true, force: true });
  } catch (err) {
    throw Object.assign(
      new Error(`删除失败: ${errorMessage(err)}`),
      { code: ERROR_CODES.RM_FAILED },
    );
  }

  // 清 _enabled.json 中的 id(防止 reload 复活已删插件)
  const enabled = await readEnabledIds(baseDir);
  if (enabled.includes(id)) {
    await writeEnabledIds(
      baseDir,
      enabled.filter((x) => x !== id),
    );
  }

  // 清 _permissions.json 中的 id(避免重装继承旧授权)
  const perms = await readPermissions(baseDir);
  if (id in perms) {
    const next = { ...perms };
    delete (next as Record<string, unknown>)[id];
    await writePermissions(baseDir, next);
  }

  // 清 _plugin-path-scopes.json 中的 id(避免重装继承旧 path scope,与上方对称)
  await writePluginPathScopes(baseDir, id, []);
}

export interface InstallFromGitResult {
  readonly id: string;
  readonly name: string;
  readonly version: string;
}

// 仅允许 https(去掉 git://明文无认证、ssh://可被指向内网做 SSRF/探测)。
const GIT_URL_RE = /^https:\/\//i;
const GIT_CLONE_TIMEOUT_MS = 60_000;

/**
 * 从 git URL clone 到临时目录,验 manifest.json,把整个目录复制到
 * baseDir/<manifest.id>/。已存在 → 抛 EEXIST 让调用方提示用户。
 */
export async function installFromGit(
  gitUrl: string,
  baseDir: string,
  opts: { overwrite?: boolean } = {},
): Promise<InstallFromGitResult> {
  if (!GIT_URL_RE.test(gitUrl)) {
    throw Object.assign(new Error(`不支持的 git URL: ${gitUrl}`), {
      code: ERROR_CODES.BAD_URL,
    });
  }
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'lm-plugin-install-'));
  try {
    const cloneDir = path.join(tmpRoot, 'clone');
    await runGit(['clone', '--depth', '1', gitUrl, cloneDir]);

    let manifest: { id?: string; name?: string; version?: string };
    try {
      const text = await fs.readFile(
        path.join(cloneDir, 'manifest.json'),
        'utf-8',
      );
      manifest = JSON.parse(text);
    } catch {
      throw Object.assign(
        new Error('clone 目录缺 manifest.json 或解析失败'),
        { code: ERROR_CODES.BAD_MANIFEST },
      );
    }
    if (
      typeof manifest.id !== 'string' ||
      !isSafePluginId(manifest.id) ||
      typeof manifest.name !== 'string' ||
      typeof manifest.version !== 'string'
    ) {
      throw Object.assign(
        new Error('manifest.json 缺必填 id/name/version 或 id 含非法字符'),
        { code: ERROR_CODES.BAD_MANIFEST },
      );
    }

    const mainName = getPluginMainName(manifest); // M20:共用 getPluginMainName
    const mainPath = resolvePluginMainPath(cloneDir, mainName);
    if (!mainPath) {
      throw Object.assign(new Error(`main 入口非法: ${mainName}`), {
        code: ERROR_CODES.BAD_MAIN,
      });
    }
    try {
      await fs.access(mainPath);
    } catch {
      throw Object.assign(new Error(`main 入口不存在: ${mainName}`), {
        code: ERROR_CODES.BAD_MAIN,
      });
    }

    // 验证已通过 → 收窄成 string 常量,带进下面的闭包(let manifest 的窄化跨闭包会丢)。
    const pluginId = manifest.id;
    const pluginName = manifest.name;
    const pluginVersion = manifest.version;
    const targetDir = path.join(baseDir, pluginId);
    await fs.mkdir(baseDir, { recursive: true });

    // 清掉 .git 节省空间(在 staging 之前于 tmp clone 内删)。
    try {
      await rm(path.join(cloneDir, '.git'), { recursive: true, force: true });
    } catch {
      /* 不影响安装 */
    }

    // 同 id 串行 + 原子 swap(审计 #5 / #2):先 cp 到 baseDir 内的 staging(同盘
    // 才能 rename 原子落位),再 rename 就位。overwrite 时把旧目录先挪到 backup,
    // 任一步失败都回滚 —— 杜绝"cp 中途失败留半个目录 → 永久 EEXIST"与并发互踩,
    // 也让插件「更新」无需先卸载(失败时旧版本原样保留,不会丢插件)。
    // 必须 await:否则外层 try 的 finally 会在 swap 的 cp 之前先 rm 掉 tmpRoot/clone。
    return await withInstallLock(pluginId, async () => {
      let targetExists = false;
      try {
        await fs.access(targetDir);
        targetExists = true;
      } catch {
        /* not exists, OK */
      }
      if (targetExists && opts.overwrite !== true) {
        throw Object.assign(new Error(`插件 ${pluginId} 已安装,卸载后再装`), {
          code: ERROR_CODES.EEXIST,
        });
      }

      const suffix = randomUUID();
      const staging = path.join(baseDir, `.${pluginId}.installing-${suffix}`);
      const backup = targetExists
        ? path.join(baseDir, `.${pluginId}.old-${suffix}`)
        : null;

      await rm(staging, { recursive: true, force: true }).catch(() => {});
      await cp(cloneDir, staging, { recursive: true });

      try {
        if (backup) await fs.rename(targetDir, backup);
        await fs.rename(staging, targetDir);
      } catch (err) {
        // 回滚:清 staging;若已挪走旧目录则还原。
        await rm(staging, { recursive: true, force: true }).catch(() => {});
        if (backup) await fs.rename(backup, targetDir).catch(() => {});
        throw err;
      }
      if (backup) {
        await rm(backup, { recursive: true, force: true }).catch(() => {});
      }

      return { id: pluginId, name: pluginName, version: pluginVersion };
    });
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

function runGit(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // 禁交互式凭据:防指向需认证的私有 repo 时 git 弹凭据提示永久挂起,
      // 也不读系统/全局凭据助手。GIT_CONFIG_NOSYSTEM 隔离系统级 git 配置。
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    });
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    // timeout:防慢速/挂起的远端无限占用(DoS)。SIGTERM → 1s 后 SIGKILL。
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      // SIGKILL 升级 grace timer 必须 unref:否则 git 超时后这个内层 timer 会把
      // event loop 多撑 1s,关窗/退出时延迟退出。与 plugin-shell-stream/shell.service
      // 的 grace timer 同款(此前漏 unref)。
      const killGraceTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 1000);
      const maybeUnrefKill = killGraceTimer as { unref?: () => void };
      if (typeof maybeUnrefKill.unref === 'function') maybeUnrefKill.unref();
      finish(() =>
        reject(
          Object.assign(new Error(`git ${args[0]} 超时`), {
            code: ERROR_CODES.GIT_FAILED,
          }),
        ),
      );
    }, GIT_CLONE_TIMEOUT_MS);
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', (err) =>
      finish(() =>
        reject(
          Object.assign(new Error(`git spawn 失败: ${err.message}`), {
            code: ERROR_CODES.GIT_SPAWN_FAILED,
          }),
        ),
      ),
    );
    child.on('exit', (code) => {
      if (code === 0) finish(resolve);
      else
        finish(() =>
          reject(
            Object.assign(
              new Error(`git ${args[0]} exit ${code}: ${stderr.trim()}`),
              { code: ERROR_CODES.GIT_FAILED },
            ),
          ),
        );
    });
  });
}

// ── v4.3.1 mtime watch ─────────────────────────────────

export interface PluginsWatcher {
  /** 单次扫描:mtime 变化触发 onChange,首次只填表不 fire. */
  tick(): Promise<void>;
  /** 启动周期 tick;返 dispose 停 timer. */
  start(intervalMs?: number): { dispose(): void };
}

/**
 * 跨平台 plugin 文件改动监听:不用 fs.watch(macOS 不支持 recursive 默认,
 * Linux/Windows 行为不一致),改为 stat mtime 轮询。
 * tick() exposed for unit test;生产 start(2000) 每 2 秒扫一次。
 */
export function createPluginsWatcher(
  baseDir: string,
  onChange: (id: string) => void,
): PluginsWatcher {
  const mtimes = new Map<string, number>();
  let firstRun = true;
  let cancelled = false;

  const tick = async (): Promise<void> => {
    if (cancelled) return;
    let entries: string[];
    try {
      entries = await fs.readdir(baseDir);
    } catch {
      return;
    }
    for (const id of entries) {
      if (id.startsWith('.') || id.startsWith('_')) continue;
      const dir = path.join(baseDir, id);

      let dirStat: import('node:fs').Stats;
      try {
        dirStat = await fs.stat(dir);
      } catch {
        continue;
      }
      if (!dirStat.isDirectory()) continue;

      let mainName = 'main.js';
      let pluginId = id;
      try {
        const text = await fs.readFile(path.join(dir, 'manifest.json'), 'utf-8');
        const m = JSON.parse(text) as { main?: unknown; id?: unknown };
        mainName = getPluginMainName(m); // M20:共用 getPluginMainName
        if (typeof m.id === 'string' && m.id.length > 0) pluginId = m.id;
      } catch {
        continue;
      }

      try {
        const mainPath = resolvePluginMainPath(dir, mainName);
        if (!mainPath) continue;
        const fileStat = await fs.stat(mainPath);
        const mtime = fileStat.mtimeMs;
        const prev = mtimes.get(pluginId);
        if (!firstRun && prev !== undefined && prev !== mtime) {
          onChange(pluginId);
        }
        mtimes.set(pluginId, mtime);
      } catch {
        continue;
      }
    }
    firstRun = false;
  };

  return {
    tick,
    start: (intervalMs = 2000) => {
      cancelled = false;
      void tick();
      const timer = setInterval(() => void tick(), intervalMs);
      return {
        dispose: () => {
          cancelled = true;
          clearInterval(timer);
        },
      };
    },
  };
}
