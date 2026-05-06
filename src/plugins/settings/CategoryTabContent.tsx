// 渲染某 category 下所有 SettingItemSpec 的列表(M-Settings v6)。
// 通用:不同 category(general / editor / ...)只是 prop 不同,这一份组件复用。

import { useEffect, useState } from 'react';
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
  useEffect(
    () => reg.subscribe(() => setSnap(reg.getByCategory(category))),
    [reg, category],
  );
  return snap;
}

export function CategoryTabContent({
  category,
  registry = coApp.settingItems,
}: CategoryTabContentProps) {
  const items = useItems(registry, category);
  if (items.length === 0) {
    return <div className="text-fg-dim">本类暂无设置项</div>;
  }
  return (
    <div className="flex flex-col">
      {items.map((spec) => (
        <SettingItemRow key={spec.id} spec={spec} />
      ))}
    </div>
  );
}
