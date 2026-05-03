import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  LayoutSchema,
  loadLayout,
  saveLayout,
} from '../../../electron/main/persistence';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'lm-layout-'));
  file = path.join(dir, 'layout.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('layout 持久化', () => {
  it('写后能读回:结构等价', async () => {
    const payload = { version: 1, grid: { foo: 'bar' }, panels: { a: { id: 'a' } } };
    await saveLayout(file, payload);
    const back = await loadLayout(file);
    expect(back).toEqual(payload);
  });

  it('缺失文件 → null', async () => {
    expect(await loadLayout(file)).toBeNull();
  });

  it('损坏 JSON → null,不抛', async () => {
    await writeFile(file, '{not json');
    expect(await loadLayout(file)).toBeNull();
  });

  it('schema 拒绝非对象 payload', async () => {
    await expect(saveLayout(file, 'oops' as unknown)).rejects.toThrow();
    await expect(saveLayout(file, 42 as unknown)).rejects.toThrow();
    await expect(saveLayout(file, null as unknown)).rejects.toThrow();
  });

  it('schema 允许顶层 version 与未知字段透传', () => {
    const ok = LayoutSchema.parse({ version: 1, anything: { else: true } });
    expect(ok).toMatchObject({ version: 1, anything: { else: true } });
  });

  it('schema 拒绝 version !== 1(为未来 migration 强校验)', () => {
    expect(() => LayoutSchema.parse({ version: 2 })).toThrow();
  });
});
