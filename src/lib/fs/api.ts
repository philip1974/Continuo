// 把 ContinuoApi['fs'] 抽出独立类型,renderer 端组件可只 import FsApi
// 不带上 layout / popout 等无关命名空间。

import type { ContinuoApi } from '../../../electron/preload';

export type FsApi = ContinuoApi['fs'];

/**
 * 在组件里这样用(等 Step 4 的 useTree dataLoader):
 *
 *   import type { FsApi } from '@/lib/fs/api';
 *   import { coApi } from '@/lib/co-api';
 *   const fs: FsApi = coApi.fs;
 *   const r = await fs.listDir('/foo');
 *   if (r.ok) {
 *     for (const entry of r.data) console.log(entry.name);
 *   }
 */
