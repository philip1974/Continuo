import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRendererQuery, parseDevRendererUrl } from '../renderer-url';

describe('parseDevRendererUrl', () => {
  // 边界(E299):合法 → URL;缺失/畸形 env → null(调用方回退 loadFile,不让 new URL 同步抛崩溃 createMainWindow)。
  it('E299 合法 URL → URL 实例', () => {
    const u = parseDevRendererUrl('http://localhost:5173/');
    expect(u).toBeInstanceOf(URL);
    expect(u?.host).toBe('localhost:5173');
  });

  it('E299 缺失/畸形 env → null,不抛', () => {
    expect(parseDevRendererUrl(undefined)).toBeNull();
    expect(parseDevRendererUrl('')).toBeNull();
    expect(() => parseDevRendererUrl('not a url ::: %%%')).not.toThrow();
    expect(parseDevRendererUrl('not a url ::: %%%')).toBeNull();
  });

  // 边界(E302):parse 前先限长 —— 超 8192 的合法 scheme URL 也返 null。
  it('E302 超长 URL(> 8192)→ null', () => {
    expect(parseDevRendererUrl('http://localhost:5173/' + 'a'.repeat(9000))).toBeNull();
  });
});

describe('buildRendererQuery', () => {
  it('只组装 windowSeq / workspace / fresh', () => {
    expect(buildRendererQuery({ windowSeq: '2', workspace: '/foo', fresh: true })).toEqual({
      windowSeq: '2',
      workspace: '/foo',
      fresh: '1',
    });
    expect(buildRendererQuery({ windowSeq: '0' })).toEqual({ windowSeq: '0' });
  });

  it('createMainWindow dev URL query 注入不通过 Object.entries(queryParts) 物化中间数组', () => {
    const src = readFileSync(resolve(process.cwd(), 'electron/main/index.ts'), 'utf8');
    expect(src).not.toContain('Object.entries(queryParts)');
  });
});
