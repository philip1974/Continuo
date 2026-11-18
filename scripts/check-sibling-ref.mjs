#!/usr/bin/env node
// 打包前核对 sibling 依赖 ContinuoTerminal 的版本:package.json 用 `file:../ContinuoTerminal/...`,
// 本身不固定版本;仓库根的 .continuo-terminal-ref 记录应当使用的 commit SHA(CI 也按它检出)。
// 本地 ../ContinuoTerminal 工作区必须干净且 HEAD 等于记录的 SHA,否则中止打包 —— 防止把
// 未提交 / 未审查 / 与 CI 不一致的 sibling 代码打进安装包。
// 但真正打进安装包的是 pnpm install 时复制进 node_modules/.pnpm 的 file: 依赖副本(硬链接,
// git checkout 重建文件会断开硬链接,副本不随 sibling 变化),所以还须逐文件比对副本内容:
// 每个副本文件(嵌套 node_modules 除外)都必须是 sibling 在固定 SHA 下跟踪的文件且字节相同。
// 只查「副本 ⊆ 固定 SHA」:pnpm 按 package.json files 过滤,副本本就不含全部跟踪文件。
// 用法:node scripts/check-sibling-ref.mjs [--ref-file <path>] [--sibling <dir>] [--root <app 根>]
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const opts = {
    refFile: path.join(repoRoot, '.continuo-terminal-ref'),
    sibling: path.resolve(repoRoot, '..', 'ContinuoTerminal'),
    root: repoRoot,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1];
    if (argv[i] === '--ref-file' && value !== undefined) opts.refFile = path.resolve(value);
    else if (argv[i] === '--sibling' && value !== undefined) opts.sibling = path.resolve(value);
    else if (argv[i] === '--root' && value !== undefined) opts.root = path.resolve(value);
    else throw new Error(`未知参数: ${argv[i]}`);
    i += 1;
  }
  return opts;
}

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// 递归列出副本目录下的文件(相对路径,/ 分隔);跳过 pnpm 放置依赖链接的嵌套 node_modules。
function listInstalled(dir, rel, out) {
  for (const name of readdirSync(dir).sort()) {
    if (name === 'node_modules') continue;
    const full = path.join(dir, name);
    const relName = rel ? `${rel}/${name}` : name;
    const st = lstatSync(full);
    if (st.isDirectory()) listInstalled(full, relName, out);
    else out.push({ rel: relName, full, isFile: st.isFile() });
  }
  return out;
}

// node_modules 里每个指向 sibling 的 file: 依赖副本,须与 sibling(已确认干净且 HEAD=固定 SHA)
// 的跟踪文件逐字节一致。返回错误信息或 null。
function checkInstalledCopies(root, sibling) {
  const reinstall = 'node_modules 中的 sibling 依赖副本与固定 SHA 不一致,在本仓库根执行 pnpm install 后再打包';
  let deps;
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
  } catch {
    return `读不到 ${path.join(root, 'package.json')}`;
  }
  const siblingReal = realpathSync(sibling);
  const tracked = new Set(git(sibling, ['ls-files', '-z']).split('\0').filter(Boolean));
  let count = 0;
  for (const [name, spec] of Object.entries(deps)) {
    if (typeof spec !== 'string' || !spec.startsWith('file:')) continue;
    const srcAbs = path.resolve(root, spec.slice('file:'.length));
    let srcReal;
    try {
      srcReal = realpathSync(srcAbs);
    } catch {
      return `${name} 的来源 ${srcAbs} 不存在`;
    }
    const subdir = path.relative(siblingReal, srcReal);
    if (subdir.startsWith('..') || path.isAbsolute(subdir)) continue;
    count += 1;
    const prefix = subdir ? `${subdir.split(path.sep).join('/')}/` : '';
    let copyDir;
    try {
      copyDir = realpathSync(path.join(root, 'node_modules', name));
    } catch {
      return `未安装 ${name}(${reinstall})`;
    }
    for (const f of listInstalled(copyDir, '', [])) {
      const trackedPath = `${prefix}${f.rel}`;
      if (!f.isFile) return `${name}/${f.rel} 不是普通文件(${reinstall})`;
      if (!tracked.has(trackedPath)) {
        return `${name}/${f.rel} 不是固定 SHA 下跟踪的文件(${reinstall})`;
      }
      let expectedBytes;
      try {
        expectedBytes = readFileSync(path.join(sibling, trackedPath));
      } catch {
        return `${name}/${f.rel} 在 sibling 中读不到(${reinstall})`;
      }
      if (!readFileSync(f.full).equals(expectedBytes)) {
        return `${name}/${f.rel} 内容与固定 SHA 不同(${reinstall})`;
      }
    }
  }
  if (count === 0) return `${path.join(root, 'package.json')} 里没有指向 ${sibling} 的 file: 依赖`;
  return null;
}

export function checkSiblingRef({ refFile, sibling, root = repoRoot }) {
  let expected;
  try {
    expected = readFileSync(refFile, 'utf8').trim();
  } catch {
    return `读不到 ${refFile}`;
  }
  if (!/^[0-9a-f]{40}$/.test(expected)) return `${refFile} 内容不是 40 位小写 commit SHA`;

  let head;
  let status;
  try {
    // sibling 须是独立仓库的根:普通目录若位于别的仓库之内,git -C 会解析到外层仓库的 HEAD。
    const top = git(sibling, ['rev-parse', '--show-toplevel']).trim();
    if (realpathSync(top) !== realpathSync(sibling)) {
      return `${sibling} 不是 git 仓库根目录(解析到外层仓库 ${top})`;
    }
    head = git(sibling, ['rev-parse', 'HEAD']).trim();
    status = git(sibling, ['status', '--porcelain']);
  } catch {
    return `${sibling} 不是可用的 ContinuoTerminal git 工作区`;
  }
  if (status.trim() !== '') {
    return `${sibling} 工作区不干净(有未提交或未跟踪的改动),提交或清理后再打包`;
  }
  if (head !== expected) {
    return (
      `${sibling} HEAD=${head} 与 .continuo-terminal-ref 记录的 ${expected} 不一致。` +
      `打包已有版本:git -C ${sibling} checkout ${expected};` +
      `有意升级:确认新 commit 已推送到远端后更新 .continuo-terminal-ref(CI 按它检出)`
    );
  }
  // sibling 已确认干净且 HEAD=固定 SHA,其工作区文件即固定 SHA 的内容(含换行等 checkout 过滤)。
  try {
    return checkInstalledCopies(root, sibling);
  } catch (err) {
    return `核对 node_modules 中的 sibling 依赖副本失败: ${err.message}`;
  }
}

function main() {
  let error;
  try {
    error = checkSiblingRef(parseArgs(process.argv.slice(2)));
  } catch (err) {
    error = err.message;
  }
  if (error) {
    console.error(`[check-sibling-ref] FAIL: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log('[check-sibling-ref] OK: ContinuoTerminal 与 node_modules 中的依赖副本均与 .continuo-terminal-ref 一致');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
