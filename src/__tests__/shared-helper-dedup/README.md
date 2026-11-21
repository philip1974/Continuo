# shared-helper-dedup(重构:重复 helper 收口为单一来源)

## 行为契约

多处逐字复制的小 helper 是隐藏的漂移 / 复发源(修一份漏其余)。本主题把它们收口到单一来源,
并用**接线守卫**(静态扫描)防止副本复活。行为与收口前逐字等价。

### 规则

1. `lowerIfNeeded`(`electron/shared/lower-if-needed.ts`):结果恒等于 `value.toLowerCase()`;
   输入无 ASCII 大写且无非 ASCII 字符时原样返回同一引用。renderer / main 不得再本地定义同名函数
   (`marketplace/filter.ts` 的非字符串兜底包装除外;file-icon / CodeEditor 的扩展名小写也走它)。
2. 路径字符级 helper(`isPathSeparatorCode` / `isAsciiAlphaCode` / `isBareWindowsDrive` /
   `trimTrailingSeparators`):renderer 单一来源 `src/lib/path-cross.ts`;Explorer `path-utils`、
   Editor `editor-path-utils` / `link-resolve` 只导入不复制。
3. plugin id 形态校验(`isValidPluginId`):跨进程单一来源 `electron/shared/plugin-id.ts`;
   renderer `src/plugins/plugin-id.ts`(re-export)、main `plugins.service.isSafePluginId`、
   `plugin-data-store.service.assertPluginId` 均委托它。
4. ECMA 空白码点判定(`isEcmaWhitespaceCode` / `isBlankString` / `trimStringToMax`):跨进程单一来源
   `electron/shared/ecma-whitespace.ts`,集合恒等于 JS 正则 `\s`;renderer `blank-string` / `text-stats` /
   `CommandRegistry` 与 main `mcp-stdio-server` / `mcp-tools-hook-bridge` 只导入不复制。
5. i18n 字典与 `{param}` 插值(`LOCALE_DICTS` / `hasTranslateParams` / `interpolateTemplate`):跨进程
   单一来源 `electron/shared/i18n-interpolate.ts`;renderer `translate` 与 main `getMainT` 共用。
6. `runSerialPerKey`:跨进程单一来源 `electron/shared/run-serial-per-key.ts`;renderer
   `src/lib/serialize-per-key.ts` 与 main `services/serialize-per-key.ts` 均 re-export 同一函数。
7. 「弹原生目录选择器 → 切 workspace root」:Explorer 两个入口(EmptyWorkspace「打开文件夹」/
   ExplorerHeader「切换文件夹」)共用 `hooks/useSelectWorkspaceFolder`(单飞闸门 R106 + 过期守卫 R27 +
   失败反馈 A146;行为契约见 `empty-workspace` / `explorer-header` / `workspace-root-selection-guard`)。
8. catch 分支失败反馈:`errorCodeOf(err)`(`electron/shared/error-message.ts`)取稳定错误码(无 → `'EXCEPTION'`);
   `notifyThrownError(err)`(`src/notifications/notify-thrown-error.ts`)按 code 本地化后 `notify.error`
   并附 code,抛出值无 message 时回退 code(不弹空 toast)。renderer 不再手写
   `(err as { code?: string })?.code ?? 'EXCEPTION'`。
