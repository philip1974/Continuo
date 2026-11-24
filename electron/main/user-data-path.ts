import path from 'node:path';

export interface UserDataPathOptions {
  readonly appDataPath: string;
  readonly e2eUserDataDir: string;
  readonly isDev: boolean;
  readonly isE2E: boolean;
}

export function resolveUserDataPath({
  appDataPath,
  e2eUserDataDir,
  isDev,
  isE2E,
}: UserDataPathOptions): string | null {
  if (isE2E && e2eUserDataDir.trim() !== '') {
    return e2eUserDataDir;
  }

  if (isDev) {
    return path.join(appDataPath, 'Continuo Dev');
  }

  return null;
}

// 两种发行形态的 userData 目录名(同在 appData 下;与 scripts/continuo-mcp-stdio.mjs 的推导一致,规范钉住逐字相同)。
// 打包版 = app.name = package.json `name`(小写 `continuo`):electron-builder 的 productName 只用于安装包 / 显示名,不写入
// app.asar 的 package.json,打包版也不 setName。此前写成 `Continuo`,在大小写敏感的 Linux 上 bridge 找不到 socket、
// 受保护根也匹配不上打包版的 userData(macOS / Windows 默认不区分大小写,未暴露)。
export const PACKAGED_USER_DATA_NAME = 'continuo';
const DEV_USER_DATA_NAME = 'Continuo Dev';

export interface ProtectedRootsOptions {
  /** 本实例实际使用的 userData(含 e2e 的 --user-data-dir、用户自定义位置)。 */
  readonly userDataPath: string;
  readonly appDataPath: string;
  readonly isPackaged: boolean;
  /** process.resourcesPath */
  readonly resourcesPath: string;
  readonly platform: NodeJS.Platform;
}

/**
 * 插件 path-scope 的受保护根(PathScopeRegistry 的 protectedRoots):应用自身的数据与程序文件,
 * 任何已授 scope 都不覆盖它们(见 src/__tests__/plugin-fs-protected-roots/README.md)。
 *  - 本实例的 userData;
 *  - 两种发行形态在默认位置的 userData(dev 实例里的插件不能改 packaged 实例的权限文件,反之亦然);
 *  - 打包版的安装目录:macOS 是整个 `.app` 包,其它平台是 resources 的上级(可执行文件与 resources 同在其中)。
 *    dev 下不加 —— 那是仓库里的 node_modules/electron,开发者可能就在仓库里工作。
 */
export function resolveProtectedRoots({
  userDataPath,
  appDataPath,
  isPackaged,
  resourcesPath,
  platform,
}: ProtectedRootsOptions): string[] {
  const roots = [userDataPath];
  if (appDataPath !== '') {
    roots.push(
      path.join(appDataPath, PACKAGED_USER_DATA_NAME),
      path.join(appDataPath, DEV_USER_DATA_NAME),
    );
  }
  if (isPackaged && resourcesPath !== '') {
    roots.push(resourcesPath);
    const installDir =
      platform === 'darwin'
        ? path.dirname(path.dirname(resourcesPath)) // <X>.app/Contents/Resources → <X>.app
        : path.dirname(resourcesPath);
    if (platform !== 'darwin' || installDir.endsWith('.app')) roots.push(installDir);
  }
  return [...new Set(roots.filter((r) => r !== ''))];
}
