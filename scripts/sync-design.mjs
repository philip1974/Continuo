#!/usr/bin/env node
// LM ↔ Nous shell-ui 设计层同步脚本。
//
// 模式:
//   - sync (默认):整文件覆盖,Nous 是真源
//   - fork:LM 有本地微调,只比对、不覆盖,upstream 变化时告警
//
// 用法:
//   pnpm sync:design            正常同步
//   pnpm sync:design --check    只检查不写盘(CI 用)
//   NOUS_REPO=/custom/path pnpm sync:design
//
// 退出码:0 干净;1 有漂移待审查;2 源缺失等错误

import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LM_ROOT = resolve(SCRIPT_DIR, '..');
const NOUS_ROOT = process.env.NOUS_REPO ?? resolve(LM_ROOT, '../Nous');
const NOUS_UI_SRC = join(NOUS_ROOT, 'packages/shells/shell-ui/src');

const CHECK_ONLY = process.argv.includes('--check');

// ── 同步配置 ────────────────────────────────────────────────
//
// sync 项:从 Nous 整文件覆盖到 LM
// fork 项:LM 有本地微调,upstream 改动只告警,需手工 merge

/** @type {{src: string, dest: string, mode: 'sync' | 'fork', reason?: string}[]} */
const FILES = [
  // ── 共享 token(单一真源) ────────────────────────────
  { src: 'styles/tokens.css', dest: 'styles/nous-tokens.css', mode: 'sync' },

  // ── design 组件:.tsx / .css 配对 ──────────────────────
  { src: 'design/Badge.tsx', dest: 'design/Badge.tsx', mode: 'sync' },
  { src: 'design/Badge.css', dest: 'design/Badge.css', mode: 'sync' },

  { src: 'design/Button.tsx', dest: 'design/Button.tsx', mode: 'sync' },
  {
    src: 'design/Button.css',
    dest: 'design/Button.css',
    mode: 'fork',
    reason: 'LM border-radius 4px (Nous 8px) + font-weight normal (Nous medium)',
  },

  { src: 'design/Card.tsx', dest: 'design/Card.tsx', mode: 'sync' },
  { src: 'design/Card.css', dest: 'design/Card.css', mode: 'sync' },

  { src: 'design/IconButton.tsx', dest: 'design/IconButton.tsx', mode: 'sync' },
  { src: 'design/IconButton.css', dest: 'design/IconButton.css', mode: 'sync' },

  {
    src: 'design/Input.tsx',
    dest: 'design/Input.tsx',
    mode: 'fork',
    reason: 'LM 加 forwardRef (CreateInput / FileRow rename 需要 .focus())',
  },
  { src: 'design/Input.css', dest: 'design/Input.css', mode: 'sync' },

  { src: 'design/MenuItem.tsx', dest: 'design/MenuItem.tsx', mode: 'sync' },
  { src: 'design/MenuItem.css', dest: 'design/MenuItem.css', mode: 'sync' },

  { src: 'design/Modal.tsx', dest: 'design/Modal.tsx', mode: 'sync' },
  { src: 'design/Modal.css', dest: 'design/Modal.css', mode: 'sync' },

  {
    src: 'design/NavRailButton.tsx',
    dest: 'design/NavRailButton.tsx',
    mode: 'sync',
  },
  {
    src: 'design/NavRailButton.css',
    dest: 'design/NavRailButton.css',
    mode: 'sync',
  },

  { src: 'design/ScrollArea.tsx', dest: 'design/ScrollArea.tsx', mode: 'sync' },
  { src: 'design/ScrollArea.css', dest: 'design/ScrollArea.css', mode: 'sync' },

  {
    src: 'design/SegmentedControl.tsx',
    dest: 'design/SegmentedControl.tsx',
    mode: 'sync',
  },
  {
    src: 'design/SegmentedControl.css',
    dest: 'design/SegmentedControl.css',
    mode: 'sync',
  },

  { src: 'design/Separator.tsx', dest: 'design/Separator.tsx', mode: 'sync' },
  { src: 'design/Separator.css', dest: 'design/Separator.css', mode: 'sync' },

  { src: 'design/Spinner.tsx', dest: 'design/Spinner.tsx', mode: 'sync' },
  { src: 'design/Spinner.css', dest: 'design/Spinner.css', mode: 'sync' },

  { src: 'design/TabNav.tsx', dest: 'design/TabNav.tsx', mode: 'sync' },
  { src: 'design/TabNav.css', dest: 'design/TabNav.css', mode: 'sync' },

  { src: 'design/Tabs.tsx', dest: 'design/Tabs.tsx', mode: 'sync' },
  { src: 'design/Tabs.css', dest: 'design/Tabs.css', mode: 'sync' },

  { src: 'design/Textarea.tsx', dest: 'design/Textarea.tsx', mode: 'sync' },
  { src: 'design/Textarea.css', dest: 'design/Textarea.css', mode: 'sync' },
];

// ── 执行 ────────────────────────────────────────────────

if (!existsSync(NOUS_UI_SRC)) {
  console.error(`✘ Nous 仓库未找到:${NOUS_UI_SRC}`);
  console.error('  设置 NOUS_REPO 环境变量或确保 ../Nous 存在');
  process.exit(2);
}

let synced = 0;
let drifted = 0;
let unchanged = 0;
const drifts = [];

for (const entry of FILES) {
  const srcPath = join(NOUS_UI_SRC, entry.src);
  const destPath = join(LM_ROOT, 'src', entry.dest);

  if (!existsSync(srcPath)) {
    console.error(`✘ 源缺失:${entry.src}`);
    process.exit(2);
  }

  const srcContent = readFileSync(srcPath, 'utf-8');
  const destContent = existsSync(destPath)
    ? readFileSync(destPath, 'utf-8')
    : null;

  const same = srcContent === destContent;

  if (entry.mode === 'sync') {
    if (same) {
      unchanged++;
    } else {
      if (!CHECK_ONLY) writeFileSync(destPath, srcContent);
      console.log(
        `${CHECK_ONLY ? '⚠ would sync' : '✔ synced'}: ${entry.dest}`,
      );
      synced++;
    }
  } else if (entry.mode === 'fork') {
    if (same) {
      unchanged++;
    } else {
      console.log(`⚠ fork drift: ${entry.dest}`);
      console.log(`  reason: ${entry.reason ?? '(no reason)'}`);
      drifted++;
      drifts.push(entry);
    }
  }
}

// ── Nous 新增组件检测 ──────────────────────────────────
const nousDesignDir = join(NOUS_UI_SRC, 'design');
const nousFiles = readdirSync(nousDesignDir).filter(
  (f) =>
    (f.endsWith('.tsx') || f.endsWith('.css')) && !f.endsWith('.stories.tsx'),
);
const declaredSrc = new Set(
  FILES.filter((e) => e.src.startsWith('design/')).map((e) =>
    e.src.replace('design/', ''),
  ),
);
const newFiles = nousFiles.filter((f) => !declaredSrc.has(f));

if (newFiles.length > 0) {
  console.log('\n📦 Nous 新增组件(未在本脚本 FILES 列表):');
  for (const f of newFiles) console.log(`  - design/${f}`);
  console.log('  → 评估后加入 FILES 数组,或确认 LM 不需要');
}

// ── 总结 ────────────────────────────────────────────────
console.log(
  `\nSummary: ${synced} ${CHECK_ONLY ? 'would sync' : 'synced'}, ${drifted} fork drift, ${unchanged} unchanged${newFiles.length > 0 ? `, ${newFiles.length} new in Nous` : ''}`,
);

if (drifted > 0) {
  console.log('\n⚠ Fork 漂移列表:');
  for (const d of drifts) console.log(`  - ${d.dest}: ${d.reason}`);
  console.log('  → 手工 merge:对比 Nous 与 LM,合并 upstream 变化,保留 LM 微调');
}

// 退出码:CHECK_ONLY 模式下任何变化都算 fail
if (CHECK_ONLY && (synced > 0 || drifted > 0)) process.exit(1);
if (drifted > 0) process.exit(1);
