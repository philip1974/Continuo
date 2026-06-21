// manifest.json 解析 + SemVer 比对(M-Plugin v1.2)。
// 不抛错语义:解析失败统一返回 { ok:false, code, message },由 PluginManager
// 决定跳过 / 提示。

import { z } from 'zod';
import { PERMISSION_KEYS } from './permissions';
import type { PluginManifest } from './types';
import { errorMessage } from '../../electron/shared/error-message';

// ── Schema ─────────────────────────────────────────────

const SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

export const ManifestSchema = z.object({
  // 反 DNS 命名:小写字母 / 数字 / . _ -
  id: z.string().min(1).regex(/^[a-z0-9._-]+$/),
  name: z.string().min(1),
  version: z.string().regex(SEMVER_RE),
  main: z.string().min(1).default('main.js'),
  description: z.string().optional(),
  author: z.string().optional(),
  authorUrl: z.string().url().optional(),
  minLMVersion: z.string().regex(SEMVER_RE).optional(),
  isDesktopOnly: z.boolean().optional(),
  // 可维护性 M8:PERMISSION_KEYS 现为 `as const` tuple,z.enum 直接接受,无需 as unknown。
  permissions: z.array(z.enum(PERMISSION_KEYS)).optional(),
});

// ── 解析结果类型 ───────────────────────────────────────

export type ManifestParseResult =
  | { ok: true; data: PluginManifest }
  | {
      ok: false;
      code: 'INVALID_JSON' | 'SCHEMA_ERROR';
      message: string;
    };

export function parseManifest(jsonText: string): ManifestParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch (err) {
    return {
      ok: false,
      code: 'INVALID_JSON',
      message: errorMessage(err),
    };
  }
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'SCHEMA_ERROR',
      message: parsed.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; '),
    };
  }
  return { ok: true, data: parsed.data };
}

// ── SemVer 比对 ────────────────────────────────────────

function parseVer(v: string): readonly [number, number, number] | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])] as const;
}

/**
 * appVersion >= pluginMin 即兼容。任一非合法版本返回 false(保守拒载)。
 * 只比 major.minor.patch,prerelease 后缀忽略。
 */
export function isVersionCompatible(
  appVersion: string,
  pluginMin: string,
): boolean {
  const a = parseVer(appVersion);
  const p = parseVer(pluginMin);
  if (!a || !p) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! > p[i]!) return true;
    if (a[i]! < p[i]!) return false;
  }
  return true;
}
