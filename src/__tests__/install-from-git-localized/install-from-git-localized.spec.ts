// 三个「从 Git 安装」入口共用的结果归一:全新安装(非 overwrite)撞 EEXIST → alreadyInstalled(如实提示已安装、重启后加载);
// 覆盖安装 / 其它错误码不标。仓库名取自 URL 末段(去 .git)。
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ install: vi.fn() }));
vi.mock('@/lib/co-api', () => ({ coApi: { plugins: { installFromGit: h.install } } }));

import { installFromGitLocalized, repoNameFromGitUrl } from '../../plugins/install-from-git';

afterEach(() => h.install.mockReset());

describe('installFromGitLocalized · alreadyInstalled', () => {
  it('全新安装 EEXIST → alreadyInstalled=true;overwrite 或其它码 → false', async () => {
    h.install.mockResolvedValue({ ok: false, code: 'EEXIST', message: 'x' });
    expect(await installFromGitLocalized('u')).toMatchObject({ ok: false, alreadyInstalled: true });
    expect(await installFromGitLocalized('u', true)).toMatchObject({ ok: false, alreadyInstalled: false });
    h.install.mockResolvedValue({ ok: false, code: 'CLONE_FAILED', message: 'x' });
    expect(await installFromGitLocalized('u')).toMatchObject({ ok: false, alreadyInstalled: false });
  });

  it('reject 带 EEXIST 同样标记', async () => {
    h.install.mockRejectedValue(Object.assign(new Error('x'), { code: 'EEXIST' }));
    expect(await installFromGitLocalized('u')).toMatchObject({ ok: false, alreadyInstalled: true });
  });
});

describe('repoNameFromGitUrl', () => {
  it.each([
    ['https://github.com/x/cool-ext.git', 'cool-ext'],
    ['https://github.com/x/cool-ext', 'cool-ext'],
    ['https://github.com/x/cool-ext/', 'cool-ext'],
    ['git@github.com:x/repo.git', 'repo'],
  ])('%s → %s', (url, name) => {
    expect(repoNameFromGitUrl(url)).toBe(name);
  });
});
