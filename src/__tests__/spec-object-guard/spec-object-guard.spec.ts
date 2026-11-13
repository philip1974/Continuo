// 边界(E273,E271 registry 族):validate*Spec 读 spec 字段前须先判 spec 是对象,否则 JS 插件传
// null/undefined 会抛非结构化 TypeError 绕过稳定错误契约。共享 isSpecObject 收口,全 9 个 validator 调用。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { isSpecObject } from '../../plugins/registries/spec-guard';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';

describe('isSpecObject(E273)', () => {
  it('null / undefined / primitive / 数组 → false', () => {
    expect(isSpecObject(null)).toBe(false);
    expect(isSpecObject(undefined)).toBe(false);
    expect(isSpecObject(42)).toBe(false);
    expect(isSpecObject('x')).toBe(false);
    expect(isSpecObject(true)).toBe(false);
    expect(isSpecObject([1, 2])).toBe(false);
  });

  it('普通对象 → true', () => {
    expect(isSpecObject({})).toBe(true);
    expect(isSpecObject({ id: 'x' })).toBe(true);
  });
});

describe('CommandRegistry.register 非对象 spec → 稳定错误(非 TypeError)', () => {
  it.each([null, undefined, 42, 'x', [1]])(
    'register(%s) → 抛 "spec must be an object",不是读 null.id 的 TypeError',
    (bad) => {
      const reg = new CommandRegistry();
      const err = (() => {
        try {
          reg.register(bad as never);
          return null;
        } catch (e) {
          return e as Error;
        }
      })();
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toMatch(/spec must be an object/);
      // 不是解构 null 的非结构化 TypeError
      expect(err!.message).not.toMatch(/Cannot read|of null|of undefined/);
    },
  );

  it('合法 spec 仍正常注册(回归)', () => {
    const reg = new CommandRegistry();
    expect(() =>
      reg.register({ id: 'c1', title: 't', fn: () => {} }),
    ).not.toThrow();
  });
});

// 家族接线守卫:全 9 个贡献 registry 的 validate*Spec 都必须先校验 spec 是对象(防某兄弟漏接/回归)——
// 直接调 isSpecObject,或调 spec-guard 的 assertSpecObject(内部即 isSpecObject + 统一错误消息)。
describe('E273 家族接线守卫:全部贡献 registry validator 调用 isSpecObject', () => {
  const REGISTRIES = [
    'CommandRegistry',
    'EditorActionRegistry',
    'ExplorerContextMenuRegistry',
    'PanelRegistry',
    'RibbonRegistry',
    'SettingItemRegistry',
    'SettingTabRegistry',
    'StatusBarRegistry',
    'PluginMcpRegistry',
  ];
  const dir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../plugins/registries',
  );
  it.each(REGISTRIES)('%s 的 validate*Spec 调用 isSpecObject', (name) => {
    const src = readFileSync(path.join(dir, `${name}.ts`), 'utf-8');
    expect(src).toMatch(/isSpecObject\(|assertSpecObject\(/);
  });

  it('assertSpecObject 内部走 isSpecObject', () => {
    const src = readFileSync(path.join(dir, 'spec-guard.ts'), 'utf-8');
    const body = src.slice(src.indexOf('export function assertSpecObject'));
    expect(body.slice(0, body.indexOf('\n}'))).toContain('isSpecObject(spec)');
  });
});
