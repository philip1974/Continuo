# leaf-name-guard(E274,E268 收口)

## 行为契约

单段 leaf 文件名校验收口到 `electron/shared/leaf-name.ts` 的 `leafNameRejectReason` / `isValidLeafName`,
作为 **plugin-fs 写路径 validateLeaf** 与 **Explorer drop/create/rename(isValidLeafName / main
assertValidBasename)** 的单一来源(消漂移)。

E268 初版只拒 空/`.`/`..`/分隔符/控制字符/超长;E274 补齐 plugin-fs validateLeaf 的最强规则集:
NTFS 8.3 短名(`~[0-9]`)、任意 `~`、`..` 子串、`:`(Windows ADS)、Windows 保留设备名(CON/NUL/...)、
尾随点/空格、非 NFC。策略(cross-platform-p0):POSIX 上虽合法的名也统一拒,保证工作区可移植。

### 规则

1. `isValidLeafName` 拒上述全部危险名;`leafNameRejectReason` 返回逐字与原 validateLeaf 一致的原因。
2. `path-resolve.helper.ts` 的 validateLeaf 委托共享 `leafNameRejectReason`(消漂移,接线守卫断言)。
