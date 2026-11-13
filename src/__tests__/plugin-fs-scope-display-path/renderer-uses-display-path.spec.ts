// @vitest-environment jsdom
// BDD:renderer 弹窗 scope 列表用 main 给的 displayPath,自己不读 process/env。见同目录 README。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FS_PATH_MAX } from '../../../electron/shared/fs-limits';

const h = vi.hoisted(() => ({
  onScopeRequest: vi.fn(),
  scopeDecision: vi.fn(),
  requestFsScope: vi.fn(),
  notifyError: vi.fn(),
}));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    pluginFsRaw: {
      onScopeRequest: h.onScopeRequest,
      _scopeDecision: h.scopeDecision,
    },
  },
}));
vi.mock('@/notifications/notify', () => ({ notify: { error: h.notifyError } }));
vi.mock('../../plugins/permissions/promptStore', () => ({
  usePermissionPromptStore: {
    getState: () => ({ requestFsScope: h.requestFsScope }),
  },
}));

import {
  buildFsScopePromptScopes,
  startPluginFsScopeRequestBridge,
} from '../../plugins/permissions/usePluginFsScopeRequests';

beforeEach(() => {
  Object.values(h).forEach((m) => m.mockReset());
  h.onScopeRequest.mockReturnValue(() => {});
  h.requestFsScope.mockReturnValue(new Promise(() => {}));
});

function deliver(payload: unknown): void {
  startPluginFsScopeRequestBridge();
  const handler = h.onScopeRequest.mock.calls[0]![0] as (p: unknown) => void;
  handler(payload);
}

describe('fs scope 弹窗显示路径', () => {
  it('带 displayPath → 显示它;path/mode 不变', () => {
    expect(
      buildFsScopePromptScopes([
        { path: '~/skills', mode: 'r', displayPath: '/Users/someone/skills' },
      ]),
    ).toEqual([
      { path: '~/skills', mode: 'r', displayPath: '/Users/someone/skills' },
    ]);
  });

  it('不带 displayPath(旧形态)→ 回退显示原始 path', () => {
    expect(buildFsScopePromptScopes([{ path: '~/skills', mode: 'rw' }])).toEqual([
      { path: '~/skills', mode: 'rw', displayPath: '~/skills' },
    ]);
  });

  it('bridge 把 payload 的 displayPath 传进弹窗队列', () => {
    deliver({
      requestId: 'r1',
      pluginId: 'p1',
      scopes: [{ path: '~/x', mode: 'r', displayPath: '/home/u/x' }],
    });
    expect(h.requestFsScope).toHaveBeenCalledWith({
      requestId: 'r1',
      pluginId: 'p1',
      scopes: [{ path: '~/x', mode: 'r', displayPath: '/home/u/x' }],
    });
  });

  it.each([
    ['非字符串', 123],
    ['空串', ''],
    ['超长', 'x'.repeat(FS_PATH_MAX + 1)],
  ])('displayPath %s → 整个 payload drop,不进弹窗队列', (_label, displayPath) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      deliver({
        requestId: 'r1',
        pluginId: 'p1',
        scopes: [{ path: '/a', mode: 'r', displayPath }],
      });
      expect(h.requestFsScope).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('renderer 不读 process / 环境变量(sandbox 里没有)', () => {
    const src = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../plugins/permissions/usePluginFsScopeRequests.ts',
      ),
      'utf-8',
    );
    expect(src).not.toMatch(/\bprocess\b/);
  });
});
