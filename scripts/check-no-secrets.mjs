#!/usr/bin/env node
// 发布前机密扫描:历史上 v0.2.5 安装包把 GitHub token 打进了 app.asar。
// 用法:node scripts/check-no-secrets.mjs [<目录或文件>...] [--packaged <electron-builder 输出目录>]...
// - 只扫构建产物(out/ out-pack/ dist-electron/),不扫源码,测试 fixture 里的假值不受影响。
// - 位置参数:整棵目录 / 文件全部扫描(用于 out/、out-pack/ 这类纯 JS/HTML 产物)。
// - --packaged:扫其下每个 app.asar 所在的资源目录整体(mac 的 Contents/Resources、win/linux 的
//   resources/):app.asar、app.asar.unpacked/ 以及 electron-builder extraResources 放进去的
//   continuo-mcp-stdio.mjs、js-debug/ 等。Electron Framework 等上游二进制在资源目录之外
//   (体积大且随机字节会误中 AKIA 规则,也不可能含本仓凭据),不扫;
//   一个 app.asar 都没找到 → 视为扫描失败(退出码 2)。
// - 命中时删除 --packaged 目录顶层本次构建的分发产物(dmg / zip / blockmap / exe 等安装包、
//   SHA256SUMS*、latest*.yml;以 mtime 不早于 app.asar 判定为本次产物),防止手动
//   gh release create 照样上传。选删除而非改名:改名后的文件仍可能被 dist-electron/* 通配上传;
//   保留解包的 .app / app.asar 以便按输出的偏移定位来源;不动历史版本的产物。
// - app.asar 是未压缩归档,直接对文件做二进制匹配即可覆盖其内容。
// - .dmg / .zip / 安装器等压缩容器无法直接匹配,跳过。
// - 命中只输出「文件:偏移 规则名」,绝不输出命中的值本身(避免 CI 日志二次泄漏)。
// - 任一给定路径不存在 → 退出码 2(fail-closed:扫了个空不能算通过)。命中 → 退出码 1。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SECRET_RULES = [
  { name: 'github-token', re: /(?:gho|ghp|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g },
  { name: 'github-fine-grained-pat', re: /github_pat_[A-Za-z0-9_]{20,}/g },
  { name: 'aws-access-key-id', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'npm-token', re: /npm_[A-Za-z0-9]{36}/g },
  { name: 'openai-style-key', re: /sk-[A-Za-z0-9]{20,}/g },
  { name: 'slack-token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
];

// 压缩容器:原始字节里匹配不到明文,扫描无意义(且 dist-electron 会累积历史版本的大文件)。
const SKIP_EXTENSIONS = new Set([
  '.dmg',
  '.zip',
  '.blockmap',
  '.7z',
  '.gz',
  '.xz',
  '.bz2',
  '.appimage',
  '.deb',
  '.rpm',
  '.snap',
  '.msi',
  '.nupkg',
]);

const CHUNK = 8 * 1024 * 1024;
// 相邻块的重叠字节:保证起点落在本块内、长度 ≤ OVERLAP 的命中能被完整匹配。
const OVERLAP = 1024;

async function scanFile(filePath, findings) {
  const handle = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(CHUNK + OVERLAP);
    let pos = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, pos);
      if (bytesRead === 0) break;
      const isLast = bytesRead < buf.length;
      const text = buf.toString('latin1', 0, bytesRead);
      for (const rule of SECRET_RULES) {
        rule.re.lastIndex = 0;
        let m;
        while ((m = rule.re.exec(text)) !== null) {
          // 非末块只认起点在 [0, CHUNK) 内的命中;落在重叠区的由下一块负责,避免重复报告。
          if (isLast || m.index < CHUNK) {
            findings.push({ file: filePath, offset: pos + m.index, rule: rule.name });
          }
        }
      }
      if (isLast) break;
      pos += CHUNK;
    }
  } finally {
    await handle.close();
  }
}

async function walk(target, findings, stats) {
  const st = await fs.lstat(target);
  // 不跟随符号链接:.app 包内的 Framework 版本链接会造成重复扫描甚至环。
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    const names = await fs.readdir(target);
    names.sort();
    for (const name of names) await walk(path.join(target, name), findings, stats);
    return;
  }
  if (!st.isFile()) return;
  if (SKIP_EXTENSIONS.has(path.extname(target).toLowerCase())) return;
  stats.files += 1;
  await scanFile(target, findings);
}

// 在 electron-builder 输出目录里找含 app.asar 的资源目录(不跟随符号链接);找到后整目录扫描,
// 不再向下递归。
async function findResourceDirs(dir, out) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  if (entries.some((e) => e.name === 'app.asar' && e.isFile())) {
    out.push(dir);
    return out;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.isDirectory()) await findResourceDirs(path.join(dir, e.name), out);
  }
  return out;
}

const DISTRIBUTABLE = /\.(dmg|zip|blockmap|exe|msi|appimage|deb|rpm|snap|7z|nupkg)$/i;
const isDistributable = (name) =>
  DISTRIBUTABLE.test(name) || name.startsWith('SHA256SUMS') || /^latest.*\.ya?ml$/.test(name);

/**
 * 删除 dir 顶层 mtime 不早于 sinceMs 的分发产物,返回被删的路径。
 * @param {string} dir
 * @param {number} sinceMs
 */
export async function removeDistributables(dir, sinceMs) {
  const removed = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (!e.isFile() || !isDistributable(e.name)) continue;
    const full = path.join(dir, e.name);
    if ((await fs.stat(full)).mtimeMs < sinceMs) continue;
    await fs.rm(full, { force: true });
    removed.push(full);
  }
  return removed.sort();
}

/**
 * @param {string[]} targets 全量扫描的目录 / 文件
 * @param {string[]} [packaged] electron-builder 输出目录,只扫其中的 app.asar(.unpacked)
 */
export async function scanPaths(targets, packaged = []) {
  const findings = [];
  const missing = [];
  const stats = { files: 0 };
  const exists = async (p) => {
    try {
      await fs.lstat(p);
      return true;
    } catch {
      missing.push(p);
      return false;
    }
  };
  for (const target of targets) {
    if (await exists(target)) await walk(target, findings, stats);
  }
  const builds = [];
  for (const dir of packaged) {
    if (!(await exists(dir))) continue;
    const resourceDirs = await findResourceDirs(dir, []);
    if (resourceDirs.length === 0) {
      missing.push(path.join(dir, '**', 'app.asar'));
      continue;
    }
    // 本次构建的起点:最早的 app.asar 写入时间(安装包在其后生成)。
    let since = Infinity;
    for (const r of resourceDirs) {
      since = Math.min(since, (await fs.stat(path.join(r, 'app.asar'))).mtimeMs);
      await walk(r, findings, stats);
    }
    builds.push({ dir, since });
  }
  return { findings, missing, files: stats.files, builds };
}

export function parseArgs(argv) {
  const targets = [];
  const packaged = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--packaged') {
      const dir = argv[i + 1];
      if (dir === undefined) throw new Error('--packaged 缺少目录参数');
      packaged.push(dir);
      i += 1;
    } else {
      targets.push(argv[i]);
    }
  }
  return { targets, packaged };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    args = { targets: [], packaged: [], error: err.message };
  }
  if (args.error || (args.targets.length === 0 && args.packaged.length === 0)) {
    if (args.error) console.error(`[check-no-secrets] ${args.error}`);
    console.error(
      '[check-no-secrets] 用法: node scripts/check-no-secrets.mjs [<目录或文件>...] [--packaged <dir>]...',
    );
    process.exitCode = 2;
    return;
  }
  const { findings, missing, files, builds } = await scanPaths(args.targets, args.packaged);
  for (const m of missing) console.error(`[check-no-secrets] 路径不存在或未找到可扫描产物: ${m}`);
  for (const f of findings) {
    console.error(`[check-no-secrets] 疑似机密: ${f.file}:${f.offset} (${f.rule})`);
  }
  if (findings.length > 0) {
    for (const b of builds) {
      for (const f of await removeDistributables(b.dir, b.since)) {
        console.error(`[check-no-secrets] 已删除本次分发产物(防误发布): ${f}`);
      }
    }
    console.error(
      `[check-no-secrets] FAIL: ${findings.length} 处命中。构建产物里不得含凭据,定位来源(多为构建期注入的环境变量 / .env)后重新构建。`,
    );
    process.exitCode = 1;
    return;
  }
  if (missing.length > 0) {
    process.exitCode = 2;
    return;
  }
  console.log(`[check-no-secrets] OK: 已扫描 ${files} 个文件,未发现机密`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
