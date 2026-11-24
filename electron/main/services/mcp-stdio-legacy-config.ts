// 安全(Linux AppImage 老用户迁移):旧版「复制 MCP 配置」给出的命令指向 AppImage 临时挂载路径
// (`/tmp/.mount_*/resources/continuo-mcp-stdio.mjs`)。执行过 `claude mcp add` 的用户 ~/.claude.json 里仍持久
// 保存着它:Continuo 退出后挂载点消失,同机其他用户可在共享 /tmp 下建同名目录放同名脚本 → 受害者下次启动
// Claude Code 即以自身身份执行。新版只改了之后展示的命令,存量配置需要提示用户自己迁移。
//
// 只读:绝不修改 ~/.claude.json(那是 Claude Code 的文件,并发写有损坏风险;也不该替用户改 agent 配置)。
// 容错:不存在 / 读失败 / 超大 / 解析失败 / 结构畸形 → 一律当无命中跳过。

import os from 'node:os';
import path from 'node:path';
import type { MainT } from '../i18n';
import { readFileCappedFd } from '../lib/read-fh-capped';
import { STDIO_CLI_FILE_NAME, isInUnstableLinuxLocation } from './mcp-stdio-cli-install';
import { asRecord } from '../../shared/as-record';

/** ~/.claude.json 读取上限:它含各项目历史,常达数 MB;超出即跳过检查(不整文件读入主进程)。 */
export const CLAUDE_JSON_MAX_BYTES = 16 * 1024 * 1024;
const MAX_LISTED_NAMES = 5; // 弹框里最多列出的条目名
const MAX_NAME_LEN = 64; // 单个条目名最多显示的 code point 数
/** 可原样拼进 shell 命令的条目名:无空白 / shell 元字符,且不超过显示上限(超限会被截断,拼出的是错名)。 */
const SAFE_CMD_NAME = new RegExp(`^[A-Za-z0-9._-]{1,${MAX_NAME_LEN}}$`);

/**
 * 条目名来自 ~/.claude.json(不可信):C0/C1 控制字符、DEL、U+2028/U+2029 换成 `?`(防 `\n` / NEL /
 * 行分隔符在警告框内伪造行),双向控制符(U+200E/200F、U+202A-202E、U+2066-2069)同样替换(防反转显示),
 * 再按 code point 截断(不切开代理对)。
 */
function displayName(n: string): string {
  const cps = Array.from(
    // eslint-disable-next-line no-control-regex
    n.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '?'),
  );
  return cps.length > MAX_NAME_LEN ? `${cps.slice(0, MAX_NAME_LEN).join('')}…` : cps.join('');
}

function pointsToUnstableCli(v: unknown, tmpDir: string): boolean {
  return (
    typeof v === 'string' &&
    path.posix.basename(v) === STDIO_CLI_FILE_NAME &&
    isInUnstableLinuxLocation(path.posix.dirname(v), tmpDir)
  );
}

function collectFrom(servers: unknown, tmpDir: string, out: Set<string>): void {
  // 非对象 → asRecord 给空对象:无条目 / 无 command、args,自然不命中。
  for (const [name, entry] of Object.entries(asRecord(servers))) {
    const e = asRecord(entry);
    const args = Array.isArray(e['args']) ? (e['args'] as unknown[]) : [];
    if (pointsToUnstableCli(e['command'], tmpDir) || args.some((a) => pointsToUnstableCli(a, tmpDir))) {
      out.add(name);
    }
  }
}

/**
 * 在已解析的 ~/.claude.json 中找 command / args 指向不稳定位置 continuo-mcp-stdio.mjs 的 MCP 条目名。
 * 覆盖顶层 `mcpServers`(user scope)与 `projects.<dir>.mcpServers`(local scope,`claude mcp add` 的默认)。
 */
export function findUnstableStdioCliEntries(config: unknown, tmpDir: string): string[] {
  const root = asRecord(config);
  const out = new Set<string>();
  collectFrom(root['mcpServers'], tmpDir, out);
  for (const proj of Object.values(asRecord(root['projects']))) {
    collectFrom(asRecord(proj)['mcpServers'], tmpDir, out);
  }
  return [...out];
}

/** 只读检查 `<homeDir>/.claude.json`;仅 Linux 生效(AppImage 只在 Linux)。任何读取 / 解析问题 → []。 */
export async function findLegacyUnstableClaudeEntries(opts: {
  readonly homeDir: string;
  readonly platform?: NodeJS.Platform;
  readonly tmpDir?: string;
}): Promise<string[]> {
  if ((opts.platform ?? process.platform) !== 'linux') return [];
  try {
    const r = await readFileCappedFd(path.join(opts.homeDir, '.claude.json'), CLAUDE_JSON_MAX_BYTES);
    if (r.tooLarge || r.text === null) return [];
    return findUnstableStdioCliEntries(JSON.parse(r.text), opts.tmpDir ?? os.tmpdir());
  } catch {
    return [];
  }
}

export interface LegacyConfigDialogOptions {
  readonly type: 'warning';
  readonly message: string;
  readonly detail: string;
  readonly buttons: string[];
  readonly defaultId: number;
  readonly cancelId: number;
  readonly noLink: true;
}

/**
 * 命中存量不安全条目 → 弹警告:列出条目名、指引先 `claude mcp remove` 再执行新命令;有新命令时提供「复制新命令」。
 * electron 依赖(dialog / clipboard)由调用方注入。返回是否命中。从不抛(启动路径 fire-and-forget)。
 */
export async function warnIfLegacyUnstableClaudeConfig(opts: {
  readonly homeDir: string;
  readonly platform?: NodeJS.Platform;
  readonly tmpDir?: string;
  readonly claudeAddCommand?: string;
  readonly t: MainT;
  readonly show: (o: LegacyConfigDialogOptions) => Promise<{ response: number }>;
  readonly writeClipboard: (text: string) => void;
}): Promise<boolean> {
  const names = await findLegacyUnstableClaudeEntries(opts);
  if (names.length === 0) return false;
  const listed = names.slice(0, MAX_LISTED_NAMES).map(displayName);
  // 拼进建议执行的 `claude mcp remove` 命令:只有「纯安全字符且未被截断」的名字原样给出,否则给通用占位
  //(不做 shell 引用:显示名已被净化 / 截断,与真实名不一致,引用了也是错命令;列表里已展示具体条目名)。
  const first = SAFE_CMD_NAME.test(names[0]!) ? names[0]! : '<name>';
  const { t, claudeAddCommand } = opts;
  const buttons = claudeAddCommand
    ? [t('dialog.mcp_legacy_config.copy'), t('common.ok')]
    : [t('common.ok')];
  try {
    const { response } = await opts.show({
      type: 'warning',
      message: t('dialog.mcp_legacy_config.message'),
      detail: t('dialog.mcp_legacy_config.detail', {
        names: listed.join(', ') + (names.length > listed.length ? ', …' : ''),
        first,
      }),
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
      noLink: true,
    });
    if (claudeAddCommand && response === 0) opts.writeClipboard(claudeAddCommand);
  } catch (err) {
    console.warn('[mcp-stdio] legacy ~/.claude.json warning dialog failed', err);
  }
  return true;
}
