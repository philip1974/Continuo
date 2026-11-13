// 重构守卫:路径字符 helper / plugin id 校验只在单一来源定义,其余入口委托(防副本复活)。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { isValidPluginId } from '../../../electron/shared/plugin-id';
import { isValidPluginId as rendererIsValidPluginId } from '../../plugins/plugin-id';
import {
  isAsciiAlphaCode,
  isBareWindowsDrive,
  isPathSeparatorCode,
  trimTrailingSeparators,
} from '../../lib/path-cross';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

function definers(fnName: string): string[] {
  const re = new RegExp(`function ${fnName}\\b`);
  const out: string[] = [];
  for (const file of [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'electron'))]) {
    if (re.test(readFileSync(file, 'utf-8'))) {
      out.push(path.relative(ROOT, file).split(path.sep).join('/'));
    }
  }
  return out.sort();
}

describe('路径字符 helper 单一来源(src/lib/path-cross.ts)', () => {
  it.each(['isPathSeparatorCode', 'isAsciiAlphaCode', 'isBareWindowsDrive', 'trimTrailingSeparators'])(
    '%s 只在 path-cross 定义',
    (fnName) => {
      expect(definers(fnName)).toEqual(['src/lib/path-cross.ts']);
    },
  );

  it('语义不变', () => {
    expect(isPathSeparatorCode(47)).toBe(true);
    expect(isPathSeparatorCode(92)).toBe(true);
    expect(isPathSeparatorCode(58)).toBe(false);
    expect(isAsciiAlphaCode('a'.charCodeAt(0))).toBe(true);
    expect(isAsciiAlphaCode('Z'.charCodeAt(0))).toBe(true);
    expect(isAsciiAlphaCode('1'.charCodeAt(0))).toBe(false);
    expect(isBareWindowsDrive('C:')).toBe(true);
    expect(isBareWindowsDrive('C:\\')).toBe(false);
    expect(isBareWindowsDrive('1:')).toBe(false);
    expect(trimTrailingSeparators('/a/b//')).toBe('/a/b');
    expect(trimTrailingSeparators('C:\\x\\')).toBe('C:\\x');
    expect(trimTrailingSeparators('/')).toBe('');
    expect(trimTrailingSeparators('a')).toBe('a');
  });
});

describe('plugin id 校验单一来源(electron/shared/plugin-id.ts)', () => {
  it('字符扫描只在 shared 定义', () => {
    expect(definers('hasOnlyPluginIdChars')).toEqual(['electron/shared/plugin-id.ts']);
  });

  it('renderer 入口是 shared 的同一函数', () => {
    expect(rendererIsValidPluginId).toBe(isValidPluginId);
  });

  it.each(['a', 'my-plugin', 'a.b_c-1', '...'])('合法:%j', (id) => {
    expect(isValidPluginId(id)).toBe(true);
  });

  it.each(['', '.', '..', 'A', 'a/b', 'a\\b', 'a b', '中文', '../x'])('非法:%j', (id) => {
    expect(isValidPluginId(id)).toBe(false);
  });

  it('main 两个入口委托 shared', () => {
    for (const rel of [
      'electron/main/services/plugins.service.ts',
      'electron/main/services/plugin-data-store.service.ts',
    ]) {
      expect(readFileSync(path.join(ROOT, rel), 'utf-8')).toMatch(/shared\/plugin-id'/);
    }
  });
});
