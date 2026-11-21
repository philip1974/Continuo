#!/usr/bin/env node
// topic 45 ADR-Plugin-5 Phase 0: post-build chunk-graph gate.
// 验 spike 路径不引主 app chunk (main-app).
// Gate 1: HTML grep <link rel="modulepreload" href="...main-app...">
// Gate 2: entry JS dynamic imports include spike + main-app as separate chunks.
// Gate 3: spike chunk does not reference main-app; main-app chunk does not reference plugin-isolation.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOTS = ['out/renderer', 'out-pack/renderer'].filter(existsSync);
if (ROOTS.length === 0) {
  console.error('[chunk-graph-gate] no out/renderer or out-pack/renderer found. run pnpm build first.');
  process.exit(2);
}

let allOk = true;

for (const root of ROOTS) {
  console.log(`[chunk-graph-gate] checking ${root}`);
  const html = readFileSync(join(root, 'index.html'), 'utf8');

  // Gate 1: HTML modulepreload 不应引 main-app
  const gate1 = /<link\s+rel=["']modulepreload["'][^>]*href=["'][^"']*main-app[^"']*["']/i.test(html);
  if (gate1) {
    console.error(`  [Gate 1 FAIL] ${root}/index.html contains modulepreload of main-app chunk`);
    allOk = false;
  } else {
    console.log(`  [Gate 1 OK] no modulepreload of main-app`);
  }

  // Gate 2: 从 HTML 抽 entry script,读 entry JS,grep dynamic import deps
  const entryMatch = html.match(/<script\s+type=["']module["']\s+(?:crossorigin\s+)?src=["']([^"']+)["']/);
  if (!entryMatch) {
    console.error(`  [Gate 2 FAIL] no entry script in ${root}/index.html`);
    allOk = false;
    continue;
  }
  const entrySrc = entryMatch[1].startsWith('./') ? entryMatch[1].slice(2) : entryMatch[1];
  const entryPath = join(root, entrySrc);
  if (!existsSync(entryPath)) {
    console.error(`  [Gate 2 FAIL] entry JS ${entryPath} not found`);
    allOk = false;
    continue;
  }
  const entryJs = readFileSync(entryPath, 'utf8');

  // grep 所有 dynamic import;兼容 plain import("./x.js") 和 __vitePreload(() => import("./x.js"), ...)
  const dynamicImports = [...entryJs.matchAll(/(?:__vitePreload\([^)]*?)?import\(["']([^"']+)["']\)/g)];
  const spikeBranch = dynamicImports.filter(m => /spikes?[/-]plugin-isolation|^\.?\/?index-[A-Za-z0-9_-]+\.js$|^\.\/?spikes/.test(m[1]));
  const mainAppRefs = dynamicImports.filter(m => /main-app/.test(m[1]));

  console.log(`  found ${dynamicImports.length} dynamic imports; spike-branch: ${spikeBranch.length}, main-app-branch: ${mainAppRefs.length}`);

  // spike route 调用 import('./spikes/plugin-isolation'); main route 调用 import('./main-app').
  // 二者应都存在 (互斥 router 设计)，但 entry chunk 内不应有 spike 分支引用 main-app 作为 dep。
  // 当前简化检查: 仅断言 spike chunk 在 entry 内被识别为单独 chunk (vitePreload deps 数组不嵌套 main-app).
  // 完整 deps 数组解析较复杂，作 v4 现阶段：grep entry 内 main-app chunk 是否出现在 spike branch 的同上下文。
  // 这里只看 main-app 引用计数 == 1 (只在 main route 分支出现)，spike route 出现计数 0 (即 spike 路径与 main-app 物理无 import 关联).

  if (spikeBranch.length !== 1) {
    console.error(`  [Gate 2 FAIL] expected exactly 1 spike dynamic import in entry, found ${spikeBranch.length}`);
    allOk = false;
  }
  if (mainAppRefs.length !== 1) {
    console.error(`  [Gate 2 FAIL] expected exactly 1 main-app dynamic import in entry (main route), found ${mainAppRefs.length}`);
    allOk = false;
  } else {
    console.log(`  [Gate 2 OK] entry chunk has separate spike + main-app dynamic imports`);
  }

  // Gate 3: 反向 import/string check,证明 spike chunk 不物理引用 main-app,主 app chunk 不引用 plugin-isolation.
  if (spikeBranch.length === 1 && mainAppRefs.length === 1) {
    const entryDir = dirname(entrySrc);
    const spikeSrc = normalizeImportSrc(spikeBranch[0][1]);
    const mainAppSrc = normalizeImportSrc(mainAppRefs[0][1]);
    const spikePath = join(root, entryDir, spikeSrc);
    const mainAppPath = join(root, entryDir, mainAppSrc);

    if (!existsSync(spikePath)) {
      console.error(`  [Gate 3 FAIL] spike chunk ${spikePath} not found`);
      allOk = false;
      continue;
    }
    if (!existsSync(mainAppPath)) {
      console.error(`  [Gate 3 FAIL] main-app chunk ${mainAppPath} not found`);
      allOk = false;
      continue;
    }

    const spikeJs = readFileSync(spikePath, 'utf8');
    const mainAppJs = readFileSync(mainAppPath, 'utf8');
    const spikeRefsMainApp = /main-app/.test(spikeJs);
    const mainAppRefsSpike = /plugin-isolation/.test(mainAppJs);

    if (spikeRefsMainApp) {
      console.error(`  [Gate 3 FAIL] spike chunk references main-app`);
      allOk = false;
    }
    if (mainAppRefsSpike) {
      console.error(`  [Gate 3 FAIL] main-app chunk references plugin-isolation`);
      allOk = false;
    }
    if (!spikeRefsMainApp && !mainAppRefsSpike) {
      console.log(`  [Gate 3 OK] spike chunk and main-app chunk have no reverse references`);
    }
  }
}

if (!allOk) {
  console.error('[chunk-graph-gate] FAIL');
  process.exit(1);
}
console.log('[chunk-graph-gate] PASS');
process.exit(0);

function normalizeImportSrc(src) {
  return src.startsWith('./') ? src.slice(2) : src;
}
