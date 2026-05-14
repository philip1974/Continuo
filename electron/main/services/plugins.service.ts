// 插件目录扫描 + 文件读取(M-Plugin v4.1,主进程端)。
// 纯函数风格,便于单测;真正的 IPC 注册在 plugins.ipc.ts。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  IpcPermissionDecision,
  IpcPermissionsMap,
  IpcPluginDir,
} from '../../shared/plugins-channels';

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

    // 解析 manifest.main(若失败用默认 main.js)
    let mainName = 'main.js';
    try {
      const m = JSON.parse(manifestText) as { main?: unknown };
      if (typeof m.main === 'string' && m.main.length > 0) mainName = m.main;
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

// ── v4.5 git URL 安装 ──────────────────────────────────

import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const PLUGIN_ID_RE = /^[a-z0-9._-]+$/;

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
  if (!PLUGIN_ID_RE.test(id)) {
    throw Object.assign(new Error(`非法 plugin id: ${id}`), {
      code: 'INVALID_ID',
    });
  }
  const targetDir = path.join(baseDir, id);
  try {
    await fs.access(targetDir);
  } catch {
    throw Object.assign(new Error(`插件未安装: ${id}`), {
      code: 'NOT_INSTALLED',
    });
  }
  try {
    await rm(targetDir, { recursive: true, force: true });
  } catch (err) {
    throw Object.assign(
      new Error(`删除失败: ${err instanceof Error ? err.message : String(err)}`),
      { code: 'RM_FAILED' },
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
}

export interface InstallFromGitResult {
  readonly id: string;
  readonly name: string;
  readonly version: string;
}

const GIT_URL_RE = /^(https?|git|ssh):\/\//i;

/**
 * 从 git URL clone 到临时目录,验 manifest.json,把整个目录复制到
 * baseDir/<manifest.id>/。已存在 → 抛 EEXIST 让调用方提示用户。
 */
export async function installFromGit(
  gitUrl: string,
  baseDir: string,
): Promise<InstallFromGitResult> {
  if (!GIT_URL_RE.test(gitUrl)) {
    throw Object.assign(new Error(`不支持的 git URL: ${gitUrl}`), {
      code: 'BAD_URL',
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
        { code: 'BAD_MANIFEST' },
      );
    }
    if (
      typeof manifest.id !== 'string' ||
      !/^[a-z0-9._-]+$/.test(manifest.id) ||
      typeof manifest.name !== 'string' ||
      typeof manifest.version !== 'string'
    ) {
      throw Object.assign(
        new Error('manifest.json 缺必填 id/name/version 或 id 含非法字符'),
        { code: 'BAD_MANIFEST' },
      );
    }

    const mainName =
      typeof (manifest as { main?: unknown }).main === 'string'
        ? (manifest as { main: string }).main
        : 'main.js';
    const mainPath = resolvePluginMainPath(cloneDir, mainName);
    if (!mainPath) {
      throw Object.assign(new Error(`main 入口非法: ${mainName}`), {
        code: 'BAD_MAIN',
      });
    }
    try {
      await fs.access(mainPath);
    } catch {
      throw Object.assign(new Error(`main 入口不存在: ${mainName}`), {
        code: 'BAD_MAIN',
      });
    }

    const targetDir = path.join(baseDir, manifest.id);
    let targetExists = false;
    try {
      await fs.access(targetDir);
      targetExists = true;
    } catch {
      /* not exists, OK */
    }
    if (targetExists) {
      throw Object.assign(
        new Error(`插件 ${manifest.id} 已安装,卸载后再装`),
        { code: 'EEXIST' },
      );
    }

    await fs.mkdir(baseDir, { recursive: true });
    await cp(cloneDir, targetDir, { recursive: true });

    // 清掉 .git 节省空间
    try {
      await rm(path.join(targetDir, '.git'), {
        recursive: true,
        force: true,
      });
    } catch {
      /* 不影响安装 */
    }

    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
    };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

function runGit(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', (err) =>
      reject(
        Object.assign(new Error(`git spawn 失败: ${err.message}`), {
          code: 'GIT_SPAWN_FAILED',
        }),
      ),
    );
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else
        reject(
          Object.assign(
            new Error(`git ${args[0]} exit ${code}: ${stderr.trim()}`),
            { code: 'GIT_FAILED' },
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
        if (typeof m.main === 'string' && m.main.length > 0) mainName = m.main;
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
