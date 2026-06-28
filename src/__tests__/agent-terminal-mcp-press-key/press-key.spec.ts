// BDD: agent-terminal-mcp-press-key

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MCP_TOOL_PRESS_KEY,
  pressKeyInputSchema,
  pressKeyOutputSchema,
  KEY_BYTES,
} from '../../../electron/shared/mcp-terminal-schemas';
import { makePressKeyTool } from '../../../electron/main/services/mcp-tools-terminal';

describe('MCP_TOOL_PRESS_KEY', () => {
  it('字符串契约', () => {
    expect(MCP_TOOL_PRESS_KEY).toBe('terminal.press_key');
  });
});

// ────────────────────────────────────────────────────────────
// KEY_BYTES 映射(服务端真相,spec 断言)
// ────────────────────────────────────────────────────────────

describe('KEY_BYTES', () => {
  it.each<[string, string]>([
    ['enter', '\r'],
    ['tab', '\t'],
    ['escape', '\x1b'],
    ['backspace', '\x7f'],
    ['ctrl_c', '\x03'],
    ['ctrl_d', '\x04'],
    ['ctrl_z', '\x1a'],
    ['up', '\x1b[A'],
    ['down', '\x1b[B'],
    ['right', '\x1b[C'],
    ['left', '\x1b[D'],
  ])('%s → %s', (key, expected) => {
    expect(KEY_BYTES[key as keyof typeof KEY_BYTES]).toBe(expected);
  });

  it('包含全部 11 个键,无多余', () => {
    const keys = Object.keys(KEY_BYTES).sort();
    expect(keys).toEqual(
      [
        'backspace',
        'ctrl_c',
        'ctrl_d',
        'ctrl_z',
        'down',
        'enter',
        'escape',
        'left',
        'right',
        'tab',
        'up',
      ],
    );
  });
});

// ────────────────────────────────────────────────────────────
// Schema
// ────────────────────────────────────────────────────────────

describe('pressKeyInputSchema', () => {
  it.each(Object.keys(KEY_BYTES))('key=%s → ok', (k) => {
    expect(
      pressKeyInputSchema.safeParse({ session_id: 'a', key: k }).success,
    ).toBe(true);
  });

  it.each(['space', 'a', 'Enter', 'ENTER', '', 'shift_enter'])(
    'key=%s 不在白名单 → fail',
    (k) => {
      expect(
        pressKeyInputSchema.safeParse({ session_id: 'a', key: k }).success,
      ).toBe(false);
    },
  );

  it('缺 session_id → fail', () => {
    expect(
      pressKeyInputSchema.safeParse({ key: 'enter' }).success,
    ).toBe(false);
  });

  it('缺 key → fail', () => {
    expect(
      pressKeyInputSchema.safeParse({ session_id: 'a' }).success,
    ).toBe(false);
  });

  it('未知字段 → fail(strict)', () => {
    expect(
      pressKeyInputSchema.safeParse({
        session_id: 'a',
        key: 'enter',
        extra: 1,
      }).success,
    ).toBe(false);
  });
});

describe('pressKeyOutputSchema', () => {
  it('空对象 → ok', () => {
    expect(pressKeyOutputSchema.safeParse({}).success).toBe(true);
  });

  it('额外字段 → fail', () => {
    expect(pressKeyOutputSchema.safeParse({ ok: true }).success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// makePressKeyTool · 行为
// ────────────────────────────────────────────────────────────

type HasFn = (id: string) => boolean;
type WriteFn = (id: string, data: string) => boolean;
type GetSessionOwnerFn = (id: string) => number | null;
const ctx = { ownerWindowId: 1 };

const makeDeps = (overrides?: {
  has?: HasFn;
  write?: WriteFn;
  getSessionOwner?: GetSessionOwnerFn;
}) => ({
  has: overrides?.has ?? vi.fn<HasFn>(() => true),
  write: overrides?.write ?? vi.fn<WriteFn>(() => true),
  getSessionOwner:
    overrides?.getSessionOwner ?? vi.fn<GetSessionOwnerFn>(() => 1),
});

describe('makePressKeyTool · 元数据', () => {
  it('name 与契约常量一致', () => {
    const tool = makePressKeyTool(makeDeps());
    expect(tool.name).toBe(MCP_TOOL_PRESS_KEY);
  });

  it('构建 jsonSchema enum 复用预计算 key 列表,不在工厂调用时 Object.keys', () => {
    const keysSpy = vi.spyOn(Object, 'keys');

    try {
      const tool = makePressKeyTool(makeDeps());

      expect(tool.jsonSchema.properties.key.enum).toContain('enter');
      expect(keysSpy).not.toHaveBeenCalled();
    } finally {
      keysSpy.mockRestore();
    }
  });

  it('预计算 key enum 不在模块加载时调用 Object.keys(KEY_BYTES)', () => {
    const src = readFileSync(
      join(process.cwd(), 'electron/main/services/mcp-tools-terminal.ts'),
      'utf8',
    );

    expect(src).not.toContain('Object.keys(KEY_BYTES)');
    expect(src).toContain('PRESS_KEY_ENUM');
  });

  // 边界(E203):inputSchema 是 session_id 加 .max(SESSION_ID_MAX) 的 bounded schema(协议原 schema 无上限)。
  it('E203 inputSchema 对 session_id 加长度上限(超 256 → 拒)', () => {
    const tool = makePressKeyTool(makeDeps());
    const longId = 'term-' + 'x'.repeat(300);
    expect(
      tool.inputSchema.safeParse({ session_id: longId, key: 'enter' }).success,
    ).toBe(false);
    expect(
      tool.inputSchema.safeParse({ session_id: 'term-1', key: 'enter' }).success,
    ).toBe(true);
    expect(
      pressKeyInputSchema.safeParse({ session_id: longId, key: 'enter' }).success,
    ).toBe(true);
    // 边界(E204):公开 jsonSchema 同步声明 maxLength:256(advertised↔运行时一致)。
    expect(JSON.stringify(tool.jsonSchema)).toContain('"maxLength":256');
  });
});

describe('makePressKeyTool · run', () => {
  it('has=false → 抛 TERMINAL_SESSION_NOT_FOUND', async () => {
    const has = vi.fn<HasFn>(() => false);
    const write = vi.fn<WriteFn>(() => true);
    const tool = makePressKeyTool(makeDeps({ has, write }));
    await expect(
      tool.run({ session_id: 'nope', key: 'enter' }, ctx),
    ).rejects.toMatchObject({ code: 'TERMINAL_SESSION_NOT_FOUND' });
    expect(write).not.toHaveBeenCalled();
  });

  it("key='enter' → write \\r", async () => {
    const write = vi.fn<WriteFn>(() => true);
    const tool = makePressKeyTool(makeDeps({ write }));
    await tool.run({ session_id: 't', key: 'enter' }, ctx);
    expect(write).toHaveBeenCalledWith('t', '\r');
  });

  it("key='ctrl_c' → write \\x03", async () => {
    const write = vi.fn<WriteFn>(() => true);
    const tool = makePressKeyTool(makeDeps({ write }));
    await tool.run({ session_id: 't', key: 'ctrl_c' }, ctx);
    expect(write).toHaveBeenCalledWith('t', '\x03');
  });

  it("key='up' → write \\x1b[A", async () => {
    const write = vi.fn<WriteFn>(() => true);
    const tool = makePressKeyTool(makeDeps({ write }));
    await tool.run({ session_id: 't', key: 'up' }, ctx);
    expect(write).toHaveBeenCalledWith('t', '\x1b[A');
  });

  it('每个 key 写对应 KEY_BYTES 字节', async () => {
    for (const [key, bytes] of Object.entries(KEY_BYTES)) {
      const write = vi.fn<WriteFn>(() => true);
      const tool = makePressKeyTool(makeDeps({ write }));
      await tool.run({
        session_id: 't',
        key: key as keyof typeof KEY_BYTES,
      }, ctx);
      expect(write).toHaveBeenCalledWith('t', bytes);
    }
  });

  it('write 返回 false → 抛 TERMINAL_SESSION_NOT_FOUND', async () => {
    const write = vi.fn<WriteFn>(() => false);
    const tool = makePressKeyTool(makeDeps({ write }));
    await expect(
      tool.run({ session_id: 't', key: 'enter' }, ctx),
    ).rejects.toMatchObject({ code: 'TERMINAL_SESSION_NOT_FOUND' });
  });

  it('成功 → 返回 {}', async () => {
    const tool = makePressKeyTool(makeDeps());
    const r = await tool.run({ session_id: 't', key: 'enter' }, ctx);
    expect(r).toEqual({});
  });

  it('输出符合 pressKeyOutputSchema', async () => {
    const tool = makePressKeyTool(makeDeps());
    const out = await tool.run({ session_id: 't', key: 'tab' }, ctx);
    expect(pressKeyOutputSchema.safeParse(out).success).toBe(true);
  });
});
