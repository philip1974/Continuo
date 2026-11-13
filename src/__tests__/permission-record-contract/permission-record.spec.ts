// 权限记录单条形态:main 读盘 / 写盘、renderer 读端、IPC schema 四处同一规则(此前三处漂移)。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {}, BrowserWindow: {}, ipcMain: {} }));

import {
  isIpcPathScope,
  isIpcPermissionDecision,
} from '../../../electron/shared/permission-record';
import { PERMISSION_RECORD_LIMITS, PLUGIN_ID_MAX_LEN } from '../../../electron/shared/permission-record-limits';
import { isSafePluginId } from '../../../electron/main/services/plugins.service';

describe('isIpcPermissionDecision', () => {
  const ok = { permission: 'fs', granted: true, decidedAt: 1 };

  it('合法项', () => {
    expect(isIpcPermissionDecision(ok)).toBe(true);
    expect(isIpcPermissionDecision({ ...ok, decidedAt: 0, granted: false })).toBe(true);
  });

  it.each([
    ['未知权限名(此前 renderer / IPC 放行)', { ...ok, permission: 'fs.read' }],
    ['负时间戳(此前 main 读盘放行)', { ...ok, decidedAt: -1 }],
    ['非有限时间戳', { ...ok, decidedAt: Number.POSITIVE_INFINITY }],
    ['NaN 时间戳', { ...ok, decidedAt: Number.NaN }],
    ['granted 非 boolean', { ...ok, granted: 'yes' }],
    ['数组', [ok]],
    ['null', null],
  ])('拒:%s', (_label, value) => {
    expect(isIpcPermissionDecision(value)).toBe(false);
  });
});

describe('isIpcPathScope', () => {
  it('合法项', () => {
    expect(isIpcPathScope({ path: '/a', mode: 'r' })).toBe(true);
    expect(isIpcPathScope({ path: '~', mode: 'rw' })).toBe(true);
    expect(
      isIpcPathScope({ path: 'x'.repeat(PERMISSION_RECORD_LIMITS.SCOPE_PATH_MAX), mode: 'r' }),
    ).toBe(true);
  });

  it.each([
    ['空 path(此前读盘 / renderer / IPC 放行)', { path: '', mode: 'r' }],
    ['超长 path', { path: 'x'.repeat(PERMISSION_RECORD_LIMITS.SCOPE_PATH_MAX + 1), mode: 'r' }],
    ['非法 mode', { path: '/a', mode: 'w' }],
    ['path 非 string', { path: 42, mode: 'r' }],
  ])('拒:%s', (_label, value) => {
    expect(isIpcPathScope(value)).toBe(false);
  });
});

describe('写端 plugin id 与读端同一长度上限', () => {
  it('isSafePluginId 拒超长 id(字符集合法也拒)', () => {
    expect(isSafePluginId('a'.repeat(PLUGIN_ID_MAX_LEN))).toBe(true);
    expect(isSafePluginId('a'.repeat(PLUGIN_ID_MAX_LEN + 1))).toBe(false);
  });
});

describe('接线守卫', () => {
  const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf-8');

  it('main 与 renderer 都委托 shared 谓词,不再本地手写字段检查', () => {
    const main = read('electron/main/services/plugins.service.ts');
    expect(main).toMatch(/from '\.\.\/\.\.\/shared\/permission-record'/);
    expect(main).not.toMatch(/function isIpcPathScope\(/);
    const renderer = read('src/plugins/permissions/IpcPermissionStore.ts');
    expect(renderer).toContain('isIpcPermissionDecision(value)');
    expect(renderer).toContain('isIpcPathScope(value)');
  });

  it('IPC schema 用同一枚举与非空下限', () => {
    const ipc = read('electron/main/ipc/plugins.ipc.ts');
    expect(ipc).toContain('permission: z.enum(PERMISSION_KEYS)');
    expect(ipc).toContain('path: z.string().min(1).max(PATH_MAX)');
  });
});
