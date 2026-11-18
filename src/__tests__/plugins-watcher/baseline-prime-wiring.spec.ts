// 冷启动:watcher 基线在首窗创建后、安装恢复完成后提前建立(不与建窗前 IO 争线程池),
// renderer 首次 LIST_DIRS 时通常已建好 / 在途,ensureBaseline 直接返回或接上在途扫描,
// 不再在插件 init 关键路径上当场串行扫描一遍。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../../..');
const read = (p: string): string => readFileSync(path.join(root, p), 'utf8');

describe('watcher 基线预热接线', () => {
  it('plugins.ipc 导出预热入口:等安装恢复完成后 ensureBaseline', () => {
    const src = read('electron/main/ipc/plugins.ipc.ts');
    expect(src).toMatch(/export function primePluginsWatcherBaseline\(/);
    expect(src).toMatch(/installRecovery[\s\S]{0,80}\.then\(\(\)\s*=>\s*watcher\.ensureBaseline\(\)\)/);
  });

  it('index.ts 在首窗创建之后调用预热(在 stdio 延后启动之后)', () => {
    const src = read('electron/main/index.ts');
    const stdio = src.indexOf('mcpStdioStarting = startMcpStdioServer();');
    const prime = src.indexOf('primePluginsWatcherBaseline();');
    expect(stdio).toBeGreaterThan(0);
    expect(prime).toBeGreaterThan(stdio);
  });
});
