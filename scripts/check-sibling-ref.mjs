#!/usr/bin/env node
// 打包前核对 sibling 依赖 ContinuoTerminal 的版本:package.json 用 `file:../ContinuoTerminal/...`,
// 本身不固定版本;仓库根的 .continuo-terminal-ref 记录应当使用的 commit SHA(CI 也按它检出)。
// 本地 ../ContinuoTerminal 工作区必须干净且 HEAD 等于记录的 SHA,否则中止打包 —— 防止把
// 未提交 / 未审查 / 与 CI 不一致的 sibling 代码打进安装包。
// 用法:node scripts/check-sibling-ref.mjs [--ref-file <path>] [--sibling <dir>]
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const opts = {
    refFile: path.join(repoRoot, '.continuo-terminal-ref'),
    sibling: path.resolve(repoRoot, '..', 'ContinuoTerminal'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1];
    if (argv[i] === '--ref-file' && value !== undefined) opts.refFile = path.resolve(value);
    else if (argv[i] === '--sibling' && value !== undefined) opts.sibling = path.resolve(value);
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

export function checkSiblingRef({ refFile, sibling }) {
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
  return null;
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
  // file: 依赖在 pnpm install 时被复制进 node_modules/.pnpm;切换过 sibling 版本须重新 install。
  console.log('[check-sibling-ref] OK: ContinuoTerminal 与 .continuo-terminal-ref 一致(切换过版本请确认已重新 pnpm install)');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
