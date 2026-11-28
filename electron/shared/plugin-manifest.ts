// manifest.json 解析 + SemVer 比对(M-Plugin v1.2)。
// 不抛错语义:解析失败统一返回 { ok:false, code, message },由 PluginManager
// 决定跳过 / 提示。

import { z } from 'zod';
import { PERMISSION_KEYS, type PermissionKey } from './permission-keys';
import { capJoinedMessagesFrom } from './cap-joined-messages';
import { errorMessage } from './error-message';
import { isValidPluginId } from './plugin-id';
import { PLUGIN_ID_MAX_LEN, PLUGIN_VERSION_MAX_LEN } from './permission-record-limits';

export interface PluginManifest {
  /** 唯一 id,反 DNS 命名(com.example.foo)。 */
  readonly id: string;
  /** 用户可见名称。 */
  readonly name: string;
  /** semver,LM 兼容性比对用。 */
  readonly version: string;
  /** 入口 ESM 文件相对路径,默认 'main.js'. */
  readonly main?: string;
  readonly description?: string;
  readonly author?: string;
  readonly authorUrl?: string;
  /** LM 应用最小版本(semver),低于则拒载。 */
  readonly minLMVersion?: string;
  /** 仅桌面 LM 可加载(暂留,LM 目前只有桌面). */
  readonly isDesktopOnly?: boolean;
  /** 声明式权限请求(v3.3),首次启用提示用户授权. */
  readonly permissions?: readonly PermissionKey[];
}

// ── Schema ─────────────────────────────────────────────

const SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

// 边界(E74,E24/E35 字段上限族):manifest 各字段此前无长度/数量上限,主进程只限 manifest 文件
// 总大小(E24 MANIFEST_MAX_BYTES=1MiB)。畸形本地插件可用接近 1MiB 的 name/description 或大量重复
// permissions 进入 PluginManager / PluginsTab / 权限弹窗 / 错误状态 → renderer 渲染/状态放大卡顿。
// 给每字段加合理 .max();permissions 按 PERMISSION_KEYS 数量封顶(去重后不可能更多)。超限拒载。
const NAME_MAX = 256;
/** 入口路径名长度上限(main 侧 getPluginMainName 选入口时同口径)。 */
export const MANIFEST_MAIN_MAX = 512;
/** manifest 未声明 main 时的默认入口。 */
export const DEFAULT_PLUGIN_MAIN = 'main.js';
/** manifest.json 文件 / 响应体字节上限(main 读本地插件、renderer 拉市场 manifest 同口径)。 */
export const MANIFEST_MAX_BYTES = 1024 * 1024;
const DESC_MAX = 8192;
const AUTHOR_MAX = 256;
const URL_MAX = 2048;
const VERSION_MAX = PLUGIN_VERSION_MAX_LEN;

export const ManifestSchema = z.object({
  // 反 DNS 命名:小写字母 / 数字 / . _ -。边界(E123):此前只用裸正则 /^[a-z0-9._-]+$/,放行
  // "."/".."(纯点段=路径穿越语义),与 main isSafePluginId、marketplace isValidPluginId 契约漂移
  //(三处)。改用共享 isValidPluginId(规则见 ./plugin-id)收敛,防手工放入的畸形本地 manifest
  // 经 renderer parseManifest 进 PluginManager 成脏 entry(仅启用时主进程才拒)。
  id: z
    .string()
    .min(1)
    .max(PLUGIN_ID_MAX_LEN)
    .refine(isValidPluginId, {
      // 开发者面向的英文兜底;界面按 ManifestIssue.code(id_format)本地化(见 manifestIssueFrom)。
      message:
        'id may only contain lowercase letters, digits, ".", "_" and "-"; it must not start with "." or "_", end with ".", or be a Windows reserved device name',
    }),
  name: z.string().min(1).max(NAME_MAX),
  version: z.string().max(VERSION_MAX).regex(SEMVER_RE),
  main: z.string().min(1).max(MANIFEST_MAIN_MAX).default(DEFAULT_PLUGIN_MAIN),
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

/**
 * 字段级校验问题(插件页「无效插件」行逐条显示,按 code 本地化;message 是英文兜底 = 原 `path: message` 中的 message)。
 * code 由 zod issue 归一化,只收录界面有专门文案的几类,其余 'other'(显示英文 message)。
 */
export type ManifestIssueCode =
  | 'required'
  | 'invalid_type'
  | 'too_short'
  | 'too_long'
  | 'too_many'
  | 'semver'
  | 'url'
  | 'enum'
  | 'id_format'
  | 'other';

export interface ManifestIssue {
  /** 字段路径(`permissions.1`);根(JSON 不是对象)为 `<root>`。 */
  readonly path: string;
  readonly code: ManifestIssueCode;
  readonly params?: Readonly<Record<string, string | number>>;
  readonly message: string;
}

/** 随结果携带的字段级问题条数上限(与 message 的 capJoinedMessagesFrom 同口径:够诊断,不放大)。 */
export const MANIFEST_ISSUES_MAX = 20;

export type ManifestParseResult =
  | { ok: true; data: PluginManifest }
  | {
      ok: false;
      code: 'INVALID_JSON' | 'SCHEMA_ERROR';
      message: string;
      /** SCHEMA_ERROR 时的字段级问题(≤ MANIFEST_ISSUES_MAX)。 */
      issues?: readonly ManifestIssue[];
    };

interface ZodIssueLike {
  readonly code: string;
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly origin?: string;
  readonly format?: string;
  readonly maximum?: number | bigint;
  readonly minimum?: number | bigint;
  readonly values?: readonly unknown[];
  readonly expected?: string;
}

/** 按路径取原始 JSON 里的值(判定「缺失」= 必填项未给)。 */
function valueAt(raw: unknown, path: readonly PropertyKey[]): unknown {
  let cur: unknown = raw;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[key];
  }
  return cur;
}

const ISSUE_PARAM_MAX = 256;

function manifestIssueFrom(issue: ZodIssueLike, raw: unknown): ManifestIssue {
  const path = issue.path.map(String).join('.') || '<root>';
  const base = { path, message: issue.message };
  switch (issue.code) {
    case 'invalid_type':
      if (issue.path.length > 0 && valueAt(raw, issue.path) === undefined) return { ...base, code: 'required' };
      return { ...base, code: 'invalid_type', params: { expected: String(issue.expected ?? '').slice(0, ISSUE_PARAM_MAX) } };
    case 'too_small':
      return { ...base, code: 'too_short' };
    case 'too_big':
      return {
        ...base,
        code: issue.origin === 'array' ? 'too_many' : 'too_long',
        params: { max: Number(issue.maximum ?? 0) },
      };
    case 'invalid_format':
      if (issue.format === 'url') return { ...base, code: 'url' };
      // 只有 version / minLMVersion 用正则(SEMVER_RE)。
      if (issue.format === 'regex') return { ...base, code: 'semver' };
      return { ...base, code: 'other' };
    case 'invalid_value':
      return {
        ...base,
        code: 'enum',
        params: { options: (issue.values ?? []).map(String).join(', ').slice(0, ISSUE_PARAM_MAX) },
      };
    case 'custom':
      // 唯一的 refine 是 id 的 isValidPluginId。
      if (path === 'id') return { ...base, code: 'id_format' };
      return { ...base, code: 'other' };
    default:
      return { ...base, code: 'other' };
  }
}

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
      // 渲染放大。复用共享 capJoinedMessagesFrom(限条数 + 总长 + 截断标记,与 main/renderer 同一来源)。
      // 边界(E223,E222 兄弟):mapper 变体,只对前 N 个 issue 格式化,不先 issues.map 全量物化。
      message: capJoinedMessagesFrom(
        parsed.error.issues,
        (i) => `${i.path.join('.') || '<root>'}: ${i.message}`,
        'more issues',
      ),
      issues: parsed.error.issues
        .slice(0, MANIFEST_ISSUES_MAX)
        .map((i) => manifestIssueFrom(i as ZodIssueLike, raw)),
    };
  }
  return { ok: true, data: parsed.data };
}

// ── SemVer 比对 ────────────────────────────────────────

function parseVer(v: string): readonly [number, number, number] | null {
  const firstDot = v.indexOf('.');
  if (firstDot <= 0) return null;
  const secondDot = v.indexOf('.', firstDot + 1);
  if (secondDot <= firstDot + 1) return null;
  let patchEnd = secondDot + 1;
  while (patchEnd < v.length) {
    const code = v.charCodeAt(patchEnd);
    if (code < 48 || code > 57) break;
    patchEnd += 1;
  }
  if (patchEnd === secondDot + 1) return null;
  const major = parseSafeIntSegment(v, 0, firstDot);
  const minor = parseSafeIntSegment(v, firstDot + 1, secondDot);
  const patch = parseSafeIntSegment(v, secondDot + 1, patchEnd);
  // 边界(E9,E7/E8 同族):`\d+` 允许任意长度数字段,`Number('999…999')` 超 Number.MAX_SAFE_INTEGER
  // 变 Infinity/不安全整数,参与兼容比较时语义失真(畸形 plugin manifest 可通过 schema 污染兼容
  // 判断,minLMVersion vs app version 在极端数字下不可靠)。任一段非安全整数即视为非法版本 →
  // 返 null,下方 isVersionCompatible 对 null fail-closed(保守拒载)。
  if (major === null || minor === null || patch === null) {
    return null;
  }
  return [major, minor, patch] as const;
}

/**
 * 把 v[start,end) 的十进制数字串解析为安全整数;含非数字或超出 Number.MAX_SAFE_INTEGER → null。
 * manifest 版本比对与 marketplace semver 共用(`\d+` 任意长时 Number() 会得 Infinity / 不安全整数)。
 */
export function parseSafeIntSegment(
  v: string,
  start: number,
  end: number,
): number | null {
  let n = 0;
  for (let i = start; i < end; i += 1) {
    const code = v.charCodeAt(i);
    if (code < 48 || code > 57) return null;
    n = n * 10 + (code - 48);
    if (!Number.isSafeInteger(n)) return null;
  }
  return n;
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

// ── 准入 ───────────────────────────────────────────────

export type ManifestAdmission =
  | { readonly ok: true; readonly manifest: PluginManifest }
  | {
      readonly ok: false;
      readonly code: 'INVALID_JSON' | 'SCHEMA_ERROR' | 'INCOMPATIBLE_VERSION';
      readonly message: string;
      readonly issues?: readonly ManifestIssue[];
      /** INCOMPATIBLE_VERSION:插件要求的最低版本与当前应用版本(界面本地化用)。 */
      readonly params?: Readonly<Record<string, string>>;
    };

/** 已解析 manifest 的版本兼容准入:minLMVersion(若声明)不高于应用版本 appVersion(由调用方传入)。 */
export function admitManifestVersion(manifest: PluginManifest, appVersion: string): ManifestAdmission {
  const { minLMVersion } = manifest;
  if (minLMVersion !== undefined && !isVersionCompatible(appVersion, minLMVersion)) {
    return {
      ok: false,
      code: 'INCOMPATIBLE_VERSION',
      message: `minLMVersion ${minLMVersion} > app ${appVersion}`,
      params: { required: minLMVersion, current: appVersion },
    };
  }
  return { ok: true, manifest };
}

/**
 * 插件准入:manifest schema 合法 + admitManifestVersion。renderer 列举/热重载与 main 安装(installFromGit 先
 * parseManifest 再 admitManifestVersion)同一口径,保证「能装上的」就是「能载入的」。
 */
export function admitManifest(manifestText: string, appVersion: string): ManifestAdmission {
  const parsed = parseManifest(manifestText);
  return parsed.ok ? admitManifestVersion(parsed.data, appVersion) : parsed;
}
