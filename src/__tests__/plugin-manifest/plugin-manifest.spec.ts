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

  // 边界(E123):id 为纯点段 "."/".."(路径穿越语义)→ SCHEMA_ERROR。此前裸正则 /^[a-z0-9._-]+$/
  // 放行点段,与 main isSafePluginId / marketplace isValidPluginId 契约漂移;改用共享 isValidPluginId。
  it('E123 id 为 "." / ".." (纯点段) → SCHEMA_ERROR', () => {
    for (const badId of ['.', '..']) {
      const r = parseManifest(
        JSON.stringify({ id: badId, name: 'X', version: '1.0.0' }),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('SCHEMA_ERROR');
    }
  });

  it('E123 合法 id(含点但非纯点段,如 a.b / com.example.foo)→ 仍通过', () => {
    for (const okId of ['a.b', 'com.example.foo', 'a.._b']) {
      const r = parseManifest(
        JSON.stringify({ id: okId, name: 'X', version: '1.0.0' }),
      );
      expect(r.ok).toBe(true);
    }
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

  // 可维护性 M8:permissions 走 z.enum(PERMISSION_KEYS)(从 const 派生,无 as unknown)。
  // 锁定运行时仍正确收合法权限、拒非法权限(枚举确实接到了单一来源 PERMISSION_KEYS)。
  it('permissions 全合法 → ok 且透传', () => {
    const r = parseManifest(
      JSON.stringify({
        id: 'a.b',
        name: 'X',
        version: '1.0.0',
        permissions: ['fs', 'network', 'shell', 'clipboard', 'mcp-tools'],
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.permissions).toContain('mcp-tools');
  });

  it('permissions 含非法值 → SCHEMA_ERROR', () => {
    const r = parseManifest(
      JSON.stringify({
        id: 'a.b',
        name: 'X',
        version: '1.0.0',
        permissions: ['fs', 'bogus-permission'],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SCHEMA_ERROR');
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

  // 边界(E74,E24/E35 字段上限族):manifest 字段须有 .max(),挡接近 1MiB 的超长字段/超量 permissions
  // 进入 PluginManager/PluginsTab/权限弹窗放大渲染。
  it('E74 超长 name(>256)→ SCHEMA_ERROR(不进 UI 放大)', () => {
    const r = parseManifest(
      JSON.stringify({ id: 'a.b', name: 'x'.repeat(257), version: '1.0.0' }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SCHEMA_ERROR');
  });

  it('E74 超长 description(>8192)→ SCHEMA_ERROR', () => {
    const r = parseManifest(
      JSON.stringify({
        id: 'a.b',
        name: 'X',
        version: '1.0.0',
        description: 'd'.repeat(8193),
      }),
    );
    expect(r.ok).toBe(false);
  });

  it('E74 permissions 数量超 PERMISSION_KEYS 数(重复刷量)→ SCHEMA_ERROR', () => {
    const r = parseManifest(
      JSON.stringify({
        id: 'a.b',
        name: 'X',
        version: '1.0.0',
        // 5 个合法 key 全列 + 1 个重复 = 6 项 > PERMISSION_KEYS.length(5)
        permissions: ['fs', 'network', 'shell', 'clipboard', 'mcp-tools', 'fs'],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SCHEMA_ERROR');
  });

  it('E74 正常 manifest(字段在上限内)仍 ok', () => {
    const r = parseManifest(
      JSON.stringify({
        id: 'a.b',
        name: 'Normal Plugin',
        version: '1.0.0',
        description: 'a reasonable description',
        permissions: ['fs', 'network'],
      }),
    );
    expect(r.ok).toBe(true);
  });

  // 边界(E77,E73/E75/E76 错误串放大族最后一处 zod-join):SCHEMA_ERROR message 经 capJoinedMessages
  // 限总长。zod enum 错误会回显 received 值 —— 单个超长非法 permission 元素(.max(5) 只限数组条数、
  // 不限元素长度,E74 未覆盖)会产生 >2048 的 issue.message,须截断防进 PluginManager.entry.error/
  // PluginsTab 渲染放大。
  it('E77 超长非法 permission 值 → SCHEMA_ERROR message 有上限 + 截断标记', () => {
    const r = parseManifest(
      JSON.stringify({
        id: 'a.b',
        name: 'X',
        version: '1.0.0',
        // 数组长度 1(过 .max(5)),但元素是 3000 字符非法 enum → zod 回显该超长值
        permissions: ['z'.repeat(3000)],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('SCHEMA_ERROR');
      expect(r.message.length).toBeLessThanOrEqual(2048 + 64); // 远小于未截断的 ~3KB
      expect(r.message).toContain('truncated');
    }
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

  // 边界(E9,E7/E8 同族):数字段超 MAX_SAFE_INTEGER 变 Infinity/不安全整数 → 兼容比较失真。
  // 任一段不安全 → parseVer null → fail-closed 保守拒载(false)。
  it('E9 不安全整数版本段 → false(保守拒载,不进失真比较)', () => {
    // appVersion 超大:不安全 → false
    expect(
      isVersionCompatible('99999999999999999999.0.0', '1.0.0'),
    ).toBe(false);
    // minLMVersion 超大:不安全 → false(畸形 plugin manifest 不会被误判兼容)
    expect(
      isVersionCompatible('1.0.0', '99999999999999999999.0.0'),
    ).toBe(false);
    expect(isVersionCompatible('1.0.0', '1.9007199254740993.0')).toBe(false);
  });

  it('E9 边界:MAX_SAFE_INTEGER 段仍合法比较', () => {
    expect(isVersionCompatible('9007199254740991.0.0', '1.0.0')).toBe(true);
  });
});
