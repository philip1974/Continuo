#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ADAPTER_VERSION = 'v1.117.0';
const RELEASE_URL =
  `https://github.com/microsoft/vscode-js-debug/releases/download/${ADAPTER_VERSION}/js-debug-dap-${ADAPTER_VERSION}.tar.gz`;
const EXPECTED_SHA256 =
  'ad8d04ede9d4b75cc290fd5438a65047a06f786d04f604b6112485b36f090772';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);
const adapterRoot = path.join(repoRoot, 'scripts', 'debug-spike', '.adapter');
const dapServerPath = path.join(
  adapterRoot,
  'js-debug',
  'src',
  'dapDebugServer.js',
);
// dapDebugServer.js 是 CommonJS bundle(用 require)。仓库 root package.json 是
// "type":"module",若不在 js-debug/ 放一个 type:commonjs 标记,node 会按最近的
// root package.json 把 .js 当 ESM 加载 → require 未定义 → "Dynamic require of fs"。
// 写一个本地 package.json 覆盖继承的 type,让 adapter .js 按 CJS 加载。
const CJS_MARKER_CONTENT = '{ "type": "commonjs" }\n';
// 缓存标记:解包完成后写在 .adapter/ 根(不在被打包的 js-debug/ 内),记录 adapter 版本、
// 已校验的 tarball sha256 与解包结果的目录树哈希。缓存命中须三者全部吻合,否则删除重下。
// 这是一致性检查,不是安全边界:树哈希与被校验的目录放在同一处,是自证值 —— 能发现意外损坏、
// 手工误改、版本 / sha256 升级后的过期缓存、解包中断留下的半成品;发现不了同时改掉 js-debug/ 和
// 本标记的人(有本地写权限即可重算树哈希,那样的攻击者也能直接改本脚本)。要排除本地缓存被
// 蓄意改动,须删掉 .adapter/ 从钉死 sha256 的 tarball 重新解包(干净检出 / CI 即如此)。
const CACHE_MARKER_NAME = '.continuo-adapter-cache.json';

function failClear(reason, details) {
  console.error(`[fetch-debug-adapter] FAIL: ${reason}`);
  console.error(`[fetch-debug-adapter] URL: ${RELEASE_URL}`);
  console.error(`[fetch-debug-adapter] expected sha256: ${EXPECTED_SHA256}`);
  console.error(`[fetch-debug-adapter] actual sha256: ${details.actualSha ?? 'n/a'}`);
  console.error(`[fetch-debug-adapter] HTTP status: ${details.httpStatus ?? 'n/a'}`);
  process.exitCode = 1;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// 下载到内存:校验与解包用同一份字节,中间不落盘(无可预测的临时文件、无 TOCTOU)。
async function downloadTarball() {
  let response;
  try {
    response = await fetch(RELEASE_URL);
  } catch (err) {
    throw Object.assign(new Error(`download failed: ${err.message}`), {
      httpStatus: 'network-error',
    });
  }

  if (!response.ok || !response.body) {
    throw Object.assign(
      new Error(`download failed with HTTP ${response.status}`),
      { httpStatus: response.status },
    );
  }

  return { buffer: Buffer.from(await response.arrayBuffer()), httpStatus: response.status };
}

function readCString(buffer, start, length) {
  const end = buffer.indexOf(0, start);
  const sliceEnd = end === -1 || end > start + length ? start + length : end;
  return buffer.toString('utf8', start, sliceEnd);
}

function readOctal(buffer, start, length) {
  const raw = readCString(buffer, start, length).trim();
  if (raw === '') return 0;
  if (!/^[0-7]+$/.test(raw)) {
    throw new Error(`invalid tar octal field: ${raw}`);
  }
  return Number.parseInt(raw, 8);
}

function isZeroBlock(block) {
  for (const byte of block) {
    if (byte !== 0) return false;
  }
  return true;
}

function validateEntryPath(entryPath) {
  if (entryPath !== 'js-debug/' && !entryPath.startsWith('js-debug/')) {
    throw new Error(`tar entry outside js-debug/: ${entryPath}`);
  }
  if (
    entryPath.startsWith('/') ||
    entryPath.startsWith('\\') ||
    /^[A-Za-z]:/.test(entryPath) ||
    entryPath.includes('\\')
  ) {
    throw new Error(`unsafe tar entry path: ${entryPath}`);
  }
  const cleanPath = entryPath.endsWith('/') ? entryPath.slice(0, -1) : entryPath;
  const parts = cleanPath.split('/');
  if (parts.some((part) => part === '..' || part === '')) {
    throw new Error(`unsafe tar entry path: ${entryPath}`);
  }
}

export function parseTarGz(tarGzBuffer) {
  const tarBuffer = gunzipSync(tarGzBuffer);
  const entries = [];
  let offset = 0;

  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);
    offset += 512;

    if (isZeroBlock(header)) {
      break;
    }

    const name = readCString(header, 0, 100);
    const mode = readOctal(header, 100, 8);
    const size = readOctal(header, 124, 12);
    const typeFlag = readCString(header, 156, 1) || '0';
    const prefix = readCString(header, 345, 155);
    const entryPath = prefix ? `${prefix}/${name}` : name;

    validateEntryPath(entryPath);
    if (typeFlag !== '0' && typeFlag !== '5') {
      throw new Error(
        `rejected non-regular tar entry ${entryPath} type=${typeFlag}`,
      );
    }
    if (offset + size > tarBuffer.length) {
      throw new Error(`truncated tar entry: ${entryPath}`);
    }

    entries.push({
      path: entryPath,
      type: typeFlag === '5' ? 'dir' : 'file',
      mode,
      data: tarBuffer.subarray(offset, offset + size),
    });
    offset += Math.ceil(size / 512) * 512;
  }

  return entries;
}

export async function extractEntries(entries, root) {
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });

  for (const entry of entries) {
    const outputPath = path.resolve(root, entry.path);
    if (!outputPath.startsWith(`${root}${path.sep}`)) {
      throw new Error(`resolved path escaped adapter root: ${entry.path}`);
    }

    if (entry.type === 'dir') {
      await fs.mkdir(outputPath, { recursive: true });
      continue;
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, entry.data, {
      mode: entry.mode ? entry.mode & 0o777 : 0o644,
    });
  }
}

// 目录树哈希:按相对路径排序,逐文件纳入「路径 NUL 内容 sha256 NUL」。只收普通文件;
// 出现符号链接等非常规条目即视为不可信(返回 null),解包本身也不会产生它们。
export async function computeTreeHash(dir) {
  const files = [];
  async function walk(rel) {
    const entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true });
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(childRel);
      else if (e.isFile()) files.push(childRel);
      else throw new Error(`unexpected entry in adapter dir: ${childRel}`);
    }
  }
  try {
    await walk('');
  } catch {
    return null;
  }
  files.sort();
  const hash = createHash('sha256');
  for (const rel of files) {
    hash.update(rel);
    hash.update('\0');
    hash.update(sha256Hex(await fs.readFile(path.join(dir, rel))));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export async function writeCacheMarker(root, { version, sha256 }) {
  const treeHash = await computeTreeHash(path.join(root, 'js-debug'));
  await fs.writeFile(
    path.join(root, CACHE_MARKER_NAME),
    `${JSON.stringify({ version, sha256, treeHash }, null, 2)}\n`,
  );
}

// 缓存有效:标记文件存在、版本与 sha256 等于当前钉死的值、js-debug/ 树哈希与标记一致。
// 标记里的 sha256 只是「解包时校验过的那个值」的记录,这里并没有重新对照 tarball(见 CACHE_MARKER_NAME 注释)。
export async function isCacheValid(root, { version, sha256 }) {
  let marker;
  try {
    marker = JSON.parse(await fs.readFile(path.join(root, CACHE_MARKER_NAME), 'utf8'));
  } catch {
    return false;
  }
  if (!marker || marker.version !== version || marker.sha256 !== sha256) return false;
  if (typeof marker.treeHash !== 'string') return false;
  const treeHash = await computeTreeHash(path.join(root, 'js-debug'));
  return treeHash !== null && treeHash === marker.treeHash;
}

async function main() {
  const pinned = { version: ADAPTER_VERSION, sha256: EXPECTED_SHA256 };
  if ((await fileExists(dapServerPath)) && (await isCacheValid(adapterRoot, pinned))) {
    console.log(`[fetch-debug-adapter] cache hit (verified): ${dapServerPath}`);
    return;
  }

  const envTarball = process.env.JS_DEBUG_DAP_TARBALL;
  let source;
  let actualSha;
  try {
    source = envTarball
      ? { buffer: await fs.readFile(path.resolve(envTarball)), httpStatus: 'env-override' }
      : await downloadTarball();

    actualSha = sha256Hex(source.buffer);
    if (actualSha !== EXPECTED_SHA256) {
      failClear('sha256 mismatch; refusing to extract', {
        actualSha,
        httpStatus: source.httpStatus,
      });
      return;
    }

    // 解包的正是刚校验过的那份 buffer。extractEntries 先整体删除 adapterRoot(含旧缓存与标记)。
    const entries = parseTarGz(source.buffer);
    await extractEntries(entries, path.resolve(adapterRoot));

    if (!(await fileExists(dapServerPath))) {
      failClear('extraction finished but dapDebugServer.js is missing', {
        actualSha,
        httpStatus: source.httpStatus,
      });
      return;
    }

    await fs.writeFile(path.join(adapterRoot, 'js-debug', 'package.json'), CJS_MARKER_CONTENT);
    await writeCacheMarker(adapterRoot, pinned);
    console.log(`[fetch-debug-adapter] extracted ${entries.length} entries`);
    console.log(`[fetch-debug-adapter] ready: ${dapServerPath}`);
  } catch (err) {
    failClear(err.message, {
      actualSha,
      httpStatus: err.httpStatus ?? source?.httpStatus,
    });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
