// manifest.json 解析 + SemVer 比对(M-Plugin v1.2)。
// 不抛错语义:解析失败统一返回 { ok:false, code, message },由 PluginManager
// 决定跳过 / 提示。

import { z } from 'zod';
import { PERMISSION_KEYS } from './permissions';
import { capJoinedMessagesFrom } from '../../electron/shared/cap-joined-messages';
import type { PluginManifest } from './types';
import { errorMessage } from '../../electron/shared/error-message';
import { isValidPluginId } from './plugin-id';

// ── Schema ─────────────────────────────────────────────

const SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

// 边界(E74,E24/E35 字段上限族):manifest 各字段此前无长度/数量上限,主进程只限 manifest 文件
// 总大小(E24 MANIFEST_MAX_BYTES=1MiB)。畸形本地插件可用接近 1MiB 的 name/description 或大量重复
// permissions 进入 PluginManager / PluginsTab / 权限弹窗 / 错误状态 → renderer 渲染/状态放大卡顿。
// 给每字段加合理 .max();permissions 按 PERMISSION_KEYS 数量封顶(去重后不可能更多)。超限拒载。
const NAME_MAX = 256;
const MAIN_MAX = 512; // 入口路径名
const DESC_MAX = 8192;
const AUTHOR_MAX = 256;
const URL_MAX = 2048;
const VERSION_MAX = 128;

export const ManifestSchema = z.object({
  // 反 DNS 命名:小写字母 / 数字 / . _ -。边界(E123):此前只用裸正则 /^[a-z0-9._-]+$/,放行
  // "."/".."(纯点段=路径穿越语义),与 main isSafePluginId、marketplace isValidPluginId 契约漂移
  //(三处)。改用共享 isValidPluginId(charset + 拒 ./..)收敛,防手工放入的畸形本地 manifest
  // 经 renderer parseManifest 进 PluginManager 成脏 entry(仅启用时主进程才拒)。
  id: z
    .string()
    .min(1)
    .max(NAME_MAX)
    .refine(isValidPluginId, {
      message: 'id 仅允许小写字母数字与 . _ -,且不能为 . 或 ..',
    }),
  name: z.string().min(1).max(NAME_MAX),
  version: z.string().max(VERSION_MAX).regex(SEMVER_RE),
  main: z.string().min(1).max(MAIN_MAX).default('main.js'),
  description: z.string().max(DESC_MAX).optional(),
  author: z.string().max(AUTHOR_MAX).optional(),
  authorUrl: z.string().url().max(URL_MAX).optional(),
  minLMVersion: z.string().max(VERSION_MAX).regex(SEMVER_RE).optional(),
  isDesktopOnly: z.boolean().optional(),
  // 可维护性 M8:PERMISSION_KEYS 现为 `as const` tuple,z.enum 直接接受,无需 as unknown。
  // 边界(E74):枚举去重后最多 PERMISSION_KEYS.length 项,超出必为重复/畸形 → 拒载。
  permissions: z
    .array(z.enum(PERMISSION_KEYS))
    .max(PERMISSION_KEYS.length)
    .optional(),
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
      // 边界(E77,E73/E75/E76 错误串放大族最后一处 zod-join):issues 全量 map+join 无上限,
      // 畸形 manifest 可在 1MiB 文件内生成超长错误串,进入 PluginManager entry.error / PluginsTab
      // 渲染放大。复用共享 capJoinedMessages(限条数 + 总长 + 截断标记,与 main/renderer 同一来源)。
      // 边界(E223,E222 兄弟):mapper 变体,只对前 N 个 issue 格式化,不先 issues.map 全量物化。
      message: capJoinedMessagesFrom(
        parsed.error.issues,
        (i) => `${i.path.join('.') || '<root>'}: ${i.message}`,
        'more issues',
      ),
    };
  }
  return { ok: true, data: parsed.data };
}

// ── SemVer 比对 ────────────────────────────────────────

function parseVer(v: string): readonly [number, number, number] | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  // 边界(E9,E7/E8 同族):`\d+` 允许任意长度数字段,`Number('999…999')` 超 Number.MAX_SAFE_INTEGER
  // 变 Infinity/不安全整数,参与兼容比较时语义失真(畸形 plugin manifest 可通过 schema 污染兼容
  // 判断,minLMVersion vs app version 在极端数字下不可靠)。任一段非安全整数即视为非法版本 →
  // 返 null,下方 isVersionCompatible 对 null fail-closed(保守拒载)。
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch)
  ) {
    return null;
  }
  return [major, minor, patch] as const;
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
