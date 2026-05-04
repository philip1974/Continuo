// 插件目录扫描 + 文件读取(M-Plugin v4.1,主进程端)。
// 纯函数风格,便于单测;真正的 IPC 注册在 plugins.ipc.ts。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  IpcPermissionDecision,
  IpcPermissionsMap,
  IpcPluginDir,
} from '../../shared/plugins-channels';

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
    try {
      mainText = await fs.readFile(path.join(dir, mainName), 'utf-8');
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
