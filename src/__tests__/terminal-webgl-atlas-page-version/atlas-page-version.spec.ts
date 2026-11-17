import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ATLAS_PAGE_VERSION_COUNTER,
  patchAtlasPageVersion,
} from '../../../scripts/vite-xterm-webgl-atlas-version';

// 规范见 README.md:多终端共享 WebGL atlas,页合并后同下标换了页对象,version 必须不同,
// 否则其它终端跳过纹理上传 → 同时乱码。修复 = renderer 构建时把 AtlasPage.version 改成全局单调。

const ROOT = path.resolve(__dirname, '../../..');
const PKG_DIR = path.join(ROOT, 'node_modules/@xterm/addon-webgl');
const COUNTER = ATLAS_PAGE_VERSION_COUNTER;

describe('terminal-webgl-atlas-page-version', () => {
  describe.each(['lib/addon-webgl.mjs', 'lib/addon-webgl.js'])('已安装的打包产物 %s', (rel) => {
    const original = readFileSync(path.join(PKG_DIR, rel), 'utf-8');

    it('修复前:AtlasPage.version 是 per-page 从 0 计数(上游 bug 仍在,补丁仍有必要)', () => {
      // 布尔断言:失败时不把整个 bundle 打进输出。上游正式版若已改成全局单调,此处失败 → 删补丁。
      expect(/\.version\+\+/.test(original), '已无 per-page version++').toBe(true);
    });

    it('修复后:构造/加字形/清空/合并/删页前移 5 处 version 写入都取自同一个单调计数器', () => {
      const patched = patchAtlasPageVersion(original);
      expect(/\.version\+\+/.test(patched), '仍有 per-page version++').toBe(false);
      expect(/this\.version=0[,;]/.test(patched), '仍有 version 初值 0').toBe(false);
      const writes = patched.match(new RegExp(`\\.version=\\+\\+${COUNTER}\\b`, 'g')) ?? [];
      expect(writes).toHaveLength(5);
      expect(patched.startsWith(`var ${COUNTER}=0;`), `缺少计数器 ${COUNTER}`).toBe(true);
    });

    it('修复后的产物仍是可解析的 JS', () => {
      const patched = patchAtlasPageVersion(original);
      // mjs 含 export 语句,去掉后按 script 解析即可验证语法。
      const asScript = patched.replace(/export\s*\{[^}]*\};?\s*(\/\/#.*)?\s*$/, '');
      expect(() => new Function(asScript)).not.toThrow();
    });
  });

  it('锚点对不上(上游改了实现)时直接报错,不静默放过', () => {
    expect(() => patchAtlasPageVersion('var unrelated=1;')).toThrow(/addon-webgl/);
  });

  it('renderer 构建与 dev 都经过补丁:插件已注册,且 addon-webgl 不走 optimizeDeps 预打包', () => {
    const config = readFileSync(path.join(ROOT, 'electron.vite.config.ts'), 'utf-8');
    const renderer = config.slice(config.indexOf('renderer:'));
    expect(renderer).toMatch(/xtermWebglAtlasVersionPlugin\(\)/);
    expect(renderer).toMatch(/optimizeDeps:\s*\{[^}]*exclude:\s*\[[^\]]*'@xterm\/addon-webgl'/);
  });
});
