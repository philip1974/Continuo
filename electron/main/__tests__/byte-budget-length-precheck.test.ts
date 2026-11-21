// perf:isInvokeResultAdmissible / plugin-data SAVE / layout:write 的 stringify 前 fail-fast 预检改用
// .length 下界(jsonStringLengthLowerBoundExceeds,每个字符串 O(1)),不再逐字符 UTF-8 计数 —— 三处其后都有
// JSON.stringify + 精确 UTF-8 字节终裁,.length ≤ UTF-8 字节,故 .length 下界仍是合法下界,接受/拒绝判定不变
//(多字节内容只是从「预检拒」挪到「精确终裁拒」)。
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({ bytes: vi.fn(), length: vi.fn() }));
vi.mock('../../shared/json-byte-budget', async (importActual) => {
  const actual = await importActual<typeof import('../../shared/json-byte-budget')>();
  return {
    jsonByteLowerBoundExceeds: (v: unknown, l: number) => {
      spies.bytes(l);
      return actual.jsonByteLowerBoundExceeds(v, l);
    },
    jsonStringLengthLowerBoundExceeds: (v: unknown, l: number) => {
      spies.length(l);
      return actual.jsonStringLengthLowerBoundExceeds(v, l);
    },
  };
});

import { isInvokeResultAdmissible, RESULT_BYTES_MAX } from '../../shared/plugin-mcp-schemas';
import { registerPluginDataStoreHandlers } from '../services/plugin-data-store.service';

const MAX_PLUGIN_DATA_BYTES = 16 * 1024 * 1024;

afterEach(() => {
  spies.bytes.mockClear();
  spies.length.mockClear();
});

describe('isInvokeResultAdmissible:.length 下界预检 + 精确字节终裁', () => {
  // ["..."] 包装 = 4 字节结构;CJK 每字 3 字节。
  const cjkArrayOfBytes = (bytes: number): string[] => {
    const n = Math.floor((bytes - 4) / 3);
    return ['中'.repeat(n) + 'a'.repeat(bytes - 4 - n * 3)];
  };

  it('预检用 .length 下界(不再逐字符计 UTF-8)', () => {
    expect(isInvokeResultAdmissible({ ok: 1 })).toBe(true);
    expect(spies.length).toHaveBeenCalledWith(RESULT_BYTES_MAX);
    expect(spies.bytes).not.toHaveBeenCalled();
  });

  it('多字节结果:恰好等于上限 → 接受;上限 +1 → 拒(.length 远低于上限,由精确终裁拒)', () => {
    expect(isInvokeResultAdmissible(cjkArrayOfBytes(RESULT_BYTES_MAX))).toBe(true);
    expect(isInvokeResultAdmissible(cjkArrayOfBytes(RESULT_BYTES_MAX + 1))).toBe(false);
  });

  it('ASCII 超限 → 拒;含非 JSON 安全值 → 拒;undefined → 接受', () => {
    expect(isInvokeResultAdmissible(['x'.repeat(RESULT_BYTES_MAX)])).toBe(false);
    expect(isInvokeResultAdmissible({ a: NaN })).toBe(false);
    expect(isInvokeResultAdmissible(undefined)).toBe(true);
  });
});

describe('plugin-data SAVE:.length 下界预检 + 精确字节终裁', () => {
  type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });
  async function save(data: unknown): Promise<unknown> {
    const root = await mkdtemp(path.join(tmpdir(), 'continuo-pd-len-'));
    roots.push(root);
    mkdirSync(path.join(root, 'plugins', 'p.len'), { recursive: true }); // save 只写已安装插件的目录
    const handlers = new Map<string, Handler>();
    registerPluginDataStoreHandlers(
      { handle: (c: string, h: Handler) => handlers.set(c, h) } as never,
      { userDataPath: root },
    );
    return handlers.get('plugin-data:save')!({}, 'p.len', data);
  }
  // {"v":"..."} = 8 字节结构。
  const cjkPayloadOfBytes = (bytes: number): { v: string } => {
    const n = Math.floor((bytes - 8) / 3);
    return { v: '中'.repeat(n) + 'a'.repeat(bytes - 8 - n * 3) };
  };

  it('预检用 .length 下界', async () => {
    await save({ a: 1 });
    expect(spies.length).toHaveBeenCalledWith(MAX_PLUGIN_DATA_BYTES);
    expect(spies.bytes).not.toHaveBeenCalled();
  });

  it('多字节:恰好等于上限 → 写入;上限 +1 → PAYLOAD_TOO_LARGE', async () => {
    await expect(save(cjkPayloadOfBytes(MAX_PLUGIN_DATA_BYTES))).resolves.toBeUndefined();
    await expect(save(cjkPayloadOfBytes(MAX_PLUGIN_DATA_BYTES + 1))).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
    });
  });

  it('非 JSON 安全(上限内)→ BAD_INPUT', async () => {
    await expect(save({ a: Infinity })).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });
});

describe('layout:write 预检(ipc.ts 顶层有 app 副作用不可导入,源码钉)', () => {
  it('stringify 前用 .length 下界预检,其后保留 utf8ByteLength 精确终裁', () => {
    const src = readFileSync(path.resolve(__dirname, '../ipc.ts'), 'utf8');
    const block = src.slice(src.indexOf('LAYOUT_CHANNELS.WRITE,'));
    expect(block.slice(0, 2500)).toMatch(/jsonStringLengthLowerBoundExceeds\(layout, MAX_LAYOUT_BYTES\)/);
    expect(block.slice(0, 2500)).toMatch(/utf8ByteLength\(serialized\)[\s\S]*> MAX_LAYOUT_BYTES/);
  });
});

// 同族收口:读端 layout 守卫与插件 MCP schema 预检也有精确 UTF-8 终裁,预检同样只需 .length 下界。
describe('同族预检:layout 读端守卫 / 插件 MCP jsonSchema', () => {
  it('sanitizeReadLayout 与 jsonSchema refine 用 .length 下界预检,不再逐字符计 UTF-8', () => {
    const guard = readFileSync(path.resolve(__dirname, '../lib/layout-read-guard.ts'), 'utf8');
    expect(guard).toMatch(/jsonStringLengthLowerBoundExceeds\(layout, MAX_LAYOUT_BYTES\)/);
    expect(guard).not.toMatch(/jsonByteLowerBoundExceeds\(/);
    const schemas = readFileSync(path.resolve(__dirname, '../../shared/plugin-mcp-schemas.ts'), 'utf8');
    expect(schemas).not.toMatch(/jsonByteLowerBoundExceeds\(/);
  });
});
