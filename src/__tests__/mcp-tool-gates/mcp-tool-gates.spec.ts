// 重构守卫:MCP 工具授权(S2)/ capability(S3)门控单一来源的行为契约 + 接线。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  gateWithAuth,
  gateWithCapability,
} from '../../../electron/main/services/mcp-tool-gates';
import type { AnyMcpTool, McpCallCtx } from '../../../electron/main/services/mcp-host.service';
import { ERROR_CODES } from '../../../electron/shared/error-codes';

function makeTool(name = 'demo_tool') {
  const run = vi.fn(async () => ({ ok: true }));
  const tool = { name, description: '', jsonSchema: {}, run } as unknown as AnyMcpTool;
  return { tool, run };
}

const ctx = (ownerWindowId: number, callerSubject: string | null): McpCallCtx =>
  ({ ownerWindowId, callerSubject }) as unknown as McpCallCtx;

const AUTH = {
  methodFor: (tool: AnyMcpTool) => `m:${tool.name}`,
  deniedMessage: 'not authorized (demo)',
};

describe('gateWithAuth(S2)', () => {
  it.each(['once', 'session'] as const)('%s → 放行并透传结果', async (decision) => {
    const { tool, run } = makeTool();
    const ensure = vi.fn(async () => decision);
    const gated = gateWithAuth(tool, ensure, AUTH);
    await expect(gated.run({ a: 1 }, ctx(7, 's'))).resolves.toEqual({ ok: true });
    expect(ensure).toHaveBeenCalledWith(7, 'm:demo_tool');
    expect(run).toHaveBeenCalledWith({ a: 1 }, ctx(7, 's'));
  });

  it('denied → AGENT_NOT_AUTHORIZED,内部工具不执行', async () => {
    const { tool, run } = makeTool();
    const gated = gateWithAuth(tool, async () => 'denied', AUTH);
    await expect(gated.run({}, ctx(1, 's'))).rejects.toMatchObject({
      message: 'not authorized (demo)',
      code: ERROR_CODES.AGENT_NOT_AUTHORIZED,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('保留工具其余字段', () => {
    const { tool } = makeTool('x');
    expect(gateWithAuth(tool, async () => 'once', AUTH).name).toBe('x');
  });
});

describe('gateWithCapability(S3)', () => {
  const owners: Record<string, number> = { mine: 1, other: 2 };
  const controllers: Record<string, string | null> = { mine: 'subj-a', other: 'subj-a' };
  const base = {
    getSessionOwner: (id: string) => owners[id] ?? null,
    getSessionController: (id: string) => controllers[id] ?? null,
    notOwnedMessage: 'not owned (demo)',
  };

  it('本窗口 + controller === subject → 放行', async () => {
    const { tool, run } = makeTool();
    await gateWithCapability(tool, base).run({ session_id: 'mine' }, ctx(1, 'subj-a'));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['subject 不同', 'subj-b', 'subj-a'],
    ['subject 为空', null, 'subj-a'],
    ['controller 为空(user 终端)', 'subj-a', null],
    ['两者都为空', null, null],
  ])('本窗口但 %s → AGENT_NOT_AUTHORIZED', async (_label, subject, controller) => {
    const { tool, run } = makeTool();
    const gated = gateWithCapability(tool, {
      ...base,
      getSessionController: () => controller,
    });
    await expect(gated.run({ session_id: 'mine' }, ctx(1, subject))).rejects.toMatchObject({
      message: 'not owned (demo)',
      code: ERROR_CODES.AGENT_NOT_AUTHORIZED,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([{ session_id: 'unknown' }, {}, null, { session_id: 42 }])(
    '未知 / 缺失 session_id(%j)→ 放行给内部工具',
    async (input) => {
      const { tool, run } = makeTool();
      await gateWithCapability(tool, { ...base, crossWindowError: () => new Error('x') }).run(
        input,
        ctx(1, null),
      );
      expect(run).toHaveBeenCalledTimes(1);
    },
  );

  it('跨窗 session_id:无 crossWindowError(terminal 域)→ 放行给内部工具', async () => {
    const { tool, run } = makeTool();
    await gateWithCapability(tool, base).run({ session_id: 'other' }, ctx(1, 'whoever'));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('跨窗 session_id:有 crossWindowError(debug 域)→ 抛该错误,不执行', async () => {
    const { tool, run } = makeTool();
    const gated = gateWithCapability(tool, {
      ...base,
      crossWindowError: (sid) => new Error(`not found: ${sid}`),
    });
    await expect(gated.run({ session_id: 'other' }, ctx(1, 'subj-a'))).rejects.toThrow(
      'not found: other',
    );
    expect(run).not.toHaveBeenCalled();
  });
});

describe('接线守卫:两个 host 共用门控', () => {
  const dir = join(__dirname, '..', '..', '..', 'electron', 'main', 'services');
  it.each(['mcp-terminal-host.ts', 'mcp-debug-host.ts'])('%s 导入共享门控且无本地副本', (file) => {
    const src = readFileSync(join(dir, file), 'utf-8');
    expect(src).toMatch(/from '\.\/mcp-tool-gates'/);
    expect(src).not.toMatch(/function gateWithAuth\(/);
    expect(src).not.toMatch(/function gateWithCapability\(/);
  });
});
