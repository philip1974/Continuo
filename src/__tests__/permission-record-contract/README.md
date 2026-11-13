# permission-record-contract(权限记录单条形态的跨进程统一规则)

## 行为契约

`_permissions.json` / path scope 的单条形态此前有三套手写校验(main 读盘、renderer 读端、request-scope 入口)
加一套 IPC zod schema,且已漂移。统一为 `electron/shared/permission-record.ts` 的两个谓词,四处同一规则:

1. decision:`permission` 必须是 `PERMISSION_KEYS` 成员;`granted` 为 boolean;`decidedAt` 有限且**非负**。
2. path scope:`path` **非空**且 ≤ `SCOPE_PATH_MAX`;`mode` 为 `'r' | 'rw'`。
3. main 写端的 plugin id 也按读端同一上限(`PLUGIN_ID_MAX_LEN`)校验 —— 否则超长合法字符 id「写成功、读回被丢」。
4. 接线:main `plugins.service`、renderer `IpcPermissionStore` 都委托 shared 谓词;IPC schema 用同一枚举与下限。
