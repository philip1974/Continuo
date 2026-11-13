// 重构守卫:进程间依赖方向(main / preload / shared 不反向依赖 renderer 源码树)。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as sharedContract from '../../../electron/shared/plugin-fs-contract';
import { PERMISSION_KEYS as SHARED_KEYS } from '../../../electron/shared/permission-keys';
import { parseManifest as sharedParseManifest } from '../../../electron/shared/plugin-manifest';
import {
  PluginIdentityError,
  ScopeError,
  ScopeRequestTimeoutError,
} from '../../plugins/types';
import { PERMISSION_KEYS } from '../../plugins/permissions';
import { parseManifest } from '../../plugins/manifest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** 文件里所有静态 import / export-from / 动态 import 的模块说明符。 */
function specifiers(src: string): string[] {
  const out: string[] = [];
  const re = /(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]!);
  return out;
}

function offenders(dir: string, isForbidden: (resolved: string, spec: string) => boolean): string[] {
  const bad: string[] = [];
  for (const file of walk(path.join(ROOT, dir))) {
    for (const spec of specifiers(readFileSync(file, 'utf-8'))) {
      const resolved = spec.startsWith('.')
        ? path.relative(ROOT, path.resolve(path.dirname(file), spec)).split(path.sep).join('/')
        : spec;
      if (isForbidden(resolved, spec)) {
        bad.push(`${path.relative(ROOT, file).split(path.sep).join('/')} -> ${spec}`);
      }
    }
  }
  return bad;
}

describe('进程间依赖方向', () => {
  it('electron/ 不从 src/ 导入(含主进程测试)', () => {
    expect(
      offenders('electron', (resolved, spec) => resolved.startsWith('src/') || spec.startsWith('@/')),
    ).toEqual([]);
  });

  it('electron/shared 不依赖 main / preload / src', () => {
    expect(
      offenders(
        'electron/shared',
        (resolved, spec) =>
          resolved.startsWith('electron/main') ||
          resolved.startsWith('electron/preload') ||
          resolved.startsWith('src/') ||
          spec.startsWith('@/'),
      ),
    ).toEqual([]);
  });

  it('tsconfig.node.json 的 include 不含 src/ 条目', () => {
    const raw = readFileSync(path.join(ROOT, 'tsconfig.node.json'), 'utf-8');
    const include = raw.slice(raw.indexOf('"include"'), raw.indexOf('"exclude"'));
    expect(include).not.toMatch(/"src\//);
  });
});

describe('src/plugins 的既有入口是 shared 定义的 re-export(非副本)', () => {
  it('错误类 / 权限枚举 / parseManifest 是同一对象', () => {
    expect(ScopeError).toBe(sharedContract.ScopeError);
    expect(PluginIdentityError).toBe(sharedContract.PluginIdentityError);
    expect(ScopeRequestTimeoutError).toBe(sharedContract.ScopeRequestTimeoutError);
    expect(PERMISSION_KEYS).toBe(SHARED_KEYS);
    expect(parseManifest).toBe(sharedParseManifest);
  });

  it('错误类保持既有 code / name 契约', () => {
    const scope = new ScopeError('x', { target: '/a', reason: 'r' });
    expect(scope).toMatchObject({ code: 'SCOPE_ERROR', name: 'ScopeError' });
    expect(new PluginIdentityError('x')).toMatchObject({
      code: 'PLUGIN_IDENTITY_ERROR',
      name: 'PluginIdentityError',
    });
    expect(new ScopeRequestTimeoutError('x', 'req-1')).toMatchObject({
      code: 'SCOPE_REQUEST_TIMEOUT',
      name: 'ScopeRequestTimeoutError',
      requestId: 'req-1',
    });
  });
});
