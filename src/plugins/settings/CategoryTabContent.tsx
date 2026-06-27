// 渲染某 category 下所有 SettingItemSpec 的列表(M-Settings v6)。
// 通用:不同 category(general / editor / ...)只是 prop 不同,这一份组件复用。
// 同 category 内可按 spec.group 分组,group 出现顺序由首项 priority 决定;
// 无 group 的项归 default bucket(无 header,渲染在最前)。

import { useMemo } from 'react';
import { coApp } from '@/plugins/co-app';
import { useT } from '@/i18n';
import { useRegistry } from '../registries/useRegistry';
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
  // category 进 deps:切换 tab 复用同 component 时 selector 闭包要重新跑
  return useRegistry(reg, () => reg.getByCategory(category), [category]);
}

interface Bucket {
  /** undefined = default bucket(无 header).group 是身份 key,不直接展示. */
  readonly group: string | undefined;
  /** i18n key,渲染 header 时 t(groupKey) 优先于 group 字面量. */
  readonly groupKey: string | undefined;
  readonly items: readonly SettingItemSpec[];
}

/** 按 spec.group 分组,保留 priority 顺序. group 出现顺序由首项决定. */
export function groupItems(items: readonly SettingItemSpec[]): Bucket[] {
  if (items.length === 0) return [];
  if (items.length === 1) {
    const spec = items[0]!;
    return [
      {
        group: spec.group,
        groupKey: spec.groupKey,
        items,
      },
    ];
  }

  const map = new Map<
    string | undefined,
    { groupKey: string | undefined; items: SettingItemSpec[]; count: number }
  >();
  for (const spec of items) {
    const key = spec.group;
    let entry = map.get(key);
    if (!entry) {
      entry = {
        groupKey: spec.groupKey,
        items: new Array<SettingItemSpec>(items.length),
        count: 0,
      };
      map.set(key, entry);
    }
    entry.items[entry.count++] = spec;
  }
  const buckets = new Array<Bucket>(map.size);
  let i = 0;
  for (const [group, entry] of map) {
    entry.items.length = entry.count;
    buckets[i++] = {
      group,
      groupKey: entry.groupKey,
      items: entry.items,
    };
  }
  return buckets;
}

export function CategoryTabContent({
  category,
  registry = coApp.settingItems,
}: CategoryTabContentProps) {
  const t = useT();
  const items = useItems(registry, category);
  const buckets = useMemo(() => groupItems(items), [items]);
  if (items.length === 0) {
    return <div className="text-fg-dim">{t('settings.category.empty')}</div>;
  }
  return (
    <div className="flex flex-col">
      {buckets.map((bucket) => (
        <section
          key={bucket.group ?? '_default'}
          className="first:mt-0 [&:not(:first-child)]:mt-10"
        >
          {bucket.group && (
            <h3 className="mb-3 border-b border-line pb-3 text-base font-medium text-fg">
              {bucket.groupKey ? t(bucket.groupKey) : bucket.group}
            </h3>
          )}
          {bucket.items.map((spec) => (
            <SettingItemRow
              key={spec.id}
              spec={spec}
              // race(R58):写前 live 复查 setting 仍注册(快照可能滞后于 unregister)。
              isStillRegistered={(id) => registry.get(id) !== undefined}
            />
          ))}
        </section>
      ))}
    </div>
  );
}
