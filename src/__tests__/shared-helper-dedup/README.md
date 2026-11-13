# shared-helper-dedup(重构:重复 helper 收口为单一来源)

## 行为契约

多处逐字复制的小 helper 是隐藏的漂移 / 复发源(修一份漏其余)。本主题把它们收口到单一来源,
并用**接线守卫**(静态扫描)防止副本复活。行为与收口前逐字等价。

### 规则

1. `lowerIfNeeded`(`electron/shared/lower-if-needed.ts`):结果恒等于 `value.toLowerCase()`;
   输入无 ASCII 大写且无非 ASCII 字符时原样返回同一引用。renderer / main 不得再本地定义同名函数
   (`file-icon.tsx` 的 ASCII-only 变体与 `marketplace/filter.ts` 的非字符串兜底包装除外,语义不同)。
2. 路径字符级 helper(`isPathSeparatorCode` / `isAsciiAlphaCode` / `isBareWindowsDrive` /
   `trimTrailingSeparators`):renderer 单一来源 `src/lib/path-cross.ts`;Explorer `path-utils`、
   Editor `editor-path-utils` / `link-resolve` 只导入不复制。
3. plugin id 形态校验(`isValidPluginId`):跨进程单一来源 `electron/shared/plugin-id.ts`;
   renderer `src/plugins/plugin-id.ts`(re-export)、main `plugins.service.isSafePluginId`、
   `plugin-data-store.service.assertPluginId` 均委托它。
