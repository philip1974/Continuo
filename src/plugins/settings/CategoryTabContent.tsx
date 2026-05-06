// 渲染某 category 下所有 SettingItemSpec 的列表(M-Settings v6)。
// 通用:不同 category(general / editor / ...)只是 prop 不同,这一份组件复用。
// 同 category 内可按 spec.group 分组,group 出现顺序由首项 priority 决定;
// 无 group 的项归 default bucket(无 header,渲染在最前)。

import { useEffect, useMemo, useState } from 'react';
import { coApp } from '@/plugins/co-app';
import type {
  SettingItemRegistry,
  SettingItemSpec,
} from '../registries/SettingItemRegistry';
import { SettingItemRow } from './SettingItemRow';

interface CategoryTabContentProps {
  readonly category: string;
  /** 默认用全局 coApp.settingItems;测试可注入隔离 registry. */
  readonly registry?: SettingItemRegistry;
}

function useItems(
  reg: SettingItemRegistry,
  category: string,
): readonly SettingItemSpec[] {
  const [snap, setSnap] = useState(() => reg.getByCategory(category));
  // category 变化时同步更新 snap;否则 React 复用同类型组件实例,useState
  // lazy init 不再跑(通用/编辑器/资源管理器/终端 都是 CategoryTabContent,
  // 切换时若不在此 effect 内 setSnap,会显示前一 tab 的内容)。
  useEffect(() => {
    setSnap(reg.getByCategory(category));
    return reg.subscribe(() => setSnap(reg.getByCategory(category)));
  }, [reg, category]);
  return snap;
}

interface Bucket {
  /** undefined = default bucket(无 header). */
  readonly group: string | undefined;
  readonly items: readonly SettingItemSpec[];
}

/** 按 spec.group 分组,保留 priority 顺序. group 出现顺序由首项决定. */
function groupItems(items: readonly SettingItemSpec[]): Bucket[] {
  const map = new Map<string | undefined, SettingItemSpec[]>();
  for (const spec of items) {
    const key = spec.group;
    let arr = map.get(key);
    if (!arr) {
      arr = [];
      map.set(key, arr);
    }
    arr.push(spec);
  }
  return Array.from(map.entries()).map(([group, items]) => ({ group, items }));
}

export function CategoryTabContent({
  category,
  registry = coApp.settingItems,
}: CategoryTabContentProps) {
  const items = useItems(registry, category);
  const buckets = useMemo(() => groupItems(items), [items]);
  if (items.length === 0) {
    return <div className="text-fg-dim">本类暂无设置项</div>;
  }
  return (
    <div className="flex flex-col">
      {buckets.map((bucket) => (
        <section
          key={bucket.group ?? '_default'}
          className="mb-2 first:mt-0 [&:not(:first-child)]:mt-8"
        >
          {bucket.group && (
            <h3 className="mb-2 border-b border-line pb-2 text-base font-medium text-fg">
              {bucket.group}
            </h3>
          )}
          {bucket.items.map((spec) => (
            <SettingItemRow key={spec.id} spec={spec} />
          ))}
        </section>
      ))}
    </div>
  );
}
