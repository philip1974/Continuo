// 源码钉(主进程建窗依赖整套启动):带工作区建的窗口建窗即登记 root,不等 renderer 恢复后上报 ——
// 紧接着再打开同一文件夹(连点 / 连续 open-file)也能认出它已打开。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(join(process.cwd(), 'electron/main/index.ts'), 'utf8');

describe('createMainWindow 预登记 workspace root', () => {
  it('opts.workspace 存在时立即 setWorkspaceRoot', () => {
    const at = src.indexOf('export function createMainWindow(');
    expect(at).toBeGreaterThan(0);
    const body = src.slice(at, src.indexOf("win.on('closed'", at));
    expect(body).toContain('if (opts.workspace !== undefined) setWorkspaceRoot(win.id, opts.workspace);');
  });
});
