#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const RELEASE_URL =
  'https://github.com/microsoft/vscode-js-debug/releases/download/v1.117.0/js-debug-dap-v1.117.0.tar.gz';
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
const cjsMarkerPath = path.join(adapterRoot, 'js-debug', 'package.json');
async function ensureCommonjsMarker() {
  try {
    await fs.writeFile(cjsMarkerPath, '{ "type": "commonjs" }\n');
  } catch {
    /* best-effort; adapter dir 必已存在 */
  }
}

function failClear(reason, details = {}) {
  console.error(`[fetch-debug-adapter] FAIL: ${reason}`);
  console.error(`[fetch-debug-adapter] URL: ${details.url ?? RELEASE_URL}`);
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

async function sha256File(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', resolve);
  });
  return hash.digest('hex');
}

async function downloadToTmp() {
  const tmpFile = path.join(
    os.tmpdir(),
    `continuo-js-debug-dap-${process.pid}-${Date.now()}.tar.gz`,
  );
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

  const body = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(tmpFile, body);
  return { filePath: tmpFile, httpStatus: response.status, isTmp: true };
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

function parseTarGz(tarGzBuffer) {
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

async function extractEntries(entries) {
  const root = path.resolve(adapterRoot);
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

async function main() {
  if (await fileExists(dapServerPath)) {
    await ensureCommonjsMarker();
    console.log(`[fetch-debug-adapter] cache hit: ${dapServerPath}`);
    return;
  }

  const envTarball = process.env.JS_DEBUG_DAP_TARBALL;
  let source;
  let actualSha;
  try {
    source = envTarball
      ? {
          filePath: path.resolve(envTarball),
          httpStatus: 'env-override',
          isTmp: false,
        }
      : await downloadToTmp();

    actualSha = await sha256File(source.filePath);
    if (actualSha !== EXPECTED_SHA256) {
      failClear('sha256 mismatch; refusing to extract', {
        actualSha,
        httpStatus: source.httpStatus,
      });
      return;
    }

    const entries = parseTarGz(await fs.readFile(source.filePath));
    await extractEntries(entries);

    if (!(await fileExists(dapServerPath))) {
      failClear('extraction finished but dapDebugServer.js is missing', {
        actualSha,
        httpStatus: source.httpStatus,
      });
      return;
    }

    await ensureCommonjsMarker();
    console.log(`[fetch-debug-adapter] extracted ${entries.length} entries`);
    console.log(`[fetch-debug-adapter] ready: ${dapServerPath}`);
  } catch (err) {
    failClear(err.message, {
      actualSha,
      httpStatus: err.httpStatus ?? source?.httpStatus,
    });
  } finally {
    if (source?.isTmp) {
      await fs.rm(source.filePath, { force: true });
    }
  }
}

await main();
