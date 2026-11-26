// 三个「从 Git 安装」入口共用的结果归一:全新安装(非 overwrite)撞 EEXIST → alreadyInstalled(如实提示已安装、重启后加载);
// 覆盖安装 / 其它错误码不标。仓库名取自 URL 末段(去 .git)。
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ install: vi.fn() }));
vi.mock('@/lib/co-api', () => ({ coApi: { plugins: { installFromGit: h.install } } }));

import { gitFailureDetail, installFromGitLocalized, repoNameFromGitUrl } from '../../plugins/install-from-git';

afterEach(() => h.install.mockReset());

describe('installFromGitLocalized · alreadyInstalled', () => {
  it('全新安装 EEXIST → alreadyInstalled=true;overwrite 或其它码 → false', async () => {
    h.install.mockResolvedValue({ ok: false, code: 'EEXIST', message: 'x' });
    expect(await installFromGitLocalized('u')).toMatchObject({ ok: false, alreadyInstalled: true });
    expect(await installFromGitLocalized('u', true)).toMatchObject({ ok: false, alreadyInstalled: false });
    h.install.mockResolvedValue({ ok: false, code: 'CLONE_FAILED', message: 'x' });
    expect(await installFromGitLocalized('u')).toMatchObject({ ok: false, alreadyInstalled: false });
  });

  it('EEXIST 带回 details(id / name / version)→ existing;缺字段 / 无 details → 无 existing', async () => {
    h.install.mockResolvedValue({
      ok: false,
      code: 'EEXIST',
      message: 'x',
      details: { id: 'acme.tools', name: 'Acme Tools', version: '1.1.0' },
    });
    expect(await installFromGitLocalized('u')).toMatchObject({
      ok: false,
      alreadyInstalled: true,
      existing: { id: 'acme.tools', name: 'Acme Tools', version: '1.1.0' },
    });
    h.install.mockResolvedValue({ ok: false, code: 'EEXIST', message: 'x', details: { id: 'acme.tools' } });
    expect(await installFromGitLocalized('u')).not.toHaveProperty('existing');
    h.install.mockResolvedValue({ ok: false, code: 'EEXIST', message: 'x' });
    expect(await installFromGitLocalized('u')).not.toHaveProperty('existing');
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

// GIT_FAILED 的本地化标题会整段替换 main 原文 → 附上 git 的报错行,否则断网 / 404 / 需鉴权 / 分支不存在都只显示「Git 命令失败」。
describe('installFromGitLocalized · GIT_FAILED 保留 git 报错', () => {
  it('附上 stderr 中的 fatal 行', async () => {
    h.install.mockResolvedValue({
      ok: false,
      code: 'GIT_FAILED',
      message: "git clone exit 128: Cloning into 'x'...\nfatal: repository 'https://h/x/' not found",
    });
    const r = await installFromGitLocalized('u');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain("fatal: repository 'https://h/x/' not found");
  });

  it('gitFailureDetail:优先 fatal / error 行,否则首个非空行;无 stderr → undefined', () => {
    expect(gitFailureDetail('git fetch exit 1: \n  warning: x\nerror: pathspec y\n')).toBe('error: pathspec y');
    expect(gitFailureDetail('git clone exit 128: Could not resolve host: h')).toBe('Could not resolve host: h');
    expect(gitFailureDetail('git clone exit 1: ')).toBeUndefined();
    expect(gitFailureDetail(undefined)).toBeUndefined();
  });
});

