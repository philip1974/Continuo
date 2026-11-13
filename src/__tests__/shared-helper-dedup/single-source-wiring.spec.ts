// 重构守卫:路径字符 helper / plugin id 校验只在单一来源定义,其余入口委托(防副本复活)。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { isValidPluginId } from '../../../electron/shared/plugin-id';
import {
  isBlankString,
  isEcmaWhitespaceCode,
  trimStringToMax,
} from '../../../electron/shared/ecma-whitespace';
import {
  hasTranslateParams,
  interpolateTemplate,
} from '../../../electron/shared/i18n-interpolate';
import { runSerialPerKey } from '../../../electron/shared/run-serial-per-key';
import { runSerialPerKey as rendererRunSerialPerKey } from '../../lib/serialize-per-key';
import { runSerialPerKey as mainRunSerialPerKey } from '../../../electron/main/services/serialize-per-key';
import { isBlankString as rendererIsBlankString } from '../../lib/blank-string';
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

describe('ECMA 空白判定单一来源(electron/shared/ecma-whitespace.ts)', () => {
  it('码点集合恒等于 JS 正则 \\s(全 BMP 扫描)', () => {
    const re = /\s/;
    for (let code = 0; code <= 0xffff; code += 1) {
      if (isEcmaWhitespaceCode(code) !== re.test(String.fromCharCode(code))) {
        throw new Error(`mismatch at U+${code.toString(16)}`);
      }
    }
  });

  it.each(['isEcmaWhitespaceCode', 'isEcmaTrimWhitespaceCode', 'isWhitespaceCode'])(
    '%s 无其他本地定义',
    (fnName) => {
      const expected = fnName === 'isEcmaWhitespaceCode' ? ['electron/shared/ecma-whitespace.ts'] : [];
      expect(definers(fnName)).toEqual(expected);
    },
  );

  it('isBlankString / trimStringToMax 语义等价 trim', () => {
    expect(rendererIsBlankString).toBe(isBlankString);
    for (const v of ['', ' \t\u00a0\u3000', ' a ', '\ufeff', 'x']) {
      expect(isBlankString(v)).toBe(v.trim() === '');
    }
    for (const v of ['  hello world  ', '\u3000ab\n', '   ', 'abc']) {
      expect(trimStringToMax(v, 4)).toBe(v.trim().slice(0, 4));
    }
    expect(trimStringToMax(' a ', 0)).toBe('');
  });
});

describe('i18n 插值单一来源(electron/shared/i18n-interpolate.ts)', () => {
  it('interpolateTemplate 只在 shared 定义', () => {
    expect(definers('interpolateTemplate')).toEqual(['electron/shared/i18n-interpolate.ts']);
  });

  it('插值语义', () => {
    expect(interpolateTemplate('Hi {name}, {n} new', { name: 'A', n: 2 })).toBe('Hi A, 2 new');
    expect(interpolateTemplate('keep {missing}', { other: 1 })).toBe('keep {missing}');
    expect(interpolateTemplate('{a}{b}', { a: 'x', b: 'y' })).toBe('xy');
    expect(interpolateTemplate('{ not } {a-b} {}', { a: 1 })).toBe('{ not } {a-b} {}');
    const plain = 'no placeholders';
    expect(interpolateTemplate(plain, { a: 1 })).toBe(plain);
  });

  it('hasTranslateParams:undefined / 空对象 → false', () => {
    expect(hasTranslateParams(undefined)).toBe(false);
    expect(hasTranslateParams({})).toBe(false);
    expect(hasTranslateParams({ a: 1 })).toBe(true);
  });
});

describe('runSerialPerKey 单一来源(electron/shared/run-serial-per-key.ts)', () => {
  it('renderer / main 入口是同一函数,且只定义一次', () => {
    expect(rendererRunSerialPerKey).toBe(runSerialPerKey);
    expect(mainRunSerialPerKey).toBe(runSerialPerKey);
    expect(definers('runSerialPerKey')).toEqual(['electron/shared/run-serial-per-key.ts']);
  });
});
