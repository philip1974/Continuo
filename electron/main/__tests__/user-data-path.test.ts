import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PACKAGED_USER_DATA_NAME, resolveProtectedRoots, resolveUserDataPath } from '../user-data-path';

describe('resolveUserDataPath', () => {
  it('honors E2E --user-data-dir before the dev default', () => {
    expect(
      resolveUserDataPath({
        appDataPath: '/tmp/app-data',
        e2eUserDataDir: '/tmp/e2e-user-data',
        isDev: true,
        isE2E: true,
      }),
    ).toBe('/tmp/e2e-user-data');
  });

  it('keeps the separate dev userData path outside E2E', () => {
    expect(
      resolveUserDataPath({
        appDataPath: '/tmp/app-data',
        e2eUserDataDir: '/tmp/e2e-user-data',
        isDev: true,
        isE2E: false,
      }),
    ).toBe(path.join('/tmp/app-data', 'Continuo Dev'));
  });

  it('leaves packaged userData untouched without an E2E override', () => {
    expect(
      resolveUserDataPath({
        appDataPath: '/tmp/app-data',
        e2eUserDataDir: '',
        isDev: false,
        isE2E: false,
      }),
    ).toBeNull();
  });
});

describe('resolveProtectedRoots(插件 path-scope 的受保护根)', () => {
  const appData = path.join(path.sep, 'home', 'u', 'AppSupport');
  const base = {
    userDataPath: path.join(appData, 'Continuo Dev'),
    appDataPath: appData,
    isPackaged: false,
    resourcesPath: path.join(path.sep, 'repo', 'node_modules', 'electron', 'dist', 'resources'),
    platform: 'darwin' as NodeJS.Platform,
  };

  it('dev:本实例 userData + 两种发行形态的默认 userData;不含 resourcesPath(仓库目录)', () => {
    expect(resolveProtectedRoots(base).sort()).toEqual(
      [path.join(appData, 'continuo'), path.join(appData, 'Continuo Dev')].sort(),
    );
  });

  it('e2e / 自定义位置的 userData 也列入', () => {
    const custom = path.join(path.sep, 'tmp', 'e2e-user-data');
    expect(resolveProtectedRoots({ ...base, userDataPath: custom })).toEqual([
      custom,
      path.join(appData, 'continuo'),
      path.join(appData, 'Continuo Dev'),
    ]);
  });

  it('打包版 macOS:加 resourcesPath 与整个 .app 包', () => {
    const bundle = path.join(path.sep, 'Applications', 'Continuo.app');
    const resourcesPath = path.join(bundle, 'Contents', 'Resources');
    const roots = resolveProtectedRoots({ ...base, isPackaged: true, resourcesPath });
    expect(roots).toContain(resourcesPath);
    expect(roots).toContain(bundle);
  });

  it('打包版 macOS 但 resourcesPath 不在 .app 包里 → 只加 resourcesPath,不把上两级目录当安装目录', () => {
    const resourcesPath = path.join(path.sep, 'opt', 'odd', 'Resources');
    const roots = resolveProtectedRoots({ ...base, isPackaged: true, resourcesPath });
    expect(roots).toContain(resourcesPath);
    expect(roots).not.toContain(path.join(path.sep, 'opt'));
  });

  it('打包版 Windows / Linux:加 resourcesPath 及其上级(可执行文件所在的安装目录)', () => {
    const install = path.join(path.sep, 'opt', 'Continuo');
    const resourcesPath = path.join(install, 'resources');
    const roots = resolveProtectedRoots({ ...base, isPackaged: true, resourcesPath, platform: 'linux' });
    expect(roots).toContain(resourcesPath);
    expect(roots).toContain(install);
  });

  it('空路径不产生受保护根', () => {
    expect(
      resolveProtectedRoots({ ...base, userDataPath: '', appDataPath: '', isPackaged: true, resourcesPath: '' }),
    ).toEqual([]);
  });
});

// 打包版 userData 目录名的单一来源:= app.name = package.json `name`(productName 只在 electron-builder.yml,不进 app.asar
// 的 package.json,打包版也不 setName)。stdio bridge 脚本不能 import,按字面钉住逐字一致 —— 此前两处写成 `Continuo`,
// Linux(大小写敏感)上 bridge 找不到 socket、受保护根匹配不上打包版 userData。
describe('PACKAGED_USER_DATA_NAME', () => {
  it('等于 package.json name,且 stdio bridge 用同一字面', () => {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as { name: string };
    expect(PACKAGED_USER_DATA_NAME).toBe(pkg.name);
    const bridge = readFileSync(path.join(process.cwd(), 'scripts/continuo-mcp-stdio.mjs'), 'utf8');
    expect(bridge).toContain(`path.join(appSupportDir(), '${PACKAGED_USER_DATA_NAME}', 'mcp.sock')`);
    expect(bridge).toContain(`for (const appName of ['${PACKAGED_USER_DATA_NAME}', 'Continuo Dev'])`);
  });
});

