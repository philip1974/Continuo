// 插件目录扫描 + 文件读取(M-Plugin v4.1,主进程端)。
// 纯函数风格,便于单测;真正的 IPC 注册在 plugins.ipc.ts。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  IpcPathScope,
  IpcPermissionDecision,
  IpcPermissionRecord,
  IpcPermissionsMap,
  IpcPluginDir,
} from '../../shared/plugins-channels';
import { ERROR_CODES } from '../../shared/error-codes';
import { errorMessage } from '../../shared/error-message';
import { atomicWriteJson } from '../lib/atomic-write';
import { createByteCappedBuffer } from '../lib/byte-capped-buffer';
import { readFileCappedFd } from '../lib/read-fh-capped';
import { runSerialPerKey } from './serialize-per-key';
import { PERMISSION_KEYS } from '../../../src/plugins/permissions';
import { parseManifest } from '../../../src/plugins/manifest';

function isAbsolutePathLike(value: string): boolean {
  return (
    path.isAbsolute(value) ||
    isWindowsDriveAbsolute(value) ||
    value.startsWith('\\\\') ||
    value.startsWith('//')
  );
}

function isWindowsDriveAbsolute(value: string): boolean {
  if (value.length < 3) return false;
  const first = value.charCodeAt(0);
  const third = value.charCodeAt(2);
  return (
    ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) &&
    value.charCodeAt(1) === 58 &&
    (third === 47 || third === 92)
  );
}

function hasParentPathSegment(value: string): boolean {
  let segmentStart = 0;
  for (let i = 0; i <= value.length; i += 1) {
    const code = i < value.length ? value.charCodeAt(i) : 47;
    if (code !== 47 && code !== 92) continue;
    if (
      i - segmentStart === 2 &&
      value.charCodeAt(segmentStart) === 46 &&
      value.charCodeAt(segmentStart + 1) === 46
    ) {
      return true;
    }
    segmentStart = i + 1;
  }
  return false;
}

export function resolvePluginMainPath(
  pluginDir: string,
  mainName: string,
): string | null {
  if (!mainName || mainName.includes('\0')) return null;
  if (isAbsolutePathLike(mainName)) return null;
  if (hasParentPathSegment(mainName)) return null;

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
  if (id === '.' || id === '..') return false;
  return hasOnlyPluginIdChars(id);
}

function hasOnlyPluginIdChars(id: string): boolean {
  if (id.length === 0) return false;
  for (let i = 0; i < id.length; i += 1) {
    const code = id.charCodeAt(i);
    const ok =
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 46 ||
      code === 95 ||
      code === 45;
    if (!ok) return false;
  }
  return true;
}

// 边界(E102):manifest.main 入口名长度上限,对齐 renderer ManifestSchema 的 main.max(512,E74)。
// getPluginMainName 是 list/install/watch 三入口共用的 main 选择器,此前无长度上限 → 畸形 manifest
// 可用近 1MiB 的 main 字段经 resolvePluginMainPath 的 split/resolve 放大主进程字符串处理 + 拼进
// install 错误消息。超长视为非法 → 退默认 main.js(同时把下游 BAD_MAIN 错误消息钳到 ≤512)。
const MAIN_NAME_MAX = 512;

/**
 * 可维护性 M20:从(已 JSON.parse 的)manifest 取入口名 —— 非空且 ≤512 的 string 则用,否则默认
 * main.js。扫描(listPluginDirs)/ 安装(installFromGit)/ watch(createPluginsWatcher)
 * 三处共用,避免入口选择规则漂移。解析失败的策略由各调用方自留(fallback / 跳过 / 抛)。
 */
function getPluginMainName(manifest: unknown): string {
  if (manifest && typeof manifest === 'object') {
    const main = (manifest as Record<string, unknown>).main;
    if (typeof main === 'string' && main.length > 0 && main.length <= MAIN_NAME_MAX) {
      return main;
    }
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
/**
 * 启动期恢复被**进程崩溃**中断的插件更新(数据安全,codex 复查 P1)。
 *
 * installFromGit 的 overwrite swap 顺序是 `rename(target→backup)` 再 `rename(staging→target)`;
 * in-process try/catch 只回滚可 catch 的 error,但进程在两次 rename **之间**崩溃会留下:
 * `<id>` 目标缺失 + `.<id>.old-<uuid>` backup(被 listPluginDirs 第 82 行跳过)→ 插件静默
 * 消失,违反「失败时旧版本原样保留,不会丢插件」的注释契约。
 *
 * 在列举/加载插件前扫一遍 baseDir:
 *   - 孤儿 `.<id>.old-<uuid>` 且 `<id>` 缺失 → rename 回 `<id>`(还原旧版本);
 *   - `<id>` 已存在(更新其实已完成,只是没来得及删 backup)→ 删除残留 backup;
 *   - 残留 `.<id>.installing-<uuid>` staging → 删除。
 * 幂等:无残留时纯 no-op,可安全在每次启动调用。
 */
function parseInterruptedBackupId(name: string): string | null {
  if (name.charCodeAt(0) !== 46) return null;
  const marker = '.old-';
  const markerIndex = name.lastIndexOf(marker);
  if (markerIndex <= 1 || markerIndex + marker.length >= name.length) {
    return null;
  }
  return name.slice(1, markerIndex);
}

function isInterruptedInstallingName(name: string): boolean {
  if (name.charCodeAt(0) !== 46) return false;
  const marker = '.installing-';
  const markerIndex = name.lastIndexOf(marker);
  return markerIndex > 1 && markerIndex + marker.length < name.length;
}

export async function recoverInterruptedInstalls(baseDir: string): Promise<void> {
  // 边界(E82):有界枚举(缺目录 → [] → 循环 no-op,等价旧版早返)。
  const entries = await readPluginDirEntriesCapped(baseDir);
  for (const name of entries) {
    const id = parseInterruptedBackupId(name);
    if (id !== null) {
      const backupPath = path.join(baseDir, name);
      const targetPath = path.join(baseDir, id);
      let targetExists = false;
      try {
        await fs.access(targetPath);
        targetExists = true;
      } catch {
        /* 目标缺失 = 崩在两次 rename 之间 */
      }
      if (targetExists) {
        // 更新已完成,backup 是没删干净的残留 → 清理
        await rm(backupPath, { recursive: true, force: true }).catch(() => {});
      } else {
        // 崩溃中断 → 还原旧版本
        await fs.rename(backupPath, targetPath).catch(() => {});
      }
      continue;
    }
    // 残留 staging(cp 完但还没 swap 就崩)→ 清理
    if (isInterruptedInstallingName(name)) {
      await rm(path.join(baseDir, name), { recursive: true, force: true }).catch(
        () => {},
      );
    }
  }
}

// 边界(E24,E18 同族):插件目录扫描读 manifest/main/styles 的文件大小上限。畸形/恶意插件包可放
// 超大 manifest/main/styles,应用启动或插件列表刷新时主进程整文件读入并经 IPC 传给 renderer →
// 内存峰值/卡死/崩溃。读前 stat.size,超限跳过(manifest/main 缺失即跳过整插件;styles 缺失=无样式),
// 不把超大源码/样式跨 IPC 传输。上限远超任何现实插件(bundled main 数 MB 已罕见)。
const MANIFEST_MAX_BYTES = 1024 * 1024; // 1 MiB
const MAIN_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB(bundled 源码)
const STYLES_MAX_BYTES = 4 * 1024 * 1024; // 4 MiB

export async function readFileCapped(
  filePath: string,
  maxBytes: number,
): Promise<string | null> {
  // 边界(E158,E24 同族 TOCTOU 修正):此前先 `fs.stat(path)` 判 size、再 `fs.readFile(path)` 整文件
  // —— 两次独立按路径解析,检查与读取之间文件可被替换(路径指向新 inode)或增长,绕过大小上限。改用
  // 共享 readFileCappedFd(单 fd open→fstat 同 inode→有界读)。本 helper 对任何错误(含缺失/不可读)
  // 与超限都返 null(跳过该文件;缺 manifest/main=跳过整插件,缺 styles=无样式)。
  try {
    const { text, tooLarge } = await readFileCappedFd(filePath, maxBytes);
    if (tooLarge) {
      console.warn(`[plugins] 跳过超大文件(> ${maxBytes}): ${filePath}`);
      return null;
    }
    return text;
  } catch {
    return null; // 缺失/不可读(open 错误)→ 跳过
  }
}

// 边界(E82,E30/E24 同族):有界枚举插件目录。listPluginDirs / recoverInterruptedInstalls /
// createPluginsWatcher 此前各自 fs.readdir(baseDir) 全量物化 —— 被污染/畸形的 userData/plugins 放入
// 海量条目时,启动恢复 + 插件扫描整目录读入长时间阻塞,watcher 每轮重复扫,放大主进程 CPU/I/O。
// 改用 opendir 惰性迭代,累计到上限即停(超大目录不整目录读入),三处共用单一来源。
// baseDir 缺失/不可读 → []。上限远超任何现实插件数。
const MAX_PLUGIN_DIR_ENTRIES = 1024;

async function readPluginDirEntriesCapped(baseDir: string): Promise<string[]> {
  let dir: import('node:fs').Dir;
  try {
    dir = await fs.opendir(baseDir);
  } catch {
    return []; // baseDir 不存在/不可读 = 无插件
  }
  const names = new Array<string>(MAX_PLUGIN_DIR_ENTRIES);
  let nameCount = 0;
  try {
    for await (const dirent of dir) {
      names[nameCount] = dirent.name;
      nameCount += 1;
      if (nameCount >= MAX_PLUGIN_DIR_ENTRIES) {
        console.warn(
          `[plugins] 目录条目截断到 ${MAX_PLUGIN_DIR_ENTRIES}(超大/被污染?): ${baseDir}`,
        );
        break; // for-await break 自动 close dir
      }
    }
  } catch {
    // 迭代中途错误 → 返回已收集(best-effort)
  }
  names.length = nameCount;
  return names;
}

// 边界(E68,E18/E26/E66/E67 stat-before-read 族):插件持久化元数据 _enabled.json /
// _permissions.json / _path_scopes.json 此前裸 fs.readFile + JSON.parse,数量/字段/路径上限都在
// 解析后才生效;path-scopes 损坏还把完整 text 写 .corrupt。畸形或手工放大的元数据可在启动/list/
// 权限写入前撑爆 main 内存或长阻塞,.corrupt 二次放大 I/O。读前先 stat.size 硬拦。与 readFileCapped
// (返 null)不同:此 helper **透传错误**(stat ENOENT→保留调用方「缺文件=空表」语义;EACCES/
// too-large→抛 → 调用方既有「非 ENOENT=当前态未知,绝不降级空表触发 RMW 抹其它 plugin」契约)。
const METADATA_MAX_BYTES = 1024 * 1024; // 1 MiB:元数据是小 JSON(id 列表/决策表/scope 表)

async function readMetadataCapped(filePath: string): Promise<string> {
  // 边界(E159,E158 兄弟 TOCTOU 修正):改用共享 readFileCappedFd(单 fd open→fstat 同 inode→有界读)。
  // **错误契约保持**:open 的 ENOENT/EACCES 直接透传(ENOENT=调用方「缺文件=空表」;非 ENOENT=当前态
  // 未知绝不降级空表触发 RMW);too-large 抛无 code 的普通 Error → 调用方走「非 ENOENT→throw」路径。
  const { text, tooLarge, size } = await readFileCappedFd(
    filePath,
    METADATA_MAX_BYTES,
  );
  if (tooLarge) {
    throw new Error(
      `plugin metadata file too large (${size} > ${METADATA_MAX_BYTES}): ${filePath}`,
    );
  }
  return text as string; // tooLarge=false 时 text 必为 string
}

export async function listPluginDirs(baseDir: string): Promise<IpcPluginDir[]> {
  // 边界(E82):有界枚举(缺目录 → [] → 返回空列表,等价旧版)。
  const entries = await readPluginDirEntriesCapped(baseDir);

  const out = new Array<IpcPluginDir>(entries.length);
  let outCount = 0;
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

    // 边界(E24):manifest 超 1MiB(或缺失/不可读)→ 跳过整插件,不整文件读入 + IPC 传输。
    const manifestText = await readFileCapped(
      path.join(dir, 'manifest.json'),
      MANIFEST_MAX_BYTES,
    );
    if (manifestText === null) continue;

    // 解析 manifest.main(若失败用默认 main.js,M20:共用 getPluginMainName)
    let mainName = 'main.js';
    try {
      mainName = getPluginMainName(JSON.parse(manifestText));
    } catch {
      // manifest 解析失败由 renderer 端 parseManifest 报错,我们继续给 mainText 尝试默认
    }

    const mainPath = resolvePluginMainPath(dir, mainName);
    if (!mainPath) continue;
    // 边界(E24):main 超 8MiB(或缺失/不可读)→ 跳过整个 plugin。
    const mainText = await readFileCapped(mainPath, MAIN_MAX_BYTES);
    if (mainText === null) continue;

    // 边界(E24):styles 超 4MiB(或缺失)→ 当无样式(undefined),不阻断插件。
    const stylesText =
      (await readFileCapped(path.join(dir, 'styles.css'), STYLES_MAX_BYTES)) ??
      undefined;

    out[outCount] = { id, manifestText, mainText, stylesText };
    outCount += 1;
  }
  out.length = outCount;
  return out;
}

const ENABLED_FILE = '_enabled.json';
// 边界(E85,E74 字段上限族 / 数据完整性):_enabled.json 读盘此前只校验 array-of-string,不校验
// id 格式/长度/数量。手工/旧版本残留的 1MiB JSON(E68 文件大小已封顶,但内可塞数十万短串或非法/
// 超长 id)能通过 array-of-string 校验 → readEnabledIds → new Set → PluginManager.init 放大 CPU/内存,
// 且 setEnabledId 的 RMW 把这些非法/超量 id 原样写回,绕过写 IPC schema 上限。读盘按写端同一契约
// canonicalize:仅保留 isSafePluginId 且长度≤PLUGIN_ID_MAX 的 id、去重、数量≤MAX_ENABLED_IDS。
const PLUGIN_ID_MAX = 256; // 对齐 manifest id 上限(E74 NAME_MAX)
const MAX_ENABLED_IDS = 4096; // 远超任何现实启用插件数

export async function readEnabledIds(baseDir: string): Promise<string[]> {
  const file = path.join(baseDir, ENABLED_FILE);
  // 数据安全:区分「缺文件」与「损坏/IO 错误」(与 readPermissions/readAllPathScopes 同型)。
  // 仅 ENOENT 是首次启动 → []。EACCES/EIO 等读错误是「当前态未知」,不能当空列表 —— 否则
  // PluginManager.mutateEnabledIds 基于 [] 做 RMW 写回,抹掉其它已启用插件。抛出 → host 端
  // 传播(见 plugins-host),mutate 中止写、init 降级。
  let text: string;
  try {
    text = await readMetadataCapped(file); // 边界(E68):读前 stat.size 硬拦
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  try {
    const json = JSON.parse(text) as unknown;
    if (Array.isArray(json)) {
      // 边界(E206,E197-E199 有界迭代族-数组变体):类型校验并入 capped 循环,不先 json.every() 全量
      // 遍历 —— 畸形 _enabled.json 的海量短串否则在 MAX_ENABLED_IDS 生效前被完整扫描(削弱数量上限防放大)。
      // 遇非字符串即按既有契约返 [](保持 every 的"任一非字符串→整文件非法",且早停不续扫)。
      // 边界(E85):按写端契约 canonicalize —— 合法 id(isSafePluginId + 长度上限)+ 去重 + 数量封顶。
      const seen = new Set<string>();
      const out = new Array<string>(Math.min(json.length, MAX_ENABLED_IDS));
      let outCount = 0;
      for (const x of json) {
        if (typeof x !== 'string') return [];
        if (x.length > PLUGIN_ID_MAX || !isSafePluginId(x)) continue;
        if (seen.has(x)) continue;
        seen.add(x);
        out[outCount] = x;
        outCount += 1;
        if (outCount >= MAX_ENABLED_IDS) break;
      }
      out.length = outCount;
      return out;
    }
    return [];
  } catch {
    return []; // JSON 损坏 → [](既有契约)
  }
}

export async function writeEnabledIds(
  baseDir: string,
  ids: readonly string[],
): Promise<void> {
  await fs.mkdir(baseDir, { recursive: true });
  const file = path.join(baseDir, ENABLED_FILE);
  // 数据安全:与 writePermissions / writePluginPathScopes 同族 —— 裸 writeFile 截断窗口
  // 会留半截 JSON,readEnabledIds 损坏即降级 [] → 重启后所有插件被禁用。atomicWriteJson
  // 已导入,原子写成本为零,三个持久化写入口统一(原「列表小不投资 atomic」理由已不成立)。
  await atomicWriteJson(file, ids);
}

// _enabled.json 的 read-modify-write 主进程全局串行链。
// 数据安全(codex 复查 P1):此前 RMW 在 renderer 的 PluginManager 内做,串行锁是
// per-PluginManager 实例;每个窗口各有自己的 PluginManager(main-app.ts),两个窗口
// 同时 enable/disable 不同插件时各读旧集合、整表写回,后写者覆盖先写者 → 某插件启用
// 状态重启后丢失(跨窗口 lost update)。把 RMW 收口到 main 端单条 Promise 链(镜像
// permissionsWriteChain / pathScopesWriteChain),renderer 改传 delta(id, enabled)。
let enabledWriteChain: Promise<unknown> = Promise.resolve();

/**
 * 启用/禁用单个插件 id(主进程全局串行 delta 写)。
 * enabled=true → 加入集合;false → 移除。读改写在同一链内原子完成,跨窗口无 lost update。
 */
export function setEnabledId(
  baseDir: string,
  id: string,
  enabled: boolean,
): Promise<void> {
  const run = enabledWriteChain.then(async () => {
    const current = await readEnabledIds(baseDir);
    const ids = new Set(current);
    const hasId = ids.has(id);
    if (enabled) {
      if (hasId) return;
      ids.add(id);
    } else {
      if (!hasId) return;
      ids.delete(id);
    }
    await writeEnabledIds(baseDir, [...ids]);
  });
  enabledWriteChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

// ── v4.2 权限决策持久化 ─────────────────────────────────

const PERMISSIONS_FILE = '_permissions.json';
// 边界(E87,E85/E86 数据完整性族 / E5 时间戳):_permissions.json 读盘按写端 + 业务枚举 canonicalize。
// permission 必须是 PERMISSION_KEYS 成员(否则 PERM_LABEL_KEYS[perm]=undefined 渲染崩),decidedAt 必须
// finite(1e400 经 JSON.parse=Infinity 但 typeof 仍 number,同 E5)。每插件 decisions 数 + plugin key 数
// 封顶(对齐 IPC 写端 DECISIONS_MAX/PLUGINS_MAX,防 RMW 写回绕过写端上限)。
const MAX_DECISIONS_PER_PLUGIN = 1000; // 对齐 plugins.ipc DECISIONS_MAX
const MAX_PERMISSION_PLUGIN_KEYS = 10_000; // 对齐 plugins.ipc PLUGINS_MAX
const PERMISSION_KEY_SET: ReadonlySet<string> = new Set(PERMISSION_KEYS);

function isDecision(x: unknown): x is IpcPermissionDecision {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.permission === 'string' &&
    PERMISSION_KEY_SET.has(o.permission) && // 边界(E87):必须是业务枚举成员
    typeof o.granted === 'boolean' &&
    typeof o.decidedAt === 'number' &&
    Number.isFinite(o.decidedAt) // 边界(E87/E5):非有限时间戳拒
  );
}

/**
 * 边界(E207,E206/E197-E199 有界迭代族):"上限内全有效、凑满即停"的有界校验。按序校验数组元素:
 *  - 凑满 max(收集到 max 个)→ 立即 break,**不再校验其余**(有界,挡畸形超长数组在 cap 前被 .every 全扫);
 *  - 上限内任一非法 → 返 null(保留旧 `.every(isValid)` 的"任一非法→整组丢弃"契约,见对象形态 decisions
 *    非法→pluginId 跳过的测试)。
 * 仅"非法项落在 max 之后"的病态边界从"整组丢弃"变为"保留前 max 个"(可接受;真实数据远小于 cap)。
 */
function cappedAllValid<T>(
  arr: readonly unknown[],
  isValid: (x: unknown) => x is T,
  max: number,
): T[] | null {
  let out: T[] | null = null;
  let outCount = 0;
  for (const x of arr) {
    if (outCount >= max) break;
    if (!isValid(x)) return null;
    out ??= new Array<T>(Math.min(arr.length, max));
    out[outCount] = x;
    outCount += 1;
  }
  if (out === null) return [];
  out.length = outCount;
  return out;
}

/**
 * 边界(E208,E207 filter 语义对偶):"收集合法项、跳过非法、凑满即停"的有界 filter+cap。与 cappedAllValid
 * 的区别:非法项**跳过**(不丢整组),收集到 max 个合法项即 break。替代 `arr.filter(isValid).slice(0, max)`
 * —— 后者先 filter 全量扫描 + 物化全部合法项再 slice,畸形超长数组在 cap 前被完整遍历。
 */
function collectValidCapped<T>(
  arr: readonly unknown[],
  isValid: (x: unknown) => x is T,
  max: number,
): T[] {
  let out: T[] | null = null;
  let outCount = 0;
  for (const x of arr) {
    if (outCount >= max) break;
    if (isValid(x)) {
      out ??= new Array<T>(Math.min(arr.length, max));
      out[outCount] = x;
      outCount += 1;
    }
  }
  if (out === null) return [];
  out.length = outCount;
  return out;
}

function collectMappedValidCapped<T, U>(
  arr: readonly unknown[],
  isValid: (x: unknown) => x is T,
  mapValid: (x: T) => U,
  max: number,
): U[] {
  let out: U[] | null = null;
  let outCount = 0;
  for (const x of arr) {
    if (outCount >= max) break;
    if (isValid(x)) {
      out ??= new Array<U>(Math.min(arr.length, max));
      out[outCount] = mapValid(x);
      outCount += 1;
    }
  }
  if (out === null) return [];
  out.length = outCount;
  return out;
}

function pathScopesEqual(
  a: readonly IpcPathScope[] | undefined,
  b: readonly IpcPathScope[],
): boolean {
  if (a === undefined || a.length !== b.length) return false;
  for (let i = 0; i < b.length; i += 1) {
    const left = a[i]!;
    const right = b[i]!;
    if (left.path !== right.path || left.mode !== right.mode) return false;
  }
  return true;
}

function permissionDecisionsEqual(
  a: readonly IpcPermissionDecision[] | undefined,
  b: readonly IpcPermissionDecision[],
): boolean {
  if (a === undefined || a.length !== b.length) return false;
  for (let i = 0; i < b.length; i += 1) {
    const left = a[i]!;
    const right = b[i]!;
    if (
      left.permission !== right.permission ||
      left.granted !== right.granted ||
      left.decidedAt !== right.decidedAt
    ) {
      return false;
    }
  }
  return true;
}

function permissionRecordEqual(
  existing: IpcPermissionRecord | undefined,
  decisions: readonly IpcPermissionDecision[],
  scopes: readonly IpcPathScope[] | undefined,
): boolean {
  if (existing === undefined) return false;
  if (Array.isArray(existing)) {
    return (
      scopes === undefined && permissionDecisionsEqual(existing, decisions)
    );
  }
  const objectRecord = existing as {
    readonly decisions: readonly IpcPermissionDecision[];
    readonly pathScopes?: readonly IpcPathScope[];
  };
  return (
    scopes !== undefined &&
    permissionDecisionsEqual(objectRecord.decisions, decisions) &&
    pathScopesEqual(objectRecord.pathScopes, scopes)
  );
}

export async function readPermissions(
  baseDir: string,
): Promise<IpcPermissionsMap> {
  const file = path.join(baseDir, PERMISSIONS_FILE);
  // 数据安全:区分「缺文件」与「损坏/IO 错误」(与 readAllPathScopes #12 同型)。只有
  // ENOENT 是首次启动 → {}。EACCES/EIO 等读错误是「当前态未知」,不能当空表 —— 否则
  // writePluginPermissions 基于 {} 做整表 RMW,抹掉其它 plugin 已落盘的授权决策。抛出 →
  // writePluginPermissions / uninstall 在删/写前中止,renderer 经 safeHandle 降级。
  let text: string;
  try {
    text = await readMetadataCapped(file); // 边界(E68):读前 stat.size 硬拦
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  try {
    const json = JSON.parse(text) as unknown;
    if (!json || typeof json !== 'object' || Array.isArray(json)) return {};
    const out: Record<string, IpcPermissionRecord> = {};
    let keyCount = 0;
    // 边界(E199,E197/E198 同族有界迭代):for...in 单次惰性遍历,不先 Object.entries 把被污染数据文件
    // 的所有 plugin key 全量物化(再 break=上限失效)。E68 raw-size cap 是 backstop,但其内仍可塞大量短 key。
    const rec0 = json as Record<string, unknown>;
    for (const pid in rec0) {
      if (!Object.prototype.hasOwnProperty.call(rec0, pid)) continue;
      const value = rec0[pid];
      // 边界(E87):读盘按写端契约 canonicalize —— 非法/超长 plugin key 跳过、key 数封顶。
      if (!isSafePluginId(pid) || pid.length > PLUGIN_ID_MAX) continue;
      if (keyCount >= MAX_PERMISSION_PLUGIN_KEYS) break;
      let rec: IpcPermissionRecord | null = null;
      // 边界(E207,E206 同族):用 cappedAllValid 有界校验,替代 `value.every(isDecision)`(在 slice 前
      // 全量扫描数组)+ isPermissionRecordObject 的 `.every`。凑满上限即停,上限内任一非法 → 整条丢弃。
      if (Array.isArray(value)) {
        // 旧数组形态:capped 校验 decisions(上限内任一非法 → null → 整条 plugin 记录丢弃)
        rec = cappedAllValid(value, isDecision, MAX_DECISIONS_PER_PLUGIN);
      } else if (value !== null && typeof value === 'object') {
        // 新 { decisions, pathScopes? } 形态:decisions 必为数组且上限内全合法;pathScopes 同理(若存在)
        const o = value as Record<string, unknown>;
        if (Array.isArray(o.decisions)) {
          const decisions = cappedAllValid(
            o.decisions,
            isDecision,
            MAX_DECISIONS_PER_PLUGIN,
          );
          if (decisions !== null) {
            if (o.pathScopes === undefined) {
              rec = { decisions };
            } else if (Array.isArray(o.pathScopes)) {
              const pathScopes = cappedAllValid(
                o.pathScopes,
                isIpcPathScope,
                MAX_PERSISTED_SCOPES_PER_PLUGIN,
              );
              if (pathScopes !== null) rec = { decisions, pathScopes };
            }
          }
        }
      }
      if (rec !== null) {
        out[pid] = rec;
        keyCount += 1;
      }
    }
    return out;
  } catch {
    return {}; // JSON 损坏 → {}(既有契约,见 plugins-service.spec「JSON 损坏 → {}」)
  }
}

export async function writePermissions(
  baseDir: string,
  data: IpcPermissionsMap,
): Promise<void> {
  await fs.mkdir(baseDir, { recursive: true });
  const file = path.join(baseDir, PERMISSIONS_FILE);
  // 数据安全(codex 复查 P1):裸 writeFile('w') 先截断再写,ENOSPC/进程被杀/写中断会把
  // 整张授权表留成空/半截 JSON → 重启 readPermissions 按既有契约把损坏 JSON 降级为 {},
  // 所有 plugin 授权决策丢失。改 temp+fsync+rename 原子写:rename 前原文件始终完好,
  // 写失败也不动原文件(与 writeEnabledIds / writePluginPathScopes 同族修复)。
  await atomicWriteJson(file, data);
}

// 同文件 read-modify-write 串行化,防多窗口/并发授权互相覆盖(镜像
// pathScopesWriteChain / installLocks 思路)。
let permissionsWriteChain: Promise<unknown> = Promise.resolve();

/**
 * 数据安全:按**单个 plugin** 合并写 `_permissions.json`。此前 renderer 整表写回,
 * 每窗口各自缓存陈旧快照,多窗口/并发授权后写者会抹掉先写者对**其它 plugin** 的
 * 决策/pathScopes(lost update)。改为 main 端 read-merge-write 单条记录并串行化,
 * 写某 plugin 只覆盖该 id,保留其它 id 已落盘内容。空记录(无决策且无 pathScopes)
 * → 删除该 id 条目。非法 id 忽略(防注入畸形 key)。
 */
export function writePluginPermissions(
  baseDir: string,
  id: string,
  record: IpcPermissionRecord,
): Promise<void> {
  const run = permissionsWriteChain.then(async () => {
    if (!isSafePluginId(id)) return;
    // Array.isArray 不收窄 readonly[] union 分支,显式 cast 对象形态.
    const decisionsRaw = Array.isArray(record)
      ? record
      : (record as { decisions: readonly IpcPermissionDecision[] }).decisions;
    const scopesRaw = Array.isArray(record)
      ? undefined
      : (record as { pathScopes?: readonly IpcPathScope[] }).pathScopes;
    // 边界(E247,E246 写读 cap 对称族 / E208 有界收集):服务层写端也按 MAX 上限收集,与 readPermissions
    // 同步。此前裸 .filter() 无数量上限 —— exported service 入口可被测试/未来内部调用绕过 IPC schema
    // (PATHSCOPES_MAX/DECISIONS_MAX),写入超量记录返回成功,但 readPermissions 又按上限截断 → 写成功读回
    // 丢数据 + 写链全量物化卡顿。collectValidCapped:跳过非法 + 凑满 MAX 即停(保留 .filter 跳过非法语义)。
    const decisions = collectValidCapped(
      decisionsRaw ?? [],
      isDecision,
      MAX_DECISIONS_PER_PLUGIN,
    );
    const scopes =
      scopesRaw === undefined
        ? undefined
        : collectValidCapped(
            scopesRaw,
            isIpcPathScope,
            MAX_PERSISTED_SCOPES_PER_PLUGIN,
          );
    const isEmpty =
      decisions.length === 0 && (scopes === undefined || scopes.length === 0);

    const all = { ...(await readPermissions(baseDir)) };
    if (isEmpty) {
      if (!(id in all)) return; // 无变化,不为删空条目而触盘
      delete all[id];
    } else {
      if (permissionRecordEqual(all[id], decisions, scopes)) return;
      all[id] =
        scopes === undefined ? decisions : { decisions, pathScopes: scopes };
    }
    await writePermissions(baseDir, all);
  });
  permissionsWriteChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

// ── path-scope 持久化(plugin-fs 授权跨重启保留)──────────────
//
// 设计:与决策(_permissions.json,renderer 写)分文件,由主进程独占读写
// `_plugin-path-scopes.json`,规避跨进程并发覆盖。grant 时由 request-scope handler
// 写入;冷启动由 handler 读回水合进 PathScopeRegistry;uninstall 连同 id 一并清除
// (防同 id 重装继承旧 scope,与 _permissions.json 清理对称)。

const PATH_SCOPES_FILE = '_plugin-path-scopes.json';
// 边界(E86,E85/E74 数据完整性族):_plugin-path-scopes.json 读盘按写端契约 canonicalize。
// 手工/旧残留的 1MiB 元数据可塞大量非法 key / 超长 path / 超量 scope 通过既有「value 是数组 +
// isIpcPathScope」校验,进 readPluginPathScopes→hydrate→mergeScopes 前先构造整表,且
// writePluginPathScopes 的 RMW 会把其它非法/超量 plugin 条目原样写回(绕过写端契约)。
const PATH_SCOPE_PATH_MAX = 8192; // 单条 scope path 长度上限(对齐 E31 request-scope path 上限)
const MAX_PERSISTED_SCOPES_PER_PLUGIN = 256; // 对齐 PathScopeRegistry MAX_SCOPES_PER_PLUGIN(E81)
const MAX_PERSISTED_PLUGIN_KEYS = 4096; // 持久化表的 plugin key 数上限

function isIpcPathScope(x: unknown): x is IpcPathScope {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.path === 'string' &&
    o.path.length <= PATH_SCOPE_PATH_MAX && // 边界(E86):超长 path 拒(防元数据放大)
    (o.mode === 'r' || o.mode === 'rw')
  );
}

async function readAllPathScopes(
  baseDir: string,
): Promise<Record<string, IpcPathScope[]>> {
  const file = path.join(baseDir, PATH_SCOPES_FILE);
  // 数据安全:必须区分「缺文件」(正常空表)与「损坏/IO 错误」(当前态未知)。此前两者
  // 都 catch→{},而 writePluginPathScopes 基于此做整表 RMW → 文件临时损坏时任意 plugin
  // grant/uninstall 会以空表覆盖,抹掉其它 plugin 已持久化的 scope。损坏时存 .corrupt
  // 快照后抛错,让写入中止(磁盘保留)、让水合读降级返回 [](见 readPluginPathScopes)。
  let text: string;
  try {
    text = await readMetadataCapped(file); // 边界(E68):读前 stat.size 硬拦
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}; // 缺文件:正常空表
    throw err; // 权限等 IO 错误 / too-large:不可当空表(否则 RMW 整表覆盖抹掉已有)
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    await fs.writeFile(`${file}.corrupt`, text, { flag: 'wx' }).catch(() => {});
    throw new Error(`path-scopes file corrupt: ${file}`);
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return {};
  const out: Record<string, IpcPathScope[]> = {};
  let keyCount = 0;
  // 边界(E199,E197/E198 同族有界迭代):for...in 单次惰性遍历,不先 Object.entries 全量物化(readPermissions 同步修)。
  const rec0 = json as Record<string, unknown>;
  for (const pid in rec0) {
    if (!Object.prototype.hasOwnProperty.call(rec0, pid)) continue;
    const value = rec0[pid];
    // 边界(E86):读盘按写端契约 canonicalize —— 非法/超长 key 跳过(防注入畸形 key + 元数据放大),
    // key 数封顶。isSafePluginId 与 writePluginPathScopes 写端门控一致。
    if (!isSafePluginId(pid) || pid.length > PLUGIN_ID_MAX) continue;
    if (keyCount >= MAX_PERSISTED_PLUGIN_KEYS) break;
    if (!Array.isArray(value)) continue;
    // 边界(E86):scope 经 isIpcPathScope(含 path 长度上限)过滤,且每插件 scope 数封顶
    //(对齐 PathScopeRegistry 上限,防整表在 hydrate 前放大 + RMW 写回超量)。
    // 边界(E208,E206/E207 有界迭代族):collectValidCapped 凑满 MAX 即停,不先 filter 全量扫描+物化再 slice
    //(畸形 _path-scopes.json 单 plugin 塞大量 scope 否则冷启动水合时被完整遍历)。
    const scopes = collectValidCapped(
      value,
      isIpcPathScope,
      MAX_PERSISTED_SCOPES_PER_PLUGIN,
    );
    if (scopes.length > 0) {
      out[pid] = scopes;
      keyCount += 1;
    }
  }
  return out;
}

/** 读取单个 plugin 上次会话持久化的 path scope(canonical);无则空数组。 */
export async function readPluginPathScopes(
  baseDir: string,
  id: string,
): Promise<IpcPathScope[]> {
  try {
    const all = await readAllPathScopes(baseDir);
    return all[id] ?? [];
  } catch {
    // 损坏/IO 错误 → 本次冷启动不水合该 scope(插件会重新请求授权),fail-safe 降级。
    return [];
  }
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
    // 边界(E249,E247 兄弟入口):service 层写端按 MAX_PERSISTED_SCOPES_PER_PLUGIN 有界收集,与
    // readAllPathScopes 同步。此前裸 .filter().map() 无数量上限 —— exported service 入口可被进程内/未来
    // 调用绕过 IPC schema(PATHSCOPES_MAX=256),写超量 scope 落盘成功但 readAllPathScopes 只读回前 256 →
    // 写成功重启读回丢数据 + 全量物化卡顿。collectValidCapped 凑满 MAX 即停(同 writePluginPermissions E247)。
    const normalized = collectMappedValidCapped(
      scopes,
      isIpcPathScope,
      (s) => ({ path: s.path, mode: s.mode }),
      MAX_PERSISTED_SCOPES_PER_PLUGIN,
    );
    if (normalized.length === 0) {
      if (!(id in all)) return; // 无变化,不为删除空条目而触盘
      delete all[id];
    } else {
      if (pathScopesEqual(all[id], normalized)) return;
      all[id] = normalized;
    }
    await fs.mkdir(baseDir, { recursive: true });
    const file = path.join(baseDir, PATH_SCOPES_FILE);
    // 数据安全:同 writePermissions —— 裸 writeFile 截断窗口会留半截 JSON,
    // readAllPathScopes 损坏即抛 → 水合降级 [],已授 path scope 丢失。原子写。
    await atomicWriteJson(file, all);
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

// 同 id 主进程 mutation 串行化:install / update / uninstall 共用,防同插件目录的并发写互相踩
// (审计 #5)。race(R107):卸载此前不走此锁 → 一个窗口卸载、另一窗口安装/更新同 id 时,卸载的
// rm(targetDir) 可能删掉刚 rename 就位的新版本,或清掉新安装应保留的元数据 →「安装成功但插件消失/
// 状态不一致」。把卸载也纳入同一 per-id 锁,故从 withInstallLock 改名 withPluginMutationLock。
// race(R101):排空回收收口到共享 runSerialPerKey(原 inline 副本漏删 key → Map 随用过的 id 单调
// 增长内存泄漏)。
const pluginMutationLocks = new Map<string, Promise<unknown>>();
function withPluginMutationLock<T>(
  id: string,
  fn: () => Promise<T>,
): Promise<T> {
  return runSerialPerKey(pluginMutationLocks, id, fn);
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
  // race(R107):卸载全段(access → 元数据清理 → rm)纳入同 id 主进程 mutation 锁,与 installFromGit
  // 的 swap(access → rename 就位)互斥串行。否则跨窗口「卸载 vs 安装/更新同 id」交错:卸载的
  // rm(targetDir) 可能删掉刚 rename 就位的新版本,或清掉新安装应保留的元数据 → 安装成功却插件消失/
  // 状态不一致。id 校验廉价、无副作用,放锁外。
  return withPluginMutationLock(id, async () => {
    const targetDir = path.join(baseDir, id);
    try {
      await fs.access(targetDir);
    } catch {
      throw Object.assign(new Error(`插件未安装: ${id}`), {
        code: ERROR_CODES.NOT_INSTALLED,
      });
    }
    // 数据安全(codex P1):先清「会抛的」持久化元数据,**再**删目录(fail-fast)。旧顺序
    // 先删目录后清元数据,若清理抛错(如 writePluginPathScopes 在 scopes 文件损坏时抛 —— 见
    // #12)会留下「目录已删但卸载 reject」的半提交:PluginManager.uninstall 不 entries.delete,
    // 重试又因目录缺失走 NOT_INSTALLED → 卡死不可重试。改为元数据清理在前,任一失败在删目录
    // 前抛出 → 卸载可整体重试(清理幂等),不留半提交。

    // 清 _enabled.json 中的 id(防止 reload 复活已删插件)。数据安全(codex P1):必须走
    // setEnabledId 的全局串行链 —— 此前手写 readEnabledIds→filter→writeEnabledIds 绕过
    // enabledWriteChain,与跨窗口 enable/disable 并发时用旧快照整表写回 → 丢别窗口刚启用
    // 的插件,或被并发 enable 写回旧 id(重装继承已启用)。delta 写在链内 RMW、仍在删目录前。
    await setEnabledId(baseDir, id, false);

    // 清 _permissions.json 中的 id(避免重装继承旧授权)。readPermissions 损坏降级 {},不抛。
    const perms = await readPermissions(baseDir);
    if (id in perms) {
      const next = { ...perms };
      delete (next as Record<string, unknown>)[id];
      await writePermissions(baseDir, next);
    }

    // 清 _plugin-path-scopes.json 中的 id(避免重装继承旧 path scope,与上方对称)。
    // writePluginPathScopes 在 scopes 文件损坏时会抛(#12),但损坏文件本就不会被同 id 重装
    // 继承(readPluginPathScopes 损坏降级 []),故此处 best-effort:清理失败不阻断卸载
    // (.corrupt 快照已由 readAllPathScopes 留存),避免一个损坏文件永久卡住所有卸载。
    try {
      await writePluginPathScopes(baseDir, id, []);
    } catch (err) {
      console.warn(
        `[uninstall] path-scope cleanup failed (corrupt scopes file?): ${id}`,
        err,
      );
    }

    // 元数据已清,最后删目录。失败 → RM_FAILED,可整体重试(上面清理幂等)。
    try {
      await rm(targetDir, { recursive: true, force: true });
    } catch (err) {
      throw Object.assign(new Error(`删除失败: ${errorMessage(err)}`), {
        code: ERROR_CODES.RM_FAILED,
      });
    }
  });
}

export interface InstallFromGitResult {
  readonly id: string;
  readonly name: string;
  readonly version: string;
}

// 仅允许 https(去掉 git://明文无认证、ssh://可被指向内网做 SSRF/探测)。
function startsWithHttpsScheme(url: string): boolean {
  return (
    url.length >= 8 &&
    (url.charCodeAt(0) | 32) === 104 &&
    (url.charCodeAt(1) | 32) === 116 &&
    (url.charCodeAt(2) | 32) === 116 &&
    (url.charCodeAt(3) | 32) === 112 &&
    (url.charCodeAt(4) | 32) === 115 &&
    url.charCodeAt(5) === 58 &&
    url.charCodeAt(6) === 47 &&
    url.charCodeAt(7) === 47
  );
}
const GIT_CLONE_TIMEOUT_MS = 60_000;
// 边界(E62,E1/E61 累积缓冲族):runGit 的 git 子进程 stderr 此前 `stderr += String(d)` 无限累积,
// 失败时整段拼进 Error message。恶意/异常远端或协议错误可产生超大 stderr → main 内存膨胀 + 巨大
// 错误串传到 renderer/UI。stderr 累积上限 64KB(保留前 64KB,git 的 fatal 行通常在前部),超限停止
// 追加并标记截断;**不 kill 子进程**——git clone 进度本就走 stderr,大仓库进度可合法 >64KB,kill
// 会误伤合法克隆;只 bound 内存。失败 message 只带截断摘要 + 标记。
const MAX_GIT_STDERR_BYTES = 64 * 1024;

/**
 * 从 git URL clone 到临时目录,验 manifest.json,把整个目录复制到
 * baseDir/<manifest.id>/。已存在 → 抛 EEXIST 让调用方提示用户。
 */
export async function installFromGit(
  gitUrl: string,
  baseDir: string,
  opts: { overwrite?: boolean } = {},
): Promise<InstallFromGitResult> {
  if (!startsWithHttpsScheme(gitUrl)) {
    throw Object.assign(new Error(`不支持的 git URL: ${gitUrl}`), {
      code: ERROR_CODES.BAD_URL,
    });
  }
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'lm-plugin-install-'));
  try {
    const cloneDir = path.join(tmpRoot, 'clone');
    await runGit(['clone', '--depth', '1', gitUrl, cloneDir]);

    // 边界(E27,E24 兄弟):安装路径读 clone 的 manifest.json 也走 readFileCapped(同
    // MANIFEST_MAX_BYTES),与 listPluginDirs 启动扫描一致。clone 来自外部 git 仓库,manifest
    // 内容不可控;裸 fs.readFile 整块读入超大 manifest → 内存峰值。超限/缺失/不可读 → 返 null →
    // 抛 BAD_MANIFEST,在任何 cp/rename 复制替换插件目录之前 fail-fast 中止。
    const text = await readFileCapped(
      path.join(cloneDir, 'manifest.json'),
      MANIFEST_MAX_BYTES,
    );
    if (text === null) {
      throw Object.assign(
        new Error('clone 目录缺 manifest.json、不可读或超过大小上限'),
        { code: ERROR_CODES.BAD_MANIFEST },
      );
    }
    // 边界(E100):安装路径复用 parseManifest(ManifestSchema)—— 与启动扫描 listPluginDirs/
    // parseManifest 同契约(字段长度/semver/permissions 枚举数量/main 长度全校验)。此前仅检查
    // id/name/version 是 string + id 安全,远程仓库可装 version 非 semver、name 近 1MiB、permissions
    // 畸形的插件:安装 UI 显示成功,但下次扫描 parseManifest 按 schema 拒载 / 超长字段带进 marketplace/
    // 插件列表放大 →「安装成功但重启刷新不可用」。失败统一 BAD_MANIFEST。
    const result = parseManifest(text);
    if (!result.ok) {
      throw Object.assign(new Error(`manifest 校验失败: ${result.message}`), {
        code: ERROR_CODES.BAD_MANIFEST,
      });
    }
    const manifest = result.data;
    // 边界:ManifestSchema 的 id 正则 /^[a-z0-9._-]+$/ 允许纯点段(如 '..'),不挡路径穿越;
    // isSafePluginId 额外拒 '.'/'..'(install→rename 覆盖父目录的穿越向量,与 uninstall 对称),必叠加。
    if (!isSafePluginId(manifest.id)) {
      throw Object.assign(new Error('manifest id 含非法字符或路径穿越'), {
        code: ERROR_CODES.BAD_MANIFEST,
      });
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
    return await withPluginMutationLock(pluginId, async () => {
      let targetExists = false;
      try {
        await fs.access(targetDir);
        targetExists = true;
      } catch (err) {
        // 数据安全(codex 复查 P1,「只认 ENOENT」族):仅 ENOENT 是「确实不存在」。
        // EACCES/EIO/ELOOP = 目标状态未知 —— 不能当不存在,否则:overwrite:false 的已存在守卫
        // 被绕过;或 overwrite 时 targetExists=false → backup=null → rename(staging,target)
        // 直接覆盖一个可达的已安装目录/链接(无备份、不可回滚)= 丢已装插件。非 ENOENT 在
        // cp/rename 前 fail-closed 抛出中止。
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        /* ENOENT = not exists, OK */
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
    // 边界(E62 + E131):按真实 UTF-8 字节累积/截断,decode 延后整体进行(见 byte-capped-buffer)。
    const stderrCap = createByteCappedBuffer(MAX_GIT_STDERR_BYTES);
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
    // 边界(E62 + E131):按真实字节累积上限,超限停止追加(保留前 64KB 字节)+ 标记截断,不 kill
    //(进度合法 >64KB)。
    child.stderr.on('data', (d: Buffer) => stderrCap.push(d));
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
              new Error(
                `git ${args[0]} exit ${code}: ${stderrCap.text().trim()}${stderrCap.truncated ? ' …(stderr truncated)' : ''}`,
              ),
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
  // race(R5):tick 异步扫描(readdir+stat+readFile)慢于 interval 时,setInterval 会并发触发多个
  // tick,并发读写共享的 mtimes/firstRun —— 并发的 first-run 扫描都按 firstRun=true 吞掉实际变更,
  // 或交错写 mtimes 致重复 onChange/reload。单飞守卫:同一时刻只跑一个扫描;期间新 tick 标记
  // pending,当前扫描结束后补跑一次。mtimes/firstRun 只在串行的 runScan 内更新。
  let running = false;
  let pending = false;

  const runScan = async (): Promise<void> => {
    if (cancelled) return;
    // 边界(E82):有界枚举(缺目录 → [] → 循环 no-op,等价旧版早返)。
    const entries = await readPluginDirEntriesCapped(baseDir);
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
      // 边界(E27,E24/listPluginDirs 同源):watcher 扫描读 manifest 也走 readFileCapped
      //(同 MANIFEST_MAX_BYTES),避免超大 manifest 整块读入。超限/缺失 → 跳过该插件目录。
      const text = await readFileCapped(
        path.join(dir, 'manifest.json'),
        MANIFEST_MAX_BYTES,
      );
      if (text === null) continue;
      try {
        const m = JSON.parse(text) as { main?: unknown; id?: unknown };
        mainName = getPluginMainName(m); // M20:共用 getPluginMainName
        // 边界(E101,E97/E100 id 前门一致性):manifest.id 复用 isSafePluginId + 长度上限。此前仅
        // typeof+非空 → 畸形本地插件可用超长/非法 id 当 mtimes key + 经 PLUGINS_CHANGED 广播到
        // renderer,PluginManager reload 找不到合法 entry 或把超长 id 带进日志/状态(Map/IPC 放大 +
        // 热重载错位)。非法 id 回退目录名(pluginId = id,与 listPluginDirs 用目录名一致)。
        if (
          typeof m.id === 'string' &&
          m.id.length > 0 &&
          m.id.length <= PLUGIN_ID_MAX &&
          isSafePluginId(m.id)
        ) {
          pluginId = m.id;
        }
      } catch {
        continue;
      }

      try {
        const mainPath = resolvePluginMainPath(dir, mainName);
        if (!mainPath) continue;
        const fileStat = await fs.stat(mainPath);
        const mtime = fileStat.mtimeMs;
        const prev = mtimes.get(pluginId);
        // race(R67):先记录新 mtime,再 onChange。此前顺序相反,而整段在 try{}catch{continue} 内 —
        // 若 onChange(广播 send)抛错,会被 per-entry catch 吞掉 continue → mtimes.set 不执行 →
        // mtimes 不推进 → 同一变更每个 tick 反复触发/反复失败(广播一直打不出去)。改为变更检测
        // 一旦确认即记录 mtime,通知(onChange)成败不影响 mtime 推进:坏窗口由 onChange 内部
        // per-window try/catch 兜底(R67-A),不再回灌脏状态。
        mtimes.set(pluginId, mtime);
        if (!firstRun && prev !== undefined && prev !== mtime) {
          onChange(pluginId);
        }
      } catch {
        continue;
      }
    }
    firstRun = false;
  };

  // 单飞包装:重入则置 pending,当前扫描结束后串行补跑(不并发)。
  const tick = async (): Promise<void> => {
    if (cancelled) return;
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      do {
        pending = false;
        await runScan();
      } while (pending && !cancelled);
    } finally {
      running = false;
    }
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
