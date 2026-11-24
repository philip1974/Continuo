// 组件运行期拼接的「标签: 原因」也随界面语言用对冒号:zh 全角「：」,en / ko 半角「: 」。拼接走 catalog 插值
// `common.label_detail`({label}：{detail} / {label}: {detail}),不在代码里写死半角冒号(catalog 已统一全角,
// 拼接处漏网)。见 README「runtime-label-colon」。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ error: vi.fn(), install: vi.fn() }));
vi.mock('../../notifications/notify', () => ({ notify: { error: h.error } }));
vi.mock('@/lib/co-api', () => ({ coApi: { plugins: { installFromGit: h.install } } }));

import { setLocale } from '../../i18n/translate';
import { runContributedAction } from '../../lib/run-contributed-action';
import { notifyOpenFailed } from '../../notifications/notify-open-failed';
import { installFromGitLocalized } from '../../plugins/install-from-git';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

beforeEach(() => {
  h.error.mockReset();
  h.install.mockReset();
});
afterEach(() => setLocale('en'));

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('运行期「标签: 原因」拼接的冒号随语言', () => {
  it.each([
    ['zh', '格式化文档：boom'],
    ['en', '格式化文档: boom'],
    ['ko', '格式化文档: boom'],
  ] as const)('%s:贡献 action 失败提示', async (locale, expected) => {
    setLocale(locale);
    runContributedAction('格式化文档', () => {
      throw new Error('boom');
    });
    await flush();
    expect(h.error).toHaveBeenCalledWith(expected);
  });

  it('zh:打开文件失败提示用全角冒号;en 半角', () => {
    setLocale('zh');
    notifyOpenFailed('a.md', { code: 'NO_SUCH_CODE_X', message: 'disk on fire' });
    expect(h.error).toHaveBeenLastCalledWith('打开失败 a.md：disk on fire', { code: 'NO_SUCH_CODE_X' });
    setLocale('en');
    notifyOpenFailed('a.md', { code: 'NO_SUCH_CODE_X', message: 'disk on fire' });
    expect(h.error).toHaveBeenLastCalledWith('Failed to open a.md: disk on fire', { code: 'NO_SUCH_CODE_X' });
  });

  it('zh:从 Git 安装失败附 git 报错行时用全角冒号', async () => {
    setLocale('zh');
    h.install.mockResolvedValue({ ok: false, code: 'GIT_FAILED', message: 'git clone exit 128: fatal: not found' });
    const r = await installFromGitLocalized('u');
    expect(!r.ok && r.message).toBe('Git 命令失败：fatal: not found');
  });
});

/** renderer 源码(不含测试)。 */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== '__tests__') out.push(...sources(p));
    } else if (/\.tsx?$/.test(name) && !/\.(spec|test)\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('守卫:不在代码里把翻译文案与半角冒号拼接', () => {
  // `${t('x')}: ${…}`(模板)与 `{t('x')}:{' '}`(JSX)。
  const PATTERNS = [/\$\{(?:t|translate|tWithFallback)\([^`]*?\)\}: /, /\{(?:t|translate)\([^{}]*\)\}:/];

  it('规则本身有鉴别力', () => {
    expect(PATTERNS[0]!.test("notify.warn(`${t('editor.autosave_failed')}: ${x}`)")).toBe(true);
    expect(PATTERNS[1]!.test("{t('permissions.fs_scope.mode_label')}:{' '}")).toBe(true);
    expect(PATTERNS.some((re) => re.test("t('common.label_detail', { label, detail })"))).toBe(false);
  });

  it('renderer 源码无此类拼接', () => {
    const hits: string[] = [];
    for (const file of sources(SRC_ROOT)) {
      const text = readFileSync(file, 'utf-8');
      text.split('\n').forEach((line, i) => {
        if (PATTERNS.some((re) => re.test(line))) hits.push(`${path.relative(SRC_ROOT, file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
