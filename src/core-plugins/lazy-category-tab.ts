// 通用 / 编辑器 / 资源管理器 / 终端 四个设置 tab 共用的懒加载内容(perf:不把 CategoryTabContent 与
// SettingItemRow 等控件打进 main-app 启动包;四个 tab 共享一个 chunk)。模式同 KeybindingsTabPlugin。

import { lazy } from 'react';
import type { ReactNode } from 'react';
import { lazyPanel } from '@/lib/lazy-panel';

const CategoryTabContent = lazy(() =>
  import('@/plugins/settings/CategoryTabContent').then((m) => ({
    default: m.CategoryTabContent,
  })),
);

// 模块级只包一次:render 每次返回同一组件类型(渲染期新建会让 tab 内容随父组件重渲而卸载重挂)。
const CategoryTab = lazyPanel(CategoryTabContent);

export function renderCategoryTab(category: string): ReactNode {
  return CategoryTab({ category });
}
