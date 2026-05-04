import { describe, it, expect } from 'vitest';
import {
  parseManifest,
  isVersionCompatible,
} from '../../plugins/manifest';

const validJson = JSON.stringify({
  id: 'com.example.foo',
  name: 'Foo',
  version: '0.1.0',
});

// ── parseManifest ────────────────────────────────────────

describe('parseManifest:JSON 错误', () => {
  it('非 JSON 字符串 → INVALID_JSON', () => {
    const r = parseManifest('not json {');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('INVALID_JSON');
  });

  it('空字符串 → INVALID_JSON', () => {
    const r = parseManifest('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('INVALID_JSON');
  });
});

describe('parseManifest:Schema 校验', () => {
  it('必填字段齐全 → ok', () => {
    const r = parseManifest(validJson);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.id).toBe('com.example.foo');
      expect(r.data.name).toBe('Foo');
      expect(r.data.version).toBe('0.1.0');
    }
  });

  it('main 缺失 → 默认 main.js', () => {
    const r = parseManifest(validJson);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.main).toBe('main.js');
  });

  it('main 显式指定 → 透传', () => {
    const j = JSON.stringify({ ...JSON.parse(validJson), main: 'index.js' });
    const r = parseManifest(j);
    if (r.ok) expect(r.data.main).toBe('index.js');
  });

  it('id 缺失 → SCHEMA_ERROR', () => {
    const r = parseManifest(JSON.stringify({ name: 'X', version: '1.0.0' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SCHEMA_ERROR');
  });

  it('id 含非法字符(大写)→ SCHEMA_ERROR', () => {
    const r = parseManifest(
      JSON.stringify({ id: 'BadId', name: 'X', version: '1.0.0' }),
    );
    expect(r.ok).toBe(false);
  });

  it('version 不合法格式 → SCHEMA_ERROR', () => {
    const r = parseManifest(
      JSON.stringify({ id: 'a.b', name: 'X', version: '1.0' }),
    );
    expect(r.ok).toBe(false);
  });

  it('version SemVer 含 prerelease → ok', () => {
    const r = parseManifest(
      JSON.stringify({ id: 'a.b', name: 'X', version: '1.0.0-beta.1' }),
    );
    expect(r.ok).toBe(true);
  });

  it('authorUrl 非 URL → SCHEMA_ERROR', () => {
    const r = parseManifest(
      JSON.stringify({
        id: 'a.b',
        name: 'X',
        version: '1.0.0',
        authorUrl: 'not-a-url',
      }),
    );
    expect(r.ok).toBe(false);
  });

  it('minLMVersion 不合法 → SCHEMA_ERROR', () => {
    const r = parseManifest(
      JSON.stringify({
        id: 'a.b',
        name: 'X',
        version: '1.0.0',
        minLMVersion: 'foo',
      }),
    );
    expect(r.ok).toBe(false);
  });
});

describe('parseManifest:不抛错保证', () => {
  it('再脏的 JSON 也不 throw', () => {
    expect(() => parseManifest('{{{{')).not.toThrow();
    expect(() => parseManifest('null')).not.toThrow();
    expect(() => parseManifest('[]')).not.toThrow(); // 数组不是 object
  });
});

// ── isVersionCompatible ──────────────────────────────────

describe('isVersionCompatible(app, min)', () => {
  it('app > min → true', () => {
    expect(isVersionCompatible('1.2.0', '1.1.0')).toBe(true);
    expect(isVersionCompatible('2.0.0', '1.99.99')).toBe(true);
    expect(isVersionCompatible('0.1.5', '0.1.4')).toBe(true);
  });

  it('app == min → true(边界)', () => {
    expect(isVersionCompatible('1.0.0', '1.0.0')).toBe(true);
  });

  it('app < min → false', () => {
    expect(isVersionCompatible('0.9.0', '1.0.0')).toBe(false);
    expect(isVersionCompatible('1.0.0', '1.0.1')).toBe(false);
    expect(isVersionCompatible('1.0.0', '2.0.0')).toBe(false);
  });

  it('版本含 prerelease 后缀 → 仅比 major.minor.patch', () => {
    expect(isVersionCompatible('1.0.0-rc.1', '1.0.0')).toBe(true);
    expect(isVersionCompatible('1.0.0', '1.0.0-rc.1')).toBe(true);
  });

  it('任一非合法版本 → false(保守拒载)', () => {
    expect(isVersionCompatible('1.0', '1.0.0')).toBe(false);
    expect(isVersionCompatible('1.0.0', 'foo')).toBe(false);
    expect(isVersionCompatible('', '1.0.0')).toBe(false);
  });
});
