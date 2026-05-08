# 模块冻结 Checklist · dock

> 冻结后**任何变更必须先在本文档追加 ADR**。dock 是 Continuo Shell 多窗格骨架,
> 上面叠了 Editor / Explorer / Terminal / Output / 插件贡献的所有 panel,
> 改动放射半径大,谨慎。

## 1. 模块身份

- **模块名**:`dock`
- **覆盖代码**:
  - `src/shell/dock/**`(DockShell / SharedTab / HeaderActions / PanelMount 等)
  - `src/lib/lazy-panel.tsx`(Suspense 包装)
  - `electron/main/services/window.service.ts`(popout BrowserWindow 复用)
  - `electron/main/ipc/popout/**`(popout:open / popout:close 通道)
- **冻结日期**:2026-05-08
- **冻结发起人**:limu7475@gmail.com

## 2. 稳定行为契约

- [ ] 任意 tab 可拖到任意位置形成新 group,关闭一个 tab 重启后保留关闭状态
- [ ] `app.getPath('userData')/layout.json` 是 dock 状态唯一真源
- [ ] 删除 `layout.json` → 自动落回 `defaultLayout`,不崩溃
- [ ] popout 出去的 panel 关闭独立窗口后,主窗口 dock 状态正确
- [ ] `co-api` 暴露的 dock API(focus / openOrFocus / panels / focusPanel)
      签名稳定
- [ ] HeaderActions 的"更多"菜单按 PanelRegistry 动态列出全部 type

## 3. BDD topics

- **contract**(外部契约):
  - `dock-api-ref` `[contract]`
  - `popout-contracts` `[contract]`
- **integration**:
  - (暂无,multi-window 与 plugin-mcp-multi-window 不直接覆盖 dock layout)
- **unit**:
  - `wrap-panel-close`
  - `header-actions`(`src/__tests__/header-actions/`)
  - `popout-window` / `popout-button-disabled`
  - `dock-empty-state` / `dock-empty-state-restore`(在 e2e 里)
  - `dock-layout-write` / `persist-dock-layout`(部分在 e2e)

## 4. 必跑命令

```bash
# 单元 + 契约层
pnpm vitest run \
  src/__tests__/dock-api-ref \
  src/__tests__/popout-contracts \
  src/__tests__/wrap-panel-close \
  src/__tests__/header-actions

pnpm test:contract

# 全局
pnpm typecheck
pnpm lint
```

## 5. 回归用例(e2e 关键路径)

> e2e 跑 nightly,修 dock 时手动跑 `pnpm e2e -- <pattern>` 选取以下子集。

- [ ] `pnpm e2e -- dock-` 全部通过(覆盖 add-multiple-panels / empty-state /
      header-menu-* / layout-preserved-on-root-switch / layout-write)
- [ ] `pnpm e2e -- popout-` 全部通过
- [ ] `pnpm e2e -- persist-dock-layout`
- [ ] `pnpm e2e -- multi-tab-` 全部通过
- [ ] 手测:启动 → 拖 Editor tab 形成新 group → 重启 → 布局保留;
      右键 tab → "弹出窗口" → 关闭弹出窗口 → 主窗口正常

## 6. ADR 历史

_(冻结起算,变更时追加)_

### ADR-000 · 2026-05-08 · 冻结起算

参见 `02-Dockview-骨架方案.md` 与 `06-里程碑与验收.md` 的 M2/M5 done 标准,
冻结基线对齐 commit `02fb4a3` 之前的 dock 实现 + 本 PR (chore/quality-baseline)
对 IconButton 加 forwardRef 的最小改动。
