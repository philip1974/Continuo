// 边界(E236,E79/E54 注册表数量上限族):插件贡献类注册表的条目数量上限,收口为共享 helper 消除漂移。
//
// 各 registry(Command / EditorAction / ExplorerContextMenu / Panel / Ribbon / SettingItem /
// SettingTab / StatusBar)此前只校验**单条** spec 的字段长度/形态(E35/E37/E153 等),无**数量**上限。
// 畸形/恶意插件可循环注册大量合法小条目,items Map 无界增长 → getAll() 全量 Array.from + 命令面板/UI
// 搜索排序 + 全局 hotkey 扫描被线性放大 → renderer 卡顿/内存上涨。register 前统一查容量,超限抛、不入表。
// (ExplorerDecoratorRegistry 用数组 + 自带 MAX_DECORATORS,已先行,见 E54;此 helper 收口其余 Map 型。)

export const MAX_REGISTRY_ITEMS = 1024; // 单注册表条目数上限(远超任何真实插件贡献集合)

/**
 * 注册前容量守卫。覆盖既有 id(isExistingId=true)不增长条目数 → 放行;新增 id 且已达上限 → 抛错。
 * 在各 registry 的 register() 校验单条 spec 之后、items.set 之前调用。
 */
export function assertRegistryCapacity(
  registryName: string,
  currentSize: number,
  isExistingId: boolean,
): void {
  if (isExistingId) return; // 覆盖既有条目不增长,放行
  if (currentSize >= MAX_REGISTRY_ITEMS) {
    throw new Error(
      `[${registryName}] too many registered items (>= ${MAX_REGISTRY_ITEMS})`,
    );
  }
}
