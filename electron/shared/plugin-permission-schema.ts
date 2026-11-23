// plugins:mutate-permissions 入参中授权增量的 zod schema + 类型单一来源(同 window-create-schema.ts 的做法):
// main 用 schema 校验,plugins-channels 以 `import type` + z.infer 派生 IpcPermissionMutation(类型导入被擦除,preload 不带 zod)。

import { z } from 'zod';
import { PERMISSION_KEYS } from './permission-keys';

// 终审 P1:renderer 只发授权增量(按权限项),不再发整条记录覆盖写 —— 陈旧窗口的整条记录会把别窗的撤销
// 写回。decidedAt 由 main 取当前时间;perms 必须是权限枚举成员,数量不超过枚举大小。
export const PermissionMutationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('set'),
      perms: z.array(z.enum(PERMISSION_KEYS)).min(1).max(PERMISSION_KEYS.length).readonly(),
      granted: z.boolean(),
    })
    .strict()
    .readonly(),
  z.object({ kind: z.literal('clear-denied') }).strict().readonly(),
]);
