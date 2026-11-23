// 插件目录扫描 + 文件读取(M-Plugin v4.1,主进程端)。
// 纯函数风格,便于单测;真正的 IPC 注册在 plugins.ipc.ts。

import { spawn } from 'node:child_process';
import {
  PERMISSION_RECORD_LIMITS,
  PLUGIN_ID_MAX_LEN,
} from '../../shared/permission-record-limits';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, type Dirent, type Stats } from 'node:fs';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  IpcPathScope,
  IpcPermissionDecision,
  IpcPermissionMutation,
  IpcPermissionRecord,
  IpcPermissionsMap,
  IpcPluginDirListing,
} from '../../shared/plugins-channels';
import { PLUGIN_DIR_NAME_MAX_LEN } from '../../shared/plugins-channels';
import { ERROR_CODES } from '../../shared/error-codes';
import { codedError, errorMessage } from '../../shared/error-message';
import { isValidPluginId } from '../../shared/plugin-id';
import { ownValue } from '../../shared/own-value';
import { isValidGitBranch } from '../../shared/git-branch';
import { createSerialQueue } from '../../shared/run-serial-per-key';
import { isIpcPathScope, isIpcPermissionDecision } from '../../shared/permission-record';
import { killWithGrace } from '../lib/kill-with-grace';
import {
  mergeSpawnEnv,
  resolveSpawnCommand,
  stripInternalSecretEnv,
  withGitHardeningEnv,
} from '../lib/child-spawn-hardening';
import { atomicWriteJson } from '../lib/atomic-write';
import { createByteCappedBuffer } from '../lib/byte-capped-buffer';
import { openForReadNonBlocking, readFileCappedFd } from '../lib/read-fh-capped';
import { isSameOrInsidePath } from '../lib/path-inside';
import { runSerialPerKey } from './serialize-per-key';
import { parseManifest } from '../../shared/plugin-manifest';
import { MAX_PLUGIN_DATA_BYTES } from '../../shared/plugin-data-limits';

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
 * 插件 id 安全性:形态规则见 electron/shared/plugin-id(isValidPluginId,跨进程单一来源)+ 长度上限。
 * 历史:旧正则 `^[a-z0-9._-]+$` 允许纯点段,`id='..'` 会让 `path.join(baseDir, id)` 解析到
 * baseDir 的父目录;overwrite 安装(marketplace「更新」)随即 rename 覆盖父目录 →
 * 路径穿越(审计 P1)。与 fs `renameEntry` 拒 `.`/`..` 同款防御。
 */
export function isSafePluginId(id: string): boolean {
  // 长度上限与读端一致:各持久化读端都丢弃超长 id,写端 / 安装 / 卸载若只查字符集,超长合法字符 id 会
  //「写成功、读回被丢」(且超长 id 拼路径可能 ENAMETOOLONG)。
  return id.length <= PLUGIN_ID_MAX_LEN && isValidPluginId(id);
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

const UUID_LEN = 36;

/** s[from..] 是否恰好是 randomUUID() 的形态:8-4-4-4-12 位小写 hex(字符扫描,不走 RegExp)。 */
function isLowerUuidAt(s: string, from: number): boolean {
  if (s.length - from !== UUID_LEN) return false;
  for (let i = 0; i < UUID_LEN; i += 1) {
    const code = s.charCodeAt(from + i);
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      if (code !== 45) return false;
    } else if (!((code >= 48 && code <= 57) || (code >= 97 && code <= 102))) {
      return false;
    }
  }
  return true;
}

/**
 * 解析 installFromGit 留下的残留目录名,等价于锚定匹配 `^\.(<id>)\.(installing|old)-<uuid>$`:
 * 末尾固定是 randomUUID(36 位),其前紧挨 `.installing-` 或 `.old-`,再往前(去掉开头的 `.`)整段是插件 id。
 * uuid 定长 → 标记位置唯一,id 自身含 `.old-` / `.installing-` 也不会切错。
 *
 * 曾用 `lastIndexOf('.old-')` 且先判 backup:manifest.id = `a.old-z` 的 staging 目录
 * `.a.old-z.installing-<uuid>` 被解析成「插件 a 的备份」,崩溃恢复时 rename 成 plugins/a ——
 * 未装完的另一个插件的代码冒名成 a。先判 installing;id 须是合法插件 id(不合法 → 不认,原样留着)。
 */
function parseInterruptedInstallName(name: string): { kind: 'installing' | 'backup'; id: string } | null {
  if (name.charCodeAt(0) !== 46) return null;
  const uuidAt = name.length - UUID_LEN;
  if (uuidAt < 0 || !isLowerUuidAt(name, uuidAt)) return null;
  for (const [marker, kind] of [
    ['.installing-', 'installing'],
    ['.old-', 'backup'],
  ] as const) {
    const markerAt = uuidAt - marker.length;
    if (markerAt > 1 && name.startsWith(marker, markerAt)) {
      const id = name.slice(1, markerAt);
      return isSafePluginId(id) ? { kind, id } : null;
    }
  }
  return null;
}

/**
 * 启动期恢复被**进程崩溃**中断的插件更新(数据安全,复查 P1)。
 *
 * installFromGit 的 overwrite swap 顺序是 `rename(target→backup)` 再 `rename(staging→target)`;
 * in-process try/catch 只回滚可 catch 的 error,但进程在两次 rename **之间**崩溃会留下:
 * `<id>` 目标缺失 + `.<id>.old-<uuid>` backup(以 `.` 开头,被 listPluginDirs 跳过)→ 插件静默
 * 消失,违反「失败时旧版本原样保留,不会丢插件」的注释契约。
 *
 * 在列举/加载插件前扫一遍 baseDir:
 *   - 孤儿 `.<id>.old-<uuid>` 且 `<id>` 缺失 → rename 回 `<id>`(还原旧版本);
 *   - `<id>` 已存在(更新其实已完成,只是没来得及删 backup)→ 删除残留 backup;
 *   - 残留 `.<id>.installing-<uuid>` staging → 删除。
 * 幂等:无残留时纯 no-op,可安全在每次启动调用。
 */
export async function recoverInterruptedInstalls(baseDir: string): Promise<void> {
  // 边界(E82):有界枚举(缺目录 → [] → 循环 no-op,等价旧版早返)。
  const entries = await readPluginDirEntriesCapped(baseDir);
  for (const name of entries) {
    const residue = parseInterruptedInstallName(name);
    if (residue === null) continue;
    // 残留 staging(cp 完但还没 swap 就崩)→ 清理
    if (residue.kind === 'installing') {
      await rm(path.join(baseDir, name), { recursive: true, force: true }).catch(
        () => {},
      );
      continue;
    }
    const backupPath = path.join(baseDir, name);
    const targetPath = path.join(baseDir, residue.id);
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
  }
}

// 边界(E24,E18 同族):插件目录扫描读 manifest/main 的文件大小上限。畸形/恶意插件包可放
// 超大 manifest/main,应用启动或插件列表刷新时主进程整文件读入并经 IPC 传给 renderer →
// 内存峰值/卡死/崩溃。读前 stat.size,超限跳过(manifest/main 缺失即跳过整插件),
// 不把超大源码跨 IPC 传输。上限远超任何现实插件(bundled main 数 MB 已罕见)。
const MANIFEST_MAX_BYTES = 1024 * 1024; // 1 MiB
const MAIN_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB(bundled 源码)

export async function readFileCapped(
  filePath: string,
  maxBytes: number,
): Promise<string | null> {
  // 边界(E158,E24 同族 TOCTOU 修正):此前先 `fs.stat(path)` 判 size、再 `fs.readFile(path)` 整文件
  // —— 两次独立按路径解析,检查与读取之间文件可被替换(路径指向新 inode)或增长,绕过大小上限。改用
  // 共享 readFileCappedFd(单 fd open→fstat 同 inode→有界读)。本 helper 对任何错误(含缺失/不可读)
  // 与超限都返 null(跳过该文件;缺 manifest/main=跳过整插件)。
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
  return (await readPluginDirentsCapped(baseDir)).map((dirent) => dirent.name);
}

function warnPluginDirTruncated(baseDir: string): void {
  console.warn(`[plugins] 目录条目截断到 ${MAX_PLUGIN_DIR_ENTRIES}(超大/被污染?): ${baseDir}`);
}

/**
 * 同 readPluginDirEntriesCapped,保留 Dirent(watcher 用其类型免去每目录 stat)。
 * 截断时调用 onTruncated(默认告警;watcher 每轮轮询,自行去重告警)。
 */
async function readPluginDirentsCapped(
  baseDir: string,
  onTruncated: (baseDir: string) => void = warnPluginDirTruncated,
): Promise<import('node:fs').Dirent[]> {
  let dir: import('node:fs').Dir;
  try {
    dir = await fs.opendir(baseDir);
  } catch {
    return []; // baseDir 不存在/不可读 = 无插件
  }
  const dirents = new Array<import('node:fs').Dirent>(MAX_PLUGIN_DIR_ENTRIES);
  let nameCount = 0;
  try {
    for await (const dirent of dir) {
      dirents[nameCount] = dirent;
      nameCount += 1;
      if (nameCount >= MAX_PLUGIN_DIR_ENTRIES) {
        onTruncated(baseDir);
        break; // for-await break 自动 close dir
      }
    }
  } catch {
    // 迭代中途错误 → 返回已收集(best-effort)
  }
  dirents.length = nameCount;
  return dirents;
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

/**
 * 扫描 baseDir/<id>/manifest.json 模式;返回所有合法目录的 manifestText(不含 main 源码)。
 * main 入口(默认 main.js 或 manifest.main 指向)只判定可用(open + fstat:是普通文件且 ≤8MiB,不读全文),
 * 源码在激活时经 readPluginMainByDir 按目录名拉取 —— perf:此前为所有候选(含未启用)读完整 main 并经
 * IPC 传给每个窗口,而 PluginManager 只对 enabled 插件使用。插件目录里的 styles.css 不读取:renderer
 * 从未注入过它(样式由插件在 onload 里自行处理)。
 *
 * 子目录读 fail / 缺 manifest / 缺 main 都跳过该目录(不抛),由 renderer 端
 * PluginManager 决定是否报告。
 */
export async function listPluginDirs(baseDir: string): Promise<IpcPluginDirListing[]> {
  // 边界(E82):有界枚举(缺目录 → [] → 返回空列表,等价旧版)。
  const entries = await readPluginDirEntriesCapped(baseDir);
  // perf:per-dir 读取(stat + manifest + main 可用性)有界并发(PLUGIN_DIR_IO_CONCURRENCY),
  // 结果按 entries 原顺序收集(激活顺序契约不变)。
  const results = await mapInOrderBounded(entries, (name) => readOnePluginDirMeta(baseDir, name));

  const out = new Array<IpcPluginDirListing>(results.length);
  let outCount = 0;
  for (const r of results) {
    if (r === null) continue;
    out[outCount] = r;
    outCount += 1;
  }
  out.length = outCount;
  return out;
}

/** 插件目录 I/O 的并发上限(列举 / watcher 轮询共用)。 */
const PLUGIN_DIR_IO_CONCURRENCY = 8;

/**
 * 以最多 PLUGIN_DIR_IO_CONCURRENCY 个并发对 items 运行 fn,结果按输入顺序对位。
 * fn 自行吞掉可预期错误(返回 null 等);意外抛错与旧串行循环一样让整体 reject。
 */
async function mapInOrderBounded<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i]!);
    }
  };
  const workerCount = Math.min(PLUGIN_DIR_IO_CONCURRENCY, items.length);
  const workers = new Array<Promise<void>>(workerCount);
  for (let i = 0; i < workerCount; i += 1) workers[i] = worker();
  await Promise.all(workers);
  return results;
}

/** 读单个插件目录的 manifest 文本(过滤 . / _ 前缀与非目录;缺失 / 超限 → null)。 */
async function readPluginManifestText(
  baseDir: string,
  name: string,
): Promise<{ dir: string; manifestText: string } | null> {
  if (name.startsWith('.') || name.startsWith('_')) return null;
  const dir = path.join(baseDir, name);
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.stat(dir);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;
  const manifestPath = path.join(dir, 'manifest.json');
  if (!(await staysInsidePluginDir(dir, manifestPath))) return null;
  // 边界(E24):manifest 超 1MiB(或缺失/不可读)→ 跳过整插件,不整文件读入 + IPC 传输。
  const manifestText = await readFileCapped(manifestPath, MANIFEST_MAX_BYTES);
  if (manifestText === null) return null;
  return { dir, manifestText };
}

/**
 * 安全:filePath(插件目录下的 manifest / main)的真实路径是否仍在插件目录的真实路径内。
 * 插件目录内容来自插件仓库,旧版本安装的目录可能带符号链接(`main.js -> ~/.ssh/id_rsa`、`dist -> /`):
 * 宿主读它等于替插件读目录外文件。按 realpath 判包含而非禁链接:插件目录本身是链接(本地开发)、
 * 目录内互指的链接照旧可用。缺失 / 不可解析 → false。
 */
async function staysInsidePluginDir(dir: string, filePath: string): Promise<boolean> {
  try {
    const [realDir, realFile] = await Promise.all([fs.realpath(dir), fs.realpath(filePath)]);
    return isSameOrInsidePath(realDir, realFile);
  } catch {
    return false;
  }
}

/** 按 manifest.main(解析失败 → 默认 main.js)读 main 文本;越界 / 缺失 / 超限 → null。 */
async function readPluginMainText(dir: string, manifestText: string): Promise<string | null> {
  // 解析 manifest.main(若失败用默认 main.js,M20:共用 getPluginMainName)
  let mainName = 'main.js';
  try {
    mainName = getPluginMainName(JSON.parse(manifestText));
  } catch {
    // manifest 解析失败由 renderer 端 parseManifest 报错,我们继续给 mainText 尝试默认
  }
  const mainPath = resolvePluginMainPath(dir, mainName);
  if (!mainPath || !(await staysInsidePluginDir(dir, mainPath))) return null;
  // 边界(E24):main 超 8MiB(或缺失/不可读)→ 跳过整个 plugin。
  return readFileCapped(mainPath, MAIN_MAX_BYTES);
}

/**
 * main 入口是否可用:与 readPluginMainText 同口径(同一 main 解析、越界 → 不可用、普通文件且 ≤ MAIN_MAX_BYTES、
 * 可打开),但只 open + fstat,不读全文。
 */
async function isPluginMainAvailable(dir: string, manifestText: string): Promise<boolean> {
  let mainName = 'main.js';
  try {
    mainName = getPluginMainName(JSON.parse(manifestText));
  } catch {
    // 同 readPluginMainText:manifest 解析失败按默认 main.js
  }
  const mainPath = resolvePluginMainPath(dir, mainName);
  if (!mainPath || !(await staysInsidePluginDir(dir, mainPath))) return false;
  let fh: import('node:fs/promises').FileHandle;
  try {
    // O_NONBLOCK:main 若是 FIFO(或指向 FIFO 的链接),阻塞 open 会永久占住 libuv 线程池线程。
    fh = await openForReadNonBlocking(mainPath);
  } catch {
    return false;
  }
  try {
    const st = await fh.stat();
    if (st.size > MAIN_MAX_BYTES) {
      console.warn(`[plugins] 跳过超大文件(> ${MAIN_MAX_BYTES}): ${mainPath}`);
      return false;
    }
    return st.isFile();
  } catch {
    return false;
  } finally {
    await fh.close().catch(() => {});
  }
}

/** manifest 版本令牌:manifestText 的 sha256(小写 hex)。列举项携带,激活读 main 时校验 manifest 未变。 */
export function pluginManifestHash(manifestText: string): string {
  return createHash('sha256').update(manifestText).digest('hex');
}

async function readOnePluginDirMeta(
  baseDir: string,
  name: string,
): Promise<IpcPluginDirListing | null> {
  const m = await readPluginManifestText(baseDir, name);
  if (m === null) return null;
  if (!(await isPluginMainAvailable(m.dir, m.manifestText))) return null;
  return { id: name, manifestText: m.manifestText, manifestHash: pluginManifestHash(m.manifestText) };
}

/**
 * 激活时按**目录名**读该插件 main 源码(列举结果的 id 即目录名)。按目录而非 manifest.id:重复 id 的
 * 目录选择已在 renderer 完成,这里不再选一次,避免与列举口径漂移。目录名必须是 baseDir 下的单级名
 *(无分隔符 / NUL、非 . / ..,且与列举同样排除 . / _ 前缀),否则 → null;目录 / manifest / main 不可用 → null。
 *
 * 快照一致性(P1):renderer 按列举时的 manifest(id / 权限 / 入口)激活,列举与激活之间插件可能被更新。
 * manifestHash 为列举项的令牌;读 main 前、后各复核当前 manifest 与令牌一致,不一致 → 抛
 * PLUGIN_MANIFEST_CHANGED(该插件激活失败;watcher 随后检测到 manifest 变化广播热重载)。
 */
export async function readPluginMainByDir(
  baseDir: string,
  name: string,
  manifestHash: string,
): Promise<string | null> {
  if (
    name.length === 0 ||
    name.length > PLUGIN_DIR_NAME_MAX_LEN ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    path.basename(name) !== name
  ) {
    return null;
  }
  const m = await readPluginManifestText(baseDir, name);
  if (m === null) return null;
  assertManifestUnchanged(m.manifestText, manifestHash, name);
  const mainText = await readPluginMainText(m.dir, m.manifestText);
  if (mainText === null) return null;
  // 读 main 期间 manifest 可能被替换(原子更新整目录):复核,确保返回的 main 与令牌对应的 manifest 同期。
  const after = await readPluginManifestText(baseDir, name);
  if (after === null) return null;
  assertManifestUnchanged(after.manifestText, manifestHash, name);
  return mainText;
}

function assertManifestUnchanged(manifestText: string, manifestHash: string, name: string): void {
  if (pluginManifestHash(manifestText) !== manifestHash) {
    throw codedError(
      ERROR_CODES.PLUGIN_MANIFEST_CHANGED,
      `插件 manifest 在列举后已变更,拒绝激活: ${name}`,
    );
  }
}

const ENABLED_FILE = '_enabled.json';
// 边界(E85,E74 字段上限族 / 数据完整性):_enabled.json 读盘此前只校验 array-of-string,不校验
// id 格式/长度/数量。手工/旧版本残留的 1MiB JSON(E68 文件大小已封顶,但内可塞数十万短串或非法/
// 超长 id)能通过 array-of-string 校验 → readEnabledIds → new Set → PluginManager.init 放大 CPU/内存,
// 且 setEnabledId 的 RMW 把这些非法/超量 id 原样写回,绕过写 IPC schema 上限。读盘按写端同一契约
// canonicalize:仅保留 isSafePluginId(含长度上限 PLUGIN_ID_MAX_LEN)的 id、去重、数量≤MAX_ENABLED_IDS。
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
        if (!isSafePluginId(x)) continue;
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
// 数据安全(复查 P1):此前 RMW 在 renderer 的 PluginManager 内做,串行锁是
// per-PluginManager 实例;每个窗口各有自己的 PluginManager(main-app.ts),两个窗口
// 同时 enable/disable 不同插件时各读旧集合、整表写回,后写者覆盖先写者 → 某插件启用
// 状态重启后丢失(跨窗口 lost update)。把 RMW 收口到 main 端单条 Promise 链(镜像
// permissionsWriteQueue / pathScopesWriteQueue),renderer 改传 delta(id, enabled)。
const enabledWriteQueue = createSerialQueue();

/**
 * 启用/禁用单个插件 id(主进程全局串行 delta 写)。
 * enabled=true → 加入集合;false → 移除。读改写在同一链内原子完成,跨窗口无 lost update。
 */
export function setEnabledId(
  baseDir: string,
  id: string,
  enabled: boolean,
): Promise<void> {
  return enabledWriteQueue.run(async () => {
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
}

// ── v4.2 权限决策持久化 ─────────────────────────────────

const PERMISSIONS_FILE = '_permissions.json';
// 边界(E87,E85/E86 数据完整性族 / E5 时间戳):_permissions.json 读盘按写端 + 业务枚举 canonicalize。
// permission 必须是 PERMISSION_KEYS 成员(否则 PERM_LABEL_KEYS[perm]=undefined 渲染崩),decidedAt 必须
// finite(1e400 经 JSON.parse=Infinity 但 typeof 仍 number,同 E5)。每插件 decisions 数 + plugin key 数
// 封顶(decisions 对齐 IPC 写端 DECISIONS_MAX,防 RMW 写回绕过写端上限)。
const MAX_DECISIONS_PER_PLUGIN = PERMISSION_RECORD_LIMITS.DECISIONS_PER_PLUGIN_MAX; // 对齐 plugins.ipc DECISIONS_MAX
const MAX_PERMISSION_PLUGIN_KEYS = PERMISSION_RECORD_LIMITS.PLUGIN_KEYS_MAX;

// 单条 decision / scope 的形态判定取 shared 单一来源(与 renderer 读端、IPC schema 同一规则)。
const isDecision = isIpcPermissionDecision;

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
  return collectMappedValidCapped(arr, isValid, (x) => x, max);
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
  a: readonly IpcPermissionDecision[],
  b: readonly IpcPermissionDecision[],
): boolean {
  if (a.length !== b.length) return false;
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

export async function readPermissions(
  baseDir: string,
): Promise<IpcPermissionsMap> {
  const file = path.join(baseDir, PERMISSIONS_FILE);
  // 数据安全:区分「缺文件」与「损坏/IO 错误」(与 readAllPathScopes #12 同型)。只有
  // ENOENT 是首次启动 → {}。EACCES/EIO 等读错误是「当前态未知」,不能当空表 —— 否则
  // 写入方基于 {} 做整表 RMW,抹掉其它 plugin 已落盘的授权决策。抛出 →
  // mutatePluginPermissions / uninstall 在删/写前中止,renderer 经 safeHandle 降级。
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
      if (!isSafePluginId(pid)) continue;
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
  // 数据安全(复查 P1):裸 writeFile('w') 先截断再写,ENOSPC/进程被杀/写中断会把
  // 整张授权表留成空/半截 JSON → 重启 readPermissions 按既有契约把损坏 JSON 降级为 {},
  // 所有 plugin 授权决策丢失。改 temp+fsync+rename 原子写:rename 前原文件始终完好,
  // 写失败也不动原文件(与 writeEnabledIds / writePluginPathScopes 同族修复)。
  await atomicWriteJson(file, data);
}

// 同文件 read-modify-write 串行化,防多窗口/并发授权互相覆盖(镜像
// pathScopesWriteQueue / installLocks 思路)。
const permissionsWriteQueue = createSerialQueue();

/**
 * 删除某 plugin 在 `_permissions.json` 里的条目(卸载用,避免重装继承旧授权)。与 mutatePluginPermissions 走同一条
 * 串行链做 read-modify-write:只动该 id,保留其它 id 已落盘内容;条目不存在 → 不触盘。非法 id 忽略。
 */
export function removePluginPermissions(baseDir: string, id: string): Promise<void> {
  return permissionsWriteQueue.run(async () => {
    if (!isSafePluginId(id)) return;
    const all = { ...(await readPermissions(baseDir)) };
    if (!Object.hasOwn(all, id)) return;
    delete all[id];
    await writePermissions(baseDir, all);
  });
}

/**
 * 终审 P1:按**权限项**增量变更单个 plugin 的授权记录。此前 renderer 基于本窗口缓存算出整条记录发来覆盖写,
 * 别的窗口已撤销的权限会被陈旧窗口的下一次保存写回。改为在同一串行写链内读当前落盘记录、只替换/清除
 * mutation 涉及的项,其它决策与 pathScopes 原样保留。返回合并后的记录(条目被删 → null),供 renderer 作缓存。
 *
 * 终审 P1(卸载后仍可授权):插件目录不存在(已卸载 / 未安装)→ 抛 NOT_INSTALLED、不写盘。否则别的窗口在
 * 卸载后点了旧授权弹窗的「授权」会把授权写回,同 id 重装继承。整段纳入同 id mutation 锁(与 uninstallPlugin
 * 互斥):卸载在「清 _permissions → 删目录」之间时,本写入要么在卸载前完成(随后被清),要么等卸载完成后被拒。
 */
export function mutatePluginPermissions(
  baseDir: string,
  id: string,
  mutation: IpcPermissionMutation,
): Promise<IpcPermissionRecord | null> {
  if (!isSafePluginId(id)) return Promise.resolve(null);
  return withInstalledPluginLock(baseDir, id, () =>
    permissionsWriteQueue.run(() => mutatePluginPermissionsQueued(baseDir, id, mutation)),
  );
}

async function mutatePluginPermissionsQueued(
  baseDir: string,
  id: string,
  mutation: IpcPermissionMutation,
): Promise<IpcPermissionRecord | null> {
  const all = { ...(await readPermissions(baseDir)) };
  // 只认自有属性:插件 id `constructor` 合法,普通对象上 all['constructor'] 会命中 Object 构造函数。
  const existing = ownValue(all, id);
  const decisions: readonly IpcPermissionDecision[] =
    existing === undefined
      ? []
      : Array.isArray(existing)
        ? existing
        : (existing as { decisions: readonly IpcPermissionDecision[] }).decisions;
  const scopes =
    existing === undefined || Array.isArray(existing)
      ? undefined
      : (existing as { pathScopes?: readonly IpcPathScope[] }).pathScopes;

  let next: IpcPermissionDecision[];
  if (mutation.kind === 'set') {
    const replaced = new Set<string>(mutation.perms);
    const decidedAt = Date.now();
    next = decisions.filter((d) => !replaced.has(d.permission));
    for (const permission of replaced) {
      next.push({ permission, granted: mutation.granted, decidedAt });
    }
    // 与写端同一上限(超出的旧项丢弃,保证读回一致)。
    if (next.length > MAX_DECISIONS_PER_PLUGIN) next = next.slice(-MAX_DECISIONS_PER_PLUGIN);
  } else {
    next = decisions.filter((d) => d.granted);
  }

  if (next.length === 0 && (scopes === undefined || scopes.length === 0)) {
    if (existing === undefined) return null; // 无变化,不为删空条目而触盘
    delete all[id];
    await writePermissions(baseDir, all);
    return null;
  }
  const record: IpcPermissionRecord =
    scopes === undefined ? next : { decisions: next, pathScopes: scopes };
  // scopes 取自 existing,不会变;只有决策变了、或旧记录是不带 pathScopes 的对象形态(归一成数组)才写。
  const unchanged =
    existing !== undefined &&
    (Array.isArray(existing) || scopes !== undefined) &&
    permissionDecisionsEqual(decisions, next);
  if (!unchanged) {
    all[id] = record;
    await writePermissions(baseDir, all);
  }
  return record;
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
const MAX_PERSISTED_SCOPES_PER_PLUGIN = PERMISSION_RECORD_LIMITS.PATH_SCOPES_PER_PLUGIN_MAX; // 对齐 PathScopeRegistry MAX_SCOPES_PER_PLUGIN(E81)
const MAX_PERSISTED_PLUGIN_KEYS = 4096; // 持久化表的 plugin key 数上限

/**
 * scopes 文件 JSON 解析失败(已存 .corrupt 快照)。与 IO 错误区分:损坏文件的读端恒降级 [],
 * 不会被同 id 重装继承,卸载清理遇到它可放行;IO 错误(EACCES/EMFILE 等)可能是暂时的,
 * 之后读回旧 scope → 卸载必须中止。
 */
class PathScopesCorruptError extends Error {}

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
    await fs.writeFile(`${file}.corrupt`, text, { flag: 'wx', mode: 0o600 }).catch(() => {});
    throw new PathScopesCorruptError(`path-scopes file corrupt: ${file}`);
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
    if (!isSafePluginId(pid)) continue;
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
    return ownValue(all, id) ?? [];
  } catch {
    // 损坏/IO 错误 → 本次冷启动不水合该 scope(插件会重新请求授权),fail-safe 降级。
    return [];
  }
}

// 同文件 read-modify-write 串行化,防并发 grant 互相覆盖(镜像 installLocks 思路)。
const pathScopesWriteQueue = createSerialQueue();

/**
 * 持久化单个 plugin 的全部已授 path scope(覆盖式)。空数组 → 删除该 id 条目。
 * 非法 id 直接忽略(防注入畸形 key)。写入串行化避免并发 grant 互踩。
 */
export function writePluginPathScopes(
  baseDir: string,
  id: string,
  scopes: readonly IpcPathScope[],
): Promise<void> {
  return pathScopesWriteQueue.run(async () => {
    if (!isSafePluginId(id)) return;
    const all = await readAllPathScopes(baseDir);
    // 边界(E249,E247 兄弟入口):service 层写端按 MAX_PERSISTED_SCOPES_PER_PLUGIN 有界收集,与
    // readAllPathScopes 同步。此前裸 .filter().map() 无数量上限 —— exported service 入口可被进程内/未来
    // 调用绕过 IPC schema(PATHSCOPES_MAX=256),写超量 scope 落盘成功但 readAllPathScopes 只读回前 256 →
    // 写成功重启读回丢数据 + 全量物化卡顿。collectValidCapped 凑满 MAX 即停(E247)。
    const normalized = collectMappedValidCapped(
      scopes,
      isIpcPathScope,
      (s) => ({ path: s.path, mode: s.mode }),
      MAX_PERSISTED_SCOPES_PER_PLUGIN,
    );
    if (normalized.length === 0) {
      if (!Object.hasOwn(all, id)) return; // 无变化,不为删除空条目而触盘
      delete all[id];
    } else {
      if (pathScopesEqual(ownValue(all, id), normalized)) return;
      all[id] = normalized;
    }
    await fs.mkdir(baseDir, { recursive: true });
    const file = path.join(baseDir, PATH_SCOPES_FILE);
    // 数据安全:同 writePermissions —— 裸 writeFile 截断窗口会留半截 JSON,
    // readAllPathScopes 损坏即抛 → 水合降级 [],已授 path scope 丢失。原子写。
    await atomicWriteJson(file, all);
  });
}

// ── v4.5 git URL 安装 ──────────────────────────────────

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
    throw codedError(ERROR_CODES.INVALID_ID, `非法 plugin id: ${id}`);
  }
  // race(R107):卸载全段(access → 元数据清理 → rm)纳入同 id 主进程 mutation 锁,与 installFromGit
  // 的 swap(access → rename 就位)互斥串行。否则跨窗口「卸载 vs 安装/更新同 id」交错:卸载的
  // rm(targetDir) 可能删掉刚 rename 就位的新版本,或清掉新安装应保留的元数据 → 安装成功却插件消失/
  // 状态不一致。id 校验廉价、无副作用,放锁外。
  return withInstalledPluginLock(baseDir, id, async () => {
    const targetDir = path.join(baseDir, id);
    // 数据安全(P1):先清「会抛的」持久化元数据,**再**删目录(fail-fast)。旧顺序
    // 先删目录后清元数据,若清理抛错(如 writePluginPathScopes 在 scopes 文件损坏时抛 —— 见
    // #12)会留下「目录已删但卸载 reject」的半提交:PluginManager.uninstall 不 entries.delete,
    // 重试又因目录缺失走 NOT_INSTALLED → 卡死不可重试。改为元数据清理在前,任一失败在删目录
    // 前抛出 → 卸载可整体重试(清理幂等),不留半提交。

    // 清 _enabled.json 中的 id(防止 reload 复活已删插件)。数据安全(P1):必须走
    // setEnabledId 的全局串行链 —— 此前手写 readEnabledIds→filter→writeEnabledIds 绕过
    // enabledWriteQueue,与跨窗口 enable/disable 并发时用旧快照整表写回 → 丢别窗口刚启用
    // 的插件,或被并发 enable 写回旧 id(重装继承已启用)。delta 写在链内 RMW、仍在删目录前。
    await setEnabledId(baseDir, id, false);

    // 清 _permissions.json 中的 id(避免重装继承旧授权)。数据安全:与上方 enabled 同理必须走
    // removePluginPermissions 的全局串行链(链内 RMW 删除该 id 条目,不存在则不触盘)——
    // 此前手写 readPermissions→delete→writePermissions 整表写绕过 permissionsWriteQueue,与跨窗口
    // 并发 grant/deny 交错时用旧快照写回 → 抹掉别的插件刚落盘的授权(enabled 修了、这里漏了)。
    await removePluginPermissions(baseDir, id);

    // 清 _plugin-path-scopes.json 中的 id(避免重装继承旧 path scope,与上方对称)。
    // 仅「文件已损坏」放行:损坏文件本就不会被同 id 重装继承(readPluginPathScopes 损坏降级 []),
    // 避免一个损坏文件永久卡住所有卸载(.corrupt 快照已由 readAllPathScopes 留存)。其余失败
    //(原子写 ENOSPC、读盘 IO 错误)fail-closed:旧 scope 仍在盘上,若照删目录,同 id 重装会水合
    // 旧 scope → covers() 静默授权、不弹窗 → 新代码继承旧目录读写授权。故删目录前中止,可整体重试。
    try {
      await writePluginPathScopes(baseDir, id, []);
    } catch (err) {
      if (!(err instanceof PathScopesCorruptError)) {
        throw codedError(
          ERROR_CODES.PATH_SCOPE_CLEANUP_FAILED,
          `path scope 授权清理失败,未卸载: ${id}: ${errorMessage(err)}`,
        );
      }
      console.warn(`[uninstall] path-scope cleanup skipped (corrupt scopes file): ${id}`, err);
    }

    // 元数据已清,最后删目录。失败 → RM_FAILED,可整体重试(上面清理幂等)。
    try {
      await rm(targetDir, { recursive: true, force: true });
    } catch (err) {
      throw codedError(ERROR_CODES.RM_FAILED, `删除失败: ${errorMessage(err)}`);
    }
  });
}

/**
 * 授权弹窗「授权」后的 path scope 持久化入口(plugin-fs persistScopes 走这里,不直接 writePluginPathScopes)。
 *
 * 安全(卸载交错):uninstallPlugin 先清 _plugin-path-scopes.json 再 rm 目录,卸载返回后才撤内存 token。
 * 间隙里另一窗口挂着的授权弹窗被点「授权」→ token 仍 active → 直接写盘会把 scope 写回,同 id 重装从磁盘
 * 水合继承旧授权。与 mutatePluginPermissions 同法:纳入同 id mutation 锁(与卸载互斥),锁内确认插件目录仍在:
 * 要么在卸载前写入(随后被卸载清掉),要么等卸载完成后因目录缺失被拒(NOT_INSTALLED,调用方 best-effort 吞掉)。
 * 授权弹窗只针对已安装插件,目录缺失即拒不影响正常授权。
 */
export function persistPluginPathScopesIfInstalled(
  baseDir: string,
  id: string,
  scopes: readonly IpcPathScope[],
): Promise<void> {
  if (!isSafePluginId(id)) return Promise.resolve();
  return withInstalledPluginLock(baseDir, id, () => writePluginPathScopes(baseDir, id, scopes));
}

/**
 * 在同 id mutation 锁内(与安装 / 更新 / 卸载互斥)确认插件目录仍在,再执行 fn;目录缺失 → NOT_INSTALLED,fn 不执行。
 * 给「只应作用于已安装插件」的迟到写入用(path scope 持久化、plugin-data 的 saveData):要么落在卸载之前
 * (随后被卸载清掉),要么等卸载完成后因目录缺失被拒 —— 不会在卸载 rm 之后把东西写回去。调用方须先校验 id 形态。
 */
export function withInstalledPluginLock<T>(baseDir: string, id: string, fn: () => Promise<T>): Promise<T> {
  return withPluginMutationLock(id, async () => {
    try {
      await fs.access(path.join(baseDir, id));
    } catch {
      throw codedError(ERROR_CODES.NOT_INSTALLED, `插件未安装: ${id}`);
    }
    return fn();
  });
}

/** 插件数据文件名(plugin-data-store.service 写在安装目录里)。 */
const PLUGIN_DATA_FILE = 'data.json';

/**
 * dir 是否是 plugin-data 留下的残留目录:没有 manifest.json,且里面只有 data.json 及其附属文件(`.lock` 锁目录、
 * `.corrupt` 快照、原子写的 `.data.json.*.tmp`)。旧版本里卸载后迟到的 saveData 会 `mkdir -p` 把目录建回来,
 * 留下这种目录:不被列出(UI 无卸载入口),却让同 id 安装永远 EEXIST。安装时在锁内识别并清掉(自愈)。
 * 判定从严:含任何其它条目(用户手放的文件等)或无法确认 → false,照旧按「已存在」处理,不删。
 */
async function isPluginDataResidueDir(dir: string): Promise<boolean> {
  try {
    if (!(await fs.lstat(dir)).isDirectory()) return false;
    const names = await fs.readdir(dir);
    return names.every((name) => name.startsWith('data.json') || name.startsWith('.data.json.'));
  } catch {
    return false;
  }
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
// 安全:插件仓库 clone 的体积 / 文件数上限。此前只有 60s 超时:恶意仓库放高压缩比巨型 blob,60s 内即可写满磁盘
//(超时后才 kill 并删临时目录)。clone 期间每 PLUGIN_CLONE_POLL_MS 有界统计临时目录(含 .git)的逻辑字节数与
// 条目数,任一超限即终止 git、等其退出后删临时目录,报 PLUGIN_REPO_TOO_LARGE;clone 在两次轮询之间完成的,
// 检出后再复查一次。上限远超现实插件仓库(浅克隆,插件 bundle 通常 < 10MiB / 数百文件)。
export const PLUGIN_CLONE_MAX_BYTES = 200 * 1024 * 1024;
export const PLUGIN_CLONE_MAX_ENTRIES = 20_000;
const PLUGIN_CLONE_POLL_MS = 500;
// 边界(E62,E1/E61 累积缓冲族):runGit 的 git 子进程 stderr 此前 `stderr += String(d)` 无限累积,
// 失败时整段拼进 Error message。恶意/异常远端或协议错误可产生超大 stderr → main 内存膨胀 + 巨大
// 错误串传到 renderer/UI。stderr 累积上限 64KB(保留前 64KB,git 的 fatal 行通常在前部),超限停止
// 追加并标记截断;**不 kill 子进程**——git clone 进度本就走 stderr,大仓库进度可合法 >64KB,kill
// 会误伤合法克隆;只 bound 内存。失败 message 只带截断摘要 + 标记。
const MAX_GIT_STDERR_BYTES = 64 * 1024;
// 安全:用户全局 ~/.gitconfig 常有 `git lfs install` 写入的 filter.lfs.*(GIT_CONFIG_NOSYSTEM 不屏蔽全局)。
// 被攻破的插件仓库放 `.lfsconfig`(lfs.url=内网 / 127.0.0.1 地址)+ LFS 指针文件,clone 检出时 git-lfs 即向
// 任意地址发请求(GIT_ALLOW_PROTOCOL 管不到 git-lfs 自身 HTTP),且发生在用户启用 / 授权插件之前。
// 命令行作用域置空 lfs 驱动(空命令 = 不运行该过滤器)并取消 required,再加 GIT_LFS_SKIP_SMUDGE=1 兜底。
// 代价:依赖 Git LFS 的插件仓库检出得到的是指针文件 —— 插件 bundle 依赖 LFS 视为不支持。
const PLUGIN_CLONE_GIT_CONFIG: readonly (readonly [string, string])[] = [
  ['filter.lfs.process', ''],
  ['filter.lfs.smudge', ''],
  ['filter.lfs.required', 'false'],
];

export interface InstallFromGitOptions {
  /** true:原子覆盖已装版本(更新)。 */
  readonly overwrite?: boolean;
  /**
   * clone 指定分支(marketplace entry.branch)。版本检查读的是该分支的 manifest,clone 须同源,
   * 否则装到默认分支代码(可能降级)却报成功。缺省 = 远端默认分支(行为不变)。
   */
  readonly branch?: string;
  /**
   * 期望的 manifest.id(marketplace entry.id)。不一致 → PLUGIN_ID_MISMATCH 不落地:防 index 条目
   * 指向另一身份的仓库(装成别的 id / 覆盖别的插件 / 更新检查错配)。校验放 main 侧防 renderer 绕过。
   */
  readonly expectedId?: string;
}

/**
 * 从 git URL clone 到临时目录,验 manifest.json,把整个目录复制到
 * baseDir/<manifest.id>/。已存在 → 抛 EEXIST 让调用方提示用户。
 */
export async function installFromGit(
  gitUrl: string,
  baseDir: string,
  opts: InstallFromGitOptions = {},
): Promise<InstallFromGitResult> {
  if (!startsWithHttpsScheme(gitUrl)) {
    throw codedError(ERROR_CODES.BAD_URL, `不支持的 git URL: ${gitUrl}`);
  }
  // branch 进 git argv:形态校验(拒前导 '-' 选项注入 / 空白 / 点段),并用 `--branch=<b>` 单参数
  // 形式,值不会被解析成独立选项。
  if (opts.branch !== undefined && !isValidGitBranch(opts.branch)) {
    throw codedError(ERROR_CODES.BAD_INPUT, `非法 branch: ${opts.branch.slice(0, 256)}`);
  }
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'lm-plugin-install-'));
  try {
    const cloneDir = path.join(tmpRoot, 'clone');
    const cloneArgs = ['clone', '--depth', '1'];
    if (opts.branch !== undefined) cloneArgs.push(`--branch=${opts.branch}`);
    cloneArgs.push(gitUrl, cloneDir);
    await runGit(cloneArgs, cloneDir);
    // clone 在两次轮询之间就完成时,轮询没机会看到最终体积:检出后复查。
    if (await cloneTreeExceedsLimits(cloneDir)) throw cloneTooLargeError();

    // 安全:克隆树里不允许任何符号链接,且在读 manifest 之前检查(manifest.json 本身也可以是链接)。
    await assertNoSymlinksInClone(cloneDir);

    // 边界(E27,E24 兄弟):安装路径读 clone 的 manifest.json 也走 readFileCapped(同
    // MANIFEST_MAX_BYTES),与 listPluginDirs 启动扫描一致。clone 来自外部 git 仓库,manifest
    // 内容不可控;裸 fs.readFile 整块读入超大 manifest → 内存峰值。超限/缺失/不可读 → 返 null →
    // 抛 BAD_MANIFEST,在任何 cp/rename 复制替换插件目录之前 fail-fast 中止。
    const text = await readFileCapped(
      path.join(cloneDir, 'manifest.json'),
      MANIFEST_MAX_BYTES,
    );
    if (text === null) {
      throw codedError(ERROR_CODES.BAD_MANIFEST, 'clone 目录缺 manifest.json、不可读或超过大小上限');
    }
    // 边界(E100):安装路径复用 parseManifest(ManifestSchema)—— 与启动扫描 listPluginDirs/
    // parseManifest 同契约(字段长度/semver/permissions 枚举数量/main 长度全校验)。此前仅检查
    // id/name/version 是 string + id 安全,远程仓库可装 version 非 semver、name 近 1MiB、permissions
    // 畸形的插件:安装 UI 显示成功,但下次扫描 parseManifest 按 schema 拒载 / 超长字段带进 marketplace/
    // 插件列表放大 →「安装成功但重启刷新不可用」。失败统一 BAD_MANIFEST。
    const result = parseManifest(text);
    if (!result.ok) {
      throw codedError(ERROR_CODES.BAD_MANIFEST, `manifest 校验失败: ${result.message}`);
    }
    const manifest = result.data;
    // 边界:id 拼进安装路径(install→rename 覆盖父目录是穿越向量,与 uninstall 对称),此处显式叠加
    // isSafePluginId(形态规则见 electron/shared/plugin-id + 长度上限),不依赖 manifest schema 的校验。
    if (!isSafePluginId(manifest.id)) {
      throw codedError(ERROR_CODES.BAD_MANIFEST, 'manifest id 含非法字符或路径穿越');
    }
    if (opts.expectedId !== undefined && manifest.id !== opts.expectedId) {
      throw codedError(
        ERROR_CODES.PLUGIN_ID_MISMATCH,
        `manifest id ${manifest.id} 与期望 ${opts.expectedId} 不一致`,
      );
    }

    const mainName = getPluginMainName(manifest); // M20:共用 getPluginMainName
    const mainPath = resolvePluginMainPath(cloneDir, mainName);
    if (!mainPath) {
      throw codedError(ERROR_CODES.BAD_MAIN, `main 入口非法: ${mainName}`);
    }
    // 须是普通文件:fs.access 对目录也成功 → 报安装成功,但下次扫描读 main 失败静默跳过。
    let mainIsFile = false;
    try {
      mainIsFile = (await fs.stat(mainPath)).isFile();
    } catch {
      /* 不存在/不可读 → 下方 BAD_MAIN */
    }
    if (!mainIsFile) {
      throw codedError(ERROR_CODES.BAD_MAIN, `main 入口不存在或不是文件: ${mainName}`);
    }

    // 验证已通过 → 收窄成 string 常量,带进下面的闭包。
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
        // 数据安全(复查 P1,「只认 ENOENT」族):仅 ENOENT 是「确实不存在」。
        // EACCES/EIO/ELOOP = 目标状态未知 —— 不能当不存在,否则:overwrite:false 的已存在守卫
        // 被绕过;或 overwrite 时 targetExists=false → backup=null → rename(staging,target)
        // 直接覆盖一个可达的已安装目录/链接(无备份、不可回滚)= 丢已装插件。非 ENOENT 在
        // cp/rename 前 fail-closed 抛出中止。
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        /* ENOENT = not exists, OK */
      }
      // 自愈:只剩 plugin-data 残留的目录(见 isPluginDataResidueDir)不算已安装 —— 清掉后按全新安装继续
      //(残留的 data.json 是卸载之后才写进来的,不继承)。在锁内判定 + 删除,与 saveData / 卸载互斥。
      if (targetExists && (await isPluginDataResidueDir(targetDir))) {
        await rm(targetDir, { recursive: true, force: true });
        targetExists = false;
      }
      if (targetExists && opts.overwrite !== true) {
        throw codedError(ERROR_CODES.EEXIST, `插件 ${pluginId} 已安装,卸载后再装`);
      }

      const suffix = randomUUID();
      const staging = path.join(baseDir, `.${pluginId}.installing-${suffix}`);
      const backup = targetExists
        ? path.join(baseDir, `.${pluginId}.old-${suffix}`)
        : null;

      try {
        // 性能:clone 与 staging 同卷时直接 rename 整树(O(1));fs.cp 是逐文件串行复制(实测 3000 文件
        // ~850ms,且全程持有该 id 的 mutation 锁、占 libuv 线程池)。rename 失败(跨卷 EXDEV、Windows
        // 下被占用等)回退原 cp 路径;rename 原子,失败时 cloneDir 原样保留。
        // verbatimSymlinks:与 rename 一致地原样保留仓库内相对链接(默认会改写成指向 tmpRoot 的绝对路径,
        // finally 删掉 tmpRoot 后链接失效)。Windows 下 cp 建链接不传类型,目录链接可能被判成 file 类型
        //(Node fsp.symlink 按目标 stat 判定),与 rename 不完全一致;Windows 上 git 默认 core.symlinks=false(检出为普通文件),罕见。
        await fs.rename(cloneDir, staging).catch(async () => {
          await cp(cloneDir, staging, { recursive: true, verbatimSymlinks: true });
        });
      } catch (err) {
        // 复制中途失败(磁盘满等):清掉半截 staging 目录,不留到下次启动的恢复流程。
        await rm(staging, { recursive: true, force: true }).catch(() => {});
        throw err;
      }

      // 数据安全:插件数据 data.json 就存在安装目录里,整目录 swap 会把它丢掉。更新(已有旧目录)时在锁内把旧
      // data.json 带进 staging(覆盖仓库自带的同名文件);无法安全读取 → 中止更新,旧目录原样保留。
      if (backup) {
        try {
          await carryOverPluginData(targetDir, staging);
        } catch (err) {
          await rm(staging, { recursive: true, force: true }).catch(() => {});
          throw err;
        }
      }

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

/**
 * 把旧安装目录的 data.json(插件经 saveData 存的用户数据)带进新版本的 staging 目录。
 * - 旧目录没有 data.json → 什么都不做(仓库自带的 data.json 照旧保留,与全新安装一致)。
 * - 有 → 覆盖 staging 里仓库自带的同名文件:更新不应让仓库内容取代用户数据。
 * - 只认普通文件:noFollow(符号链接 ELOOP / 硬链接 EMLINK / 非普通文件 EFTYPE 一律拒)、大小沿用 plugin-data
 *   的上限、须是合法 UTF-8(按文本读写,非法字节无法原样带过去)。不满足或读写失败 → 抛
 *   PLUGIN_DATA_PRESERVE_FAILED,由调用方中止更新 —— 宁可不更新,也不丢数据 / 不把链接目标的内容复制进来。
 * 调用方须持有该 id 的 mutation 锁(saveData 也走这把锁,读到的就是最后一次落盘的内容)。
 */
async function carryOverPluginData(oldDir: string, stagingDir: string): Promise<void> {
  const src = path.join(oldDir, PLUGIN_DATA_FILE);
  const dst = path.join(stagingDir, PLUGIN_DATA_FILE);
  let text: string;
  try {
    const read = await readFileCappedFd(src, MAX_PLUGIN_DATA_BYTES, { noFollow: true, requireUtf8: true });
    if (read.text === null) {
      throw new Error(read.tooLarge ? `larger than ${MAX_PLUGIN_DATA_BYTES} bytes` : 'not valid UTF-8');
    }
    text = read.text;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw codedError(
      ERROR_CODES.PLUGIN_DATA_PRESERVE_FAILED,
      `无法安全读取插件数据 ${PLUGIN_DATA_FILE},已中止更新(旧版本与数据原样保留): ${errorMessage(err)}`,
    );
  }
  try {
    // 仓库自带的同名条目(文件或目录;克隆树已拒符号链接)先删,再排他创建。
    await rm(dst, { recursive: true, force: true });
    await fs.writeFile(dst, text, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    throw codedError(
      ERROR_CODES.PLUGIN_DATA_PRESERVE_FAILED,
      `无法把插件数据带入新版本,已中止更新: ${errorMessage(err)}`,
    );
  }
}

/**
 * 安全:克隆树(顶层 .git 除外,落位前即删)含任何符号链接 → 抛 PLUGIN_SYMLINK_REJECTED。
 * 宿主以自身权限读安装目录里的文件(data.json / manifest.json / main),仓库提交
 * `data.json -> ../<别的插件>/data.json`、`main.js -> ~/.ssh/id_rsa` 即可借宿主之手读到目录外内容。
 * 不区分树内 / 树外目标:已知插件仓库都不含链接,一律拒绝最简单。
 */
async function assertNoSymlinksInClone(cloneDir: string): Promise<void> {
  const pending = [cloneDir];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    for (const dirent of await fs.readdir(dir, { withFileTypes: true })) {
      if (dir === cloneDir && dirent.name === '.git') continue;
      const full = path.join(dir, dirent.name);
      // 部分文件系统 d_type 未知(三个判定都为 false)→ lstat 补判。
      const st = dirent.isDirectory() || dirent.isFile() || dirent.isSymbolicLink() ? dirent : await fs.lstat(full);
      if (st.isSymbolicLink()) {
        throw codedError(
          ERROR_CODES.PLUGIN_SYMLINK_REJECTED,
          `插件仓库含符号链接,拒绝安装: ${path.relative(cloneDir, full).slice(0, 256)}`,
        );
      }
      if (st.isDirectory()) pending.push(full);
    }
  }
}

function cloneTooLargeError(): Error {
  return codedError(
    ERROR_CODES.PLUGIN_REPO_TOO_LARGE,
    `插件仓库超过大小上限(${PLUGIN_CLONE_MAX_BYTES / (1024 * 1024)}MiB / ${PLUGIN_CLONE_MAX_ENTRIES} 个条目),已中止安装`,
  );
}

/**
 * 有界统计 clone 目录(含 .git)的逻辑字节数与条目数,任一超过上限即停止并返回 true。clone 写入中的瞬时态
 *(目录 / 文件刚被 git 改名或删除)读不到就跳过。单次统计最多访问 PLUGIN_CLONE_MAX_ENTRIES 个条目。
 */
async function cloneTreeExceedsLimits(dir: string): Promise<boolean> {
  let bytes = 0;
  let entries = 0;
  const pending = [dir];
  while (pending.length > 0) {
    const cur = pending.pop()!;
    let dirents: Dirent[];
    try {
      dirents = await fs.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      if (++entries > PLUGIN_CLONE_MAX_ENTRIES) return true;
      const full = path.join(cur, dirent.name);
      if (dirent.isDirectory()) {
        pending.push(full);
        continue;
      }
      let st: Stats;
      try {
        st = await fs.lstat(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        pending.push(full);
        continue;
      }
      bytes += st.size;
      if (bytes > PLUGIN_CLONE_MAX_BYTES) return true;
    }
  }
  return false;
}

/** budgetDir:clone 目标目录;clone 期间轮询其体积 / 条目数,超限即终止 git(见 PLUGIN_CLONE_MAX_BYTES)。 */
function runGit(args: readonly string[], budgetDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // 禁交互式凭据:防指向需认证的私有 repo 时 git 弹凭据提示永久挂起。GIT_CONFIG_NOSYSTEM 隔离系统级
    // git 配置;用户全局 ~/.gitconfig 的 credential.helper 仍生效(有意保留:私有插件仓库依赖钥匙串凭据,
    // 且 helper 按目标主机取凭据,clone 跨主机重定向时 git 不携带凭据,不构成泄露)。
    // 与插件子进程同一加固(见 lib/child-spawn-hardening):注入 core.fsmonitor=false(clone 不受影响);
    // Windows 上 git 只在 PATH 的绝对目录中解析 —— CLI 启动时主进程 cwd 即用户所在目录(可能是不可信
    // 仓库),裸名 spawn 会先执行其中的 git.exe。解析不到 → GIT_SPAWN_FAILED(fail-closed)。
    // 纵深:入口已限定 https URL,再以 GIT_ALLOW_PROTOCOL=https:ssh 限定传输协议(重定向 / 子模块等不得换用
    // file / ext 等协议;优先于仓库与全局 protocol.*.allow 配置)。放行 ssh 的理由:git 先按 url.*.insteadOf
    // 改写 URL 再查白名单,用户全局 ~/.gitconfig 常见 `url."ssh://git@github.com/".insteadOf=https://github.com/`
    //(GIT_CONFIG_NOSYSTEM 不屏蔽全局配置),只放 https 会 `transport 'ssh' not allowed` 致插件装不上。ssh 改写
    // 只可能来自用户自己的全局配置;clone 目标是新建临时目录,不存在仓库级 config 攻击面;http 重定向不能换成 ssh。
    // 剥离宿主内部机密(CONTINUO_MCP_TOKEN)。
    const env = withGitHardeningEnv(
      mergeSpawnEnv(stripInternalSecretEnv(process.env), {
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_ALLOW_PROTOCOL: 'https:ssh',
        GIT_LFS_SKIP_SMUDGE: '1',
      }),
      process.platform,
      PLUGIN_CLONE_GIT_CONFIG,
    );
    const spawnGit = () =>
      spawn(resolveSpawnCommand('git', env), args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let child: ReturnType<typeof spawnGit>;
    try {
      child = spawnGit();
    } catch (err) {
      reject(codedError(ERROR_CODES.GIT_SPAWN_FAILED, `git spawn 失败: ${errorMessage(err)}`));
      return;
    }
    // 边界(E62 + E131):按真实 UTF-8 字节累积/截断,decode 延后整体进行(见 byte-capped-buffer)。
    const stderrCap = createByteCappedBuffer(MAX_GIT_STDERR_BYTES);
    let settled = false;
    // 超出体积 / 条目上限、已发出终止:等 git 真正退出再结算(调用方随即删临时目录,不与仍在写的 git 赛跑)。
    let overBudget = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(pollTimer);
      fn();
    };
    // timeout:防慢速/挂起的远端无限占用(DoS)。SIGTERM → 1s 后 SIGKILL。
    const timer = setTimeout(() => {
      killWithGrace(child);
      finish(() =>
        reject(
          overBudget
            ? cloneTooLargeError()
            : // 独立错误码:renderer 按 code 本地化出 ssh host key / 口令提示(GUI 无终端应答 ssh 交互,只会超时)
              codedError(ERROR_CODES.GIT_TIMEOUT, `git ${args[0]} 超时`),
        ),
      );
    }, GIT_CLONE_TIMEOUT_MS);
    // 上一次统计结束后才排下一次(不重叠)。
    const poll = async (): Promise<void> => {
      const exceeded = await cloneTreeExceedsLimits(budgetDir).catch(() => false);
      if (settled || overBudget) return;
      if (exceeded) {
        overBudget = true;
        killWithGrace(child);
        return;
      }
      pollTimer = setTimeout(() => void poll(), PLUGIN_CLONE_POLL_MS);
    };
    pollTimer = setTimeout(() => void poll(), PLUGIN_CLONE_POLL_MS);
    // 边界(E62 + E131):按真实字节累积上限,超限停止追加(保留前 64KB 字节)+ 标记截断,不 kill
    //(进度合法 >64KB)。
    child.stderr.on('data', (d: Buffer) => stderrCap.push(d));
    child.on('error', (err) =>
      finish(() =>
        reject(
          codedError(ERROR_CODES.GIT_SPAWN_FAILED, `git spawn 失败: ${err.message}`),
        ),
      ),
    );
    child.on('exit', (code) => {
      if (overBudget) finish(() => reject(cloneTooLargeError()));
      else if (code === 0) finish(resolve);
      else
        finish(() =>
          reject(
            codedError(ERROR_CODES.GIT_FAILED, `git ${args[0]} exit ${code}: ${stderrCap.text().trim()}${stderrCap.truncated ? ' …(stderr truncated)' : ''}`,),
          ),
        );
    });
  });
}

// ── v4.3.1 mtime watch ─────────────────────────────────

export interface PluginsWatcher {
  /** 单次扫描:mtime 变化触发 onChange,首次只填表不 fire. */
  tick(): Promise<void>;
  /**
   * 启动周期 tick;返 dispose 停 timer。immediate(默认 true)= 立即首扫;false = 首扫等第一个周期
   *(冷启动不与启动 IO 争 libuv 线程池),期间由 ensureBaseline 按需建立基线。
   */
  start(intervalMs: number, opts?: { immediate?: boolean }): { dispose(): void };
  /**
   * 确保基线(首扫)已建立:已建立 → 立即返回;首扫在途 → 等它结束;尚未开始 → 立即触发一次并等待。
   * 扫描失败也返回(best-effort,不阻塞调用方)。LIST_DIRS 列举前调用:列举之后的修改必被后续 tick 发现。
   */
  ensureBaseline(): Promise<void>;
}

/**
 * watcher 记录(在场 + 缺失 tombstone)总数上限。缺失记录不限时保留(重建再晚也要触发热重载),只在总数
 * 超过上限时淘汰最早缺失的记录。在场记录 ≤ 单轮目录枚举上限,故缺失记录至少还有同等容量。
 */
const WATCHER_RECORD_CAP = 2 * MAX_PLUGIN_DIR_ENTRIES;

/**
 * 跨平台 plugin 文件改动监听:不用 fs.watch(macOS 不支持 recursive 默认,
 * Linux/Windows 行为不一致),改为 stat mtime 轮询。
 * tick() exposed for unit test;生产 start(2000) 每 2 秒扫一次。
 */
export function createPluginsWatcher(
  baseDir: string,
  onChange: (id: string) => void,
  opts: { missingRecordCap?: number } = {},
): PluginsWatcher {
  const recordCap = opts.missingRecordCap ?? WATCHER_RECORD_CAP;
  // pluginId → { dirs: 全部候选目录名(陈旧键 / tombstone / knownDirs 记账), sig: 全部候选目录的合并签名 }。
  // watcher 只决定是否广播,不选目录:重复 manifest.id 时选哪个目录由 renderer PluginManager.selectPluginDirs 统一决定
  //(它还看 manifest schema 与 minLMVersion,main 判断不了),所以任一候选目录变化都要广播。签名按目录名排序拼接
  // (目录名 + main mtime + manifest 内容哈希),多轮无变化时稳定 —— 此前以 id 为键、多个目录轮流写同一键 → 每轮都
  // 判定变化,形成永久热重载风暴。manifest 内容变化也算变化:激活时令牌不一致的插件会激活失败,须由此广播重新加载。
  // 记录分两张表:active = 上一轮有候选目录的 id(≤ 单轮枚举上限);missing = 未被选中(目录 / manifest / main
  // 暂不可见)的 tombstone,插入序 = 开始缺失的先后。tombstone 不限时保留(rm -rf 后部署/构建/网络卷恢复再久,
  // 重建后 main 已变仍要触发热重载),仅在记录总数超 recordCap 时淘汰最早缺失的。missingByDir 为 tombstone
  // 的目录索引:每轮只按「本轮出现的目录」查 tombstone,遍历成本与当前目录数相关,不随历史缺失记录数增长。
  type WatchRecord = { dirs: readonly string[]; sig: string };
  const active = new Map<string, WatchRecord>();
  const missing = new Map<string, WatchRecord>();
  const missingByDir = new Map<string, Set<string>>();
  // tombstone 按其**全部**候选目录建索引(任一候选目录本轮出现都要参与陈旧判定 / knownDirs)。
  const addMissing = (pluginId: string, rec: WatchRecord): void => {
    missing.set(pluginId, rec);
    for (const dir of rec.dirs) {
      let ids = missingByDir.get(dir);
      if (ids === undefined) {
        ids = new Set();
        missingByDir.set(dir, ids);
      }
      ids.add(pluginId);
    }
  };
  const deleteMissing = (pluginId: string): void => {
    const rec = missing.get(pluginId);
    if (rec === undefined) return;
    missing.delete(pluginId);
    for (const dir of rec.dirs) {
      const ids = missingByDir.get(dir);
      ids?.delete(pluginId);
      if (ids?.size === 0) missingByDir.delete(dir);
    }
  };
  // 记录陈旧 = 它的每个候选目录本轮都可解析且声明了别的 id(不再有任何目录代表它)。目录暂时消失 / manifest
  // 缺失或损坏时不算陈旧(转 / 留 tombstone)。
  const isStale = (pluginId: string, rec: WatchRecord): boolean =>
    rec.dirs.every((dir) => {
      const info = manifestCache.get(dir)?.info;
      return info !== undefined && info !== null && info.pluginId !== pluginId;
    });
  let firstRun = true;
  let cancelled = false;
  // race(R5):tick 异步扫描(readdir+stat+readFile)慢于 interval 时,setInterval 会并发触发多个
  // tick,并发读写共享的记录表/firstRun —— 并发的 first-run 扫描都按 firstRun=true 吞掉实际变更,
  // 或交错写记录表致重复 onChange/reload。单飞守卫:同一时刻只跑一个扫描;期间新 tick 标记
  // pending,当前扫描结束后补跑一次。记录表/firstRun 只在串行的 runScan 内更新。
  let running = false;
  let pending = false;
  // 首轮扫描(基线)完成信号,供 ensureBaseline 等待。只等首轮、不等整个在途循环:单次扫描耗时超过周期时
  // 每个周期 tick 都会置 pending,循环可一直补跑不结束,等整个循环会让 LIST_DIRS 永远挂住。循环在基线建立
  // 之前结束(扫描抛错)时也结算(best-effort,不挂住调用方;下次 ensureBaseline 重新发起)。
  let firstScanDone: Promise<void> | null = null;
  let settleFirstScan: (() => void) | null = null;
  const markFirstScanSettled = () => {
    settleFirstScan?.();
    settleFirstScan = null;
    firstScanDone = null;
  };
  let truncationWarned = false;

  // perf:manifest 解析结果缓存(目录名 → manifest 的 stat 签名 + 解析结果)。此前每 2s 对每个插件
  // 完整读 + JSON.parse manifest,即使无任何变化。签名含 ino/size/mtime/ctime:原子替换(rename → 新 ino)、
  // 原地改写(ctime 必变,即便 mtime 被还原)、删除(stat 失败 → 跳过并清缓存)、新增(无缓存)都会重读。
  // 先 stat 再读:读到的内容不会比签名旧,期间若又被改,下轮签名不同会再读。
  // info=null 表示 manifest 不是合法 JSON 或超过大小上限(与旧版同:跳过该目录)。条目只保留本轮枚举到的目录名。
  const manifestCache = new Map<
    string,
    { sig: string; info: { mainName: string; pluginId: string; manifestHash: string } | null }
  >();

  /** 单目录探测:返回 { name, pluginId, mtime }(main 文件 mtime),不可监控 → null。可并发执行。 */
  const probeEntry = async (
    dirent: import('node:fs').Dirent,
  ): Promise<{ name: string; pluginId: string; mtime: number; manifestHash: string } | null> => {
    const name = dirent.name;
    if (name.startsWith('.') || name.startsWith('_')) return null;
    const dir = path.join(baseDir, name);

    // perf:枚举的 Dirent 已带类型 → 目录直接通过、普通文件直接跳过,不再每轮每目录额外 stat;
    // 仅 symlink / 类型未知(部分文件系统 d_type=UNKNOWN)等回退 stat,判定口径同旧版(跟随 symlink)。
    if (!dirent.isDirectory()) {
      if (dirent.isFile()) return null;
      let dirStat: import('node:fs').Stats;
      try {
        dirStat = await fs.stat(dir);
      } catch {
        return null;
      }
      if (!dirStat.isDirectory()) return null;
    }

    const manifestPath = path.join(dir, 'manifest.json');
    let manifestStat: import('node:fs').Stats;
    try {
      manifestStat = await fs.stat(manifestPath);
    } catch {
      manifestCache.delete(name);
      return null; // 缺 manifest → 跳过(同旧版 readFileCapped 返 null)
    }
    const sig = `${manifestStat.ino}:${manifestStat.size}:${manifestStat.mtimeMs}:${manifestStat.ctimeMs}`;
    let cached = manifestCache.get(name);
    if (cached === undefined || cached.sig !== sig) {
      // 边界(E27,E24/listPluginDirs 同源):watcher 扫描读 manifest 也走有界读(同 MANIFEST_MAX_BYTES),
      // 避免超大 manifest 整块读入。读失败(缺失 / EACCES 等)→ 跳过该目录且不缓存,下轮重试。
      // perf:超限 → 按本轮签名缓存为 info=null(跳过),签名不变不再每 2s open+fstat + 告警,改动后照常重读。
      // 安全:与列举(readPluginManifestText)同口径 —— manifest 的真实路径须仍在插件目录内。旧安装的目录可能带
      // 符号链接(manifest.json -> 目录外文件),不校验就会对目录外文件算 hash、取 id。越界按本轮签名缓存为跳过。
      if (!(await staysInsidePluginDir(dir, manifestPath))) {
        manifestCache.set(name, { sig, info: null });
        return null;
      }
      let text: string | null;
      try {
        const read = await readFileCappedFd(manifestPath, MANIFEST_MAX_BYTES);
        if (read.tooLarge) {
          console.warn(`[plugins] 跳过超大文件(> ${MANIFEST_MAX_BYTES}): ${manifestPath}`);
          manifestCache.set(name, { sig, info: null });
          return null;
        }
        text = read.text;
      } catch {
        text = null;
      }
      if (text === null) {
        manifestCache.delete(name);
        return null;
      }
      let info: { mainName: string; pluginId: string; manifestHash: string } | null;
      try {
        const m = JSON.parse(text) as { main?: unknown; id?: unknown };
        let pluginId = name;
        // 边界(E101,E97/E100 id 前门一致性):manifest.id 复用 isSafePluginId + 长度上限。此前仅
        // typeof+非空 → 畸形本地插件可用超长/非法 id 当 mtimes key + 经 PLUGINS_CHANGED 广播到
        // renderer,PluginManager reload 找不到合法 entry 或把超长 id 带进日志/状态(Map/IPC 放大 +
        // 热重载错位)。非法 id 回退目录名(pluginId = 目录名,与 listPluginDirs 用目录名一致)。
        // (manifest 为 JSON null 时 m.id 抛 TypeError → 视为非法 manifest 跳过,同旧版。)
        if (
          typeof m.id === 'string' &&
          isSafePluginId(m.id)
        ) {
          pluginId = m.id;
        }
        // M20:共用 getPluginMainName;哈希仅在签名变化重读时计算一次
        info = { mainName: getPluginMainName(m), pluginId, manifestHash: pluginManifestHash(text) };
      } catch {
        info = null;
      }
      cached = { sig, info };
      manifestCache.set(name, cached);
    }
    if (cached.info === null) return null;

    try {
      const mainPath = resolvePluginMainPath(dir, cached.info.mainName);
      if (!mainPath) return null;
      const fileStat = await fs.stat(mainPath);
      // 与列举 isPluginMainAvailable 同口径(普通文件且 ≤ MAIN_MAX_BYTES),否则重复 id 时列举跳过的无效目录
      // 会被算作候选、进签名与记账(误广播或漏判)。只用 stat 结果判定,不为每插件每轮 open;「可打开(读权限)」
      // 无法从 stat 廉价等价判断,取舍:不校验(插件目录归用户所有,main 有 stat 无读权限极罕见)。
      if (!fileStat.isFile() || fileStat.size > MAIN_MAX_BYTES) return null;
      return {
        name,
        pluginId: cached.info.pluginId,
        mtime: fileStat.mtimeMs,
        manifestHash: cached.info.manifestHash,
      };
    } catch {
      return null;
    }
  };

  const runScan = async (): Promise<void> => {
    // 边界(E82):有界枚举(缺目录 → [] → 循环 no-op,等价旧版早返)。截断告警只在进入截断状态时打一次
    //(每 2s 轮询,持续截断时不刷屏)。
    let truncated = false;
    const entries = await readPluginDirentsCapped(baseDir, (dir) => {
      truncated = true;
      if (!truncationWarned) warnPluginDirTruncated(dir);
    });
    truncationWarned = truncated;
    // perf:per-dir stat(+ 必要时读 manifest)有界并发;记录比较 / onChange 仍按枚举顺序串行(同旧版)。
    const probes = await mapInOrderBounded(entries, probeEntry);
    if (manifestCache.size > 0) {
      const live = new Set(entries.map((dirent) => dirent.name));
      for (const name of manifestCache.keys()) {
        if (!live.has(name)) manifestCache.delete(name);
      }
    }
    // 每个 id 归集全部候选目录(Map 插入序 = 各 id 首次出现的枚举序,onChange 顺序与旧版一致)。
    const groups = new Map<string, { name: string; mtime: number; manifestHash: string }[]>();
    for (const probe of probes) {
      if (probe === null) continue;
      const group = groups.get(probe.pluginId);
      if (group) group.push(probe);
      else groups.set(probe.pluginId, [probe]);
    }
    const chosen = new Map<string, WatchRecord>();
    for (const [pluginId, group] of groups) {
      group.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
      const sig = group.map((g) => `${g.name}\0${g.mtime}\0${g.manifestHash}`).join('\n');
      chosen.set(pluginId, { dirs: group.map((g) => g.name), sig });
    }
    // 本轮之前被记录过的目录:某 id 首次出现在其中 = 该目录改声明了新 id(更新换了 id),也算变化。
    // 须在本轮增删记录前取(含 tombstone 的目录);只需判定本轮被选中的目录。
    const knownDirs = new Set<string>();
    for (const prev of active.values()) for (const d of prev.dirs) knownDirs.add(d);
    for (const group of groups.values()) {
      for (const { name } of group) if (missingByDir.has(name)) knownDirs.add(name);
    }
    // 清理陈旧键:记录所属目录现在(manifest 可解析)声明的是别的 id → 该记录不再代表任何目录。
    // 目录暂时消失 / manifest 缺失或损坏 / main 暂不可 stat 时转为 tombstone 保留:重建后 main 已变仍要触发
    // 热重载(rm -rf 后重新部署、编辑器 unlink+write 保存),与旧版同口径。
    for (const [pluginId, prev] of active) {
      if (chosen.has(pluginId)) continue;
      active.delete(pluginId);
      if (!isStale(pluginId, prev)) addMissing(pluginId, prev);
    }
    // tombstone 的陈旧判定只可能发生在本轮枚举到(manifestCache 有条目)的目录上 → 按目录索引查,
    // 不遍历全部 tombstone。
    if (missingByDir.size > 0) {
      for (const [dirName, { info }] of manifestCache) {
        if (!info) continue;
        const ids = missingByDir.get(dirName);
        if (ids === undefined) continue;
        for (const pluginId of [...ids]) {
          const rec = missing.get(pluginId);
          if (rec && !chosen.has(pluginId) && isStale(pluginId, rec)) deleteMissing(pluginId);
        }
      }
    }
    for (const [pluginId, record] of chosen) {
      const prev = active.get(pluginId) ?? missing.get(pluginId);
      deleteMissing(pluginId);
      // race(R67):先记录新 mtime,再 onChange。此前顺序相反,而整段在 try{}catch{continue} 内 —
      // 若 onChange(广播 send)抛错,会被 per-entry catch 吞掉 continue → mtimes.set 不执行 →
      // mtimes 不推进 → 同一变更每个 tick 反复触发/反复失败(广播一直打不出去)。改为变更检测
      // 一旦确认即记录 mtime,通知(onChange)成败不影响 mtime 推进:坏窗口由 onChange 内部
      // per-window try/catch 兜底(R67-A),不再回灌脏状态。
      active.set(pluginId, record);
      // 候选目录增减、任一候选的 main / manifest 变化都改变签名。新出现的 id:其候选目录之前被记录过 = 目录改声明了新 id。
      const changed =
        prev === undefined
          ? groups.get(pluginId)!.some(({ name }) => knownDirs.has(name))
          : prev.sig !== record.sig;
      if (!firstRun && changed) {
        try {
          onChange(pluginId);
        } catch {
          // 同旧版 per-entry catch:通知失败不影响后续条目
        }
      }
    }
    // 按容量淘汰:记录总数超上限时淘汰最早缺失的 tombstone(Map 插入序 = 缺失先后;均摊 O(1))。
    while (active.size + missing.size > recordCap && missing.size > 0) {
      const oldest = missing.keys().next().value as string;
      deleteMissing(oldest);
    }
    firstRun = false;
    markFirstScanSettled();
  };

  // 单飞包装:重入则置 pending,当前扫描结束后串行补跑(不并发)。
  const tick = async (): Promise<void> => {
    if (cancelled) return;
    if (running) {
      pending = true;
      return;
    }
    running = true;
    if (firstRun && firstScanDone === null) {
      firstScanDone = new Promise<void>((resolve) => {
        settleFirstScan = resolve;
      });
    }
    try {
      do {
        pending = false;
        await runScan();
      } while (pending && !cancelled);
    } finally {
      running = false;
      markFirstScanSettled();
    }
  };

  return {
    tick,
    ensureBaseline: async () => {
      if (!firstRun || cancelled) return;
      // 未在扫描 → 发起(同步进入循环并建立 firstScanDone);在扫描 → 该循环必始于基线建立前(firstRun 单向)。
      if (!running) void tick().catch(() => {});
      await firstScanDone;
    },
    start: (intervalMs, { immediate = true } = {}) => {
      cancelled = false;
      if (immediate) void tick();
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
