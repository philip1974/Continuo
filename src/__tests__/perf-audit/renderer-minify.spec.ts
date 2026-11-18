// 打包出去的 renderer 代码必须压缩:electron-vite 2.x 对 renderer 默认 minify:false,首屏必载的
// main-app chunk 未压缩约 2.49MB,压缩后约 1.27MB(-49%),每次冷启动都要完整读取 + 编译。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('renderer 构建压缩', () => {
  it('electron.vite.config 的 renderer build 显式开启 esbuild minify', () => {
    const src = readFileSync(path.resolve(__dirname, '../../../electron.vite.config.ts'), 'utf8');
    const renderer = src.slice(src.indexOf('renderer:'));
    expect(renderer).toMatch(/minify:\s*'esbuild'/);
  });
});
