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
import { groupKeepingOrder } from '@/lib/group-keeping-order';
import { usePluginNameOf } from '../use-user-plugin-list';
import { isPluginSettingItem, settingSectionOf } from './plugin-setting-sections';

interface CategoryTabContentProps {
  readonly category: string;
  /** 默认用全局 coApp.settingItems;测试可注入隔离 registry. */
  readonly registry?: SettingItemRegistry;
}

interface Bucket {
  /** undefined = default bucket(无 header).group 是身份 key,不直接展示. */
  readonly group: string | undefined;
  /** i18n key,渲染 header 时 t(groupKey) 优先于 group 字面量. */
  readonly groupKey: string | undefined;
  readonly items: readonly SettingItemSpec[];
}

const EMPTY_BUCKETS: Bucket[] = [];

/** 按 spec.group 分组,保留 priority 顺序. group 出现顺序由首项决定. */
export function groupItems(items: readonly SettingItemSpec[]): Bucket[] {
  if (items.length === 0) return EMPTY_BUCKETS;
  // 按 group 分组;groupKey 取该组首项的(同组各项的 groupKey 相同)。
  const groups = groupKeepingOrder(items, (spec) => spec.group);
  const buckets = new Array<Bucket>(groups.length);
  for (let i = 0; i < groups.length; i++) {
    const { key: group, items: groupItems } = groups[i]!;
    buckets[i] = { group, groupKey: groupItems[0]!.groupKey, items: groupItems };
  }
  return buckets;
}

export function CategoryTabContent({
  category,
  registry = coApp.settingItems,
}: CategoryTabContentProps) {
  const t = useT();
  // category 进 deps:切换 tab 复用同 component 时 selector 闭包要重新跑
  const items = useRegistry(registry, () => registry.getByCategory(category), [category]);
  if (items.length === 0) {
    return <div className="text-fg-dim">{t('settings.category.empty')}</div>;
  }
  return (
    <div className="flex flex-col">
      <SettingItemBuckets items={items} registry={registry} headingLevel={3} />
    </div>
  );
}

/** 按 group 分组渲染一组设置项(组标题 h3;放在插件节内时 h4)。 */
function SettingItemBuckets({
  items,
  registry,
  headingLevel,
}: {
  readonly items: readonly SettingItemSpec[];
  readonly registry: SettingItemRegistry;
  readonly headingLevel: 3 | 4;
}) {
  const t = useT();
  const buckets = useMemo(() => groupItems(items), [items]);
  const Heading = headingLevel === 3 ? 'h3' : 'h4';
  return buckets.map((bucket) => (
    <section
      key={bucket.group ?? '_default'}
      className="first:mt-0 [&:not(:first-child)]:mt-10"
    >
      {bucket.group && (
        <Heading
          className={
            headingLevel === 3
              ? 'mb-3 border-b border-line pb-3 text-base font-medium text-fg'
              : 'mb-2 text-sm font-medium text-fg'
          }
        >
          {bucket.groupKey ? t(bucket.groupKey) : bucket.group}
        </Heading>
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
  ));
}

/**
 * 「插件设置」页签(BDD: src/__tests__/plugin-settings-section/):内置 category 之外的设置项按所属插件分节,
 * 节标题为插件名(对齐 VSCode 设置编辑器「扩展 › <扩展名>」),节内仍按 group 分组。
 */
export function PluginSettingsTabContent({
  registry = coApp.settingItems,
}: {
  readonly registry?: SettingItemRegistry;
}) {
  const t = useT();
  const all = useRegistry(registry);
  const nameOf = usePluginNameOf();
  const sections = useMemo(() => {
    const own = all.filter(isPluginSettingItem);
    const groups = groupKeepingOrder(own, (spec) => settingSectionOf(spec, nameOf).key);
    return groups.map(({ key, items }) => ({ key, label: settingSectionOf(items[0]!, nameOf).label, items }));
  }, [all, nameOf]);
  if (sections.length === 0) {
    return <div className="text-fg-dim">{t('settings.category.empty')}</div>;
  }
  return (
    <div className="flex flex-col">
      {sections.map((section) => (
        <section key={section.key} className="first:mt-0 [&:not(:first-child)]:mt-10">
          <h3 className="mb-3 border-b border-line pb-3 text-base font-medium text-fg">{section.label}</h3>
          <div>
            <SettingItemBuckets items={section.items} registry={registry} headingLevel={4} />
          </div>
        </section>
      ))}
    </div>
  );
}
