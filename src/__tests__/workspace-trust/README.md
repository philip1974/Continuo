# workspace-trust(工作区信任 / 受限模式,最小版)

对齐 VSCode Workspace Trust(`src/vs/workbench/contrib/workspace/browser/workspace.contribution.ts` 启动询问 / 状态栏项、
`workspaceTrustEditor.ts` 管理页、`src/vs/workbench/services/workspaces/common/workspaceTrust.ts` 信任服务)。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/shared/workspace-trust.ts` | 跨进程通道 / 类型 / 推送守卫 |
| `electron/main/services/workspace-trust.service.ts` | 信任判定、询问时机、持久化(依赖注入,可单测) |
| `electron/main/ipc/workspace-trust.ipc.ts` | Electron 接线:原生对话框、`<userData>/workspace-trust.json`、推送、E2E 默认 |
| `electron/main/ipc/git.ipc.ts` | `git:status` 按信任把关(`gateGitByWorkspaceTrust`) |
| `electron/main/ipc/window.ipc.ts` | `window:notify-root` 后通知信任服务 |
| `src/stores/workspace-trust.store.ts` | renderer 界面副本(main 推送) |
| `src/shell/workspace-trust/WorkspaceTrust.tsx` | 状态栏项 / 管理对话框 / 授权弹窗提示 / 命令 |

## 行为

### 询问(VSCode `onDidInitiateWorkspaceTrustRequestOnStartup` + `startupPrompt: once`)

- 窗口工作区根变化(`window:notify-root`,覆盖打开文件夹 / 最近项目 / 拖入 / 命令行 / 菜单 / 切换 root / 多窗口 / 重启恢复)
  → main 求信任状态并推给该窗口;**未信任且该文件夹从没问过** → main 原生对话框(挂在该窗口上)询问一次:
  - 标题「是否信任此文件夹中的文件的作者？」,说明「Continuo 提供可以自动在此文件夹中执行文件的功能。」+「如果不信任这些文件的
    作者，则建议继续使用受限模式…」+ 文件夹路径(双向控制 / 零宽字符可见化成「\uFFFD」,同 file-name-invisible-chars);按钮「是，我信任此作者」/「否，我不信任此作者」(Esc = 不信任);
  - 复选框「信任上级文件夹「<上级完整路径>」中所有文件的作者」(根目录没有上级则不显示);勾选并信任 → 记上级而非本文件夹。
    上级 = 上报的原路径的上级(VSCode `setParentFolderTrust` 取工作区 URI 的 `dirname`,不解析符号链接):经符号链接打开时信任的
    是对话框里显示的那个目录,写入前再 realpath;规范化后的上级不覆盖当前文件夹(链接指向别处)→ 当前文件夹一并记入。
- 问过一次(无论结果)就记为已询问,之后打开同一文件夹(别的窗口 / 重启后)不再问,保持上次结论。
- 同一文件夹同时只弹一个对话框(多窗口共用结果);对话框没能弹出 / 抛错 → 保持受限、不记为已询问。
- **伪造不了**:决定只来自用户在 main 原生对话框里的点击。renderer 只有三个通道:读信息、请求 main 弹对话框(无入参,
  塞 `{trusted:true}` 被 zod 拒)、移除已信任条目(只收紧);都走帧信任校验(注入的子 frame / 远程页面调不动)。没有任何
  「直接设为信任」的 IPC,插件 / agent / 渲染内容不能自动确认。

### 持久化与继承

- `<userData>/workspace-trust.json`:`{version:1, trusted:[...], prompted:[...]}`,主进程侧用户数据(不进工作区);各上限
  1000 条(超出丢最早)。损坏 / 超大 → 隔离留证(`.corrupt`)后从空表开始(fail-closed,什么都不信任);读失败(权限 / IO)→
  本次启动内存生效、不写盘(不用空表覆盖原文件),询问对话框与管理对话框写明「本次修改只在退出 Continuo 前有效，不会保存。」
- 比较前 realpath(符号链接 / `..` 指向同一目录算同一个;失败用原值);macOS / Windows 再按 NFC + 小写比较,Linux 区分大小写。
- 继承:已信任条目等于当前文件夹或是其上级 → 受信任(VSCode `isEqualOrParent`);前缀相同的兄弟目录不算。
- 刻意差异:经符号链接打开并信任上级时,VSCode 只记上级(其比较不解析 realpath,链接路径天然在上级之下);Continuo 按 realpath
  比较,链接目标不在规范化后的上级之下 → 额外记当前文件夹,否则「信任」后本窗口仍受限。显示完整路径而非 VSCode 的上级名:
  看得出信任的到底是哪个目录。
- 没有 `security.workspace.trust.enabled` 总开关(刻意差异:renderer 可写的关闭开关等于绕过对话框)。

### 受限模式标识与管理

- 状态栏左侧最前「受限模式」(盾牌图标;tooltip「在受限模式下运行 … 某些功能被禁用，因为此文件夹不受信任：」+ 被禁用功能列表),
  点击打开管理;信任后即时消失。状态未知 / 推送针对别的根 → 不显示。不做横幅(VSCode banner 与状态栏项重复,极简只做状态栏)。
- 命令面板「工作区: 管理工作区信任」(`workbench.trust.manage`)打开 design Modal:当前文件夹(你信任此文件夹 / 你处于受限模式下)、
  被禁用功能;未受信任 →「信任」(请 main 弹同一原生对话框,由用户决定);只因本文件夹条目受信任 →「不信任」(移除该条目);
  经上级受信任 → 说明「此文件夹通过以下受信任文件夹中的加粗条目得到信任。」(VSCode `canSetWorkspaceTrust`);已信任文件夹列表
  (覆盖当前文件夹的条目加粗)每项可「删除路径」。main 推送新状态后对话框重取信息。

### 受限模式下的能力

- **宿主 git 装饰 / git 状态:禁用**。`git:status` 在 main 按信任把关:未受信任 → 不调用任何 git 子进程、回 null(资源管理器 /
  编辑器 tab / 搜索结果都无装饰);信任状态未求出时等它求出;信任服务未注册 → 按不受信任。信任变化后 renderer 的 git 数据源
  即时重查(无需重载窗口)。
- 插件权限弹窗(manifest / fs-scope)与 agent 授权弹窗:附「此文件夹不受信任（受限模式）。仅在信任此文件夹中文件的作者时才授权。」
- E2E:`CONTINUO_E2E=1` 时默认关闭信任(一切受信任、不弹框),现有打开文件夹的 e2e 不被打断;信任专项 e2e 另设
  `CONTINUO_E2E_WORKSPACE_TRUST=1` 打开真实行为。非 E2E 恒开启。

## 规范

- `workspace-trust-service.spec.ts`:首次询问、不信任不再问(含重启)、重启保留、父文件夹继承、realpath / 大小写 / NFD、单飞、
  经符号链接信任上级、对话框失败、requestTrust、getInfo / removeFolder、读失败不写盘并提示、条目上限、enabled=false
- `workspace-trust-ipc.spec.ts`:通道清单(无置信任通道)、notify-root 触发原生对话框、伪造入参 / 不受信任帧被拒、userData 持久化
  与重启读回、符号链接夹具下的上级路径、读失败提示、损坏隔离、E2E 默认开关
- `git-gate.spec.ts`:受限模式 exec 探针零调用、信任后即时运行、状态未求出时不抢跑
- `restricted-mode-ui.spec.tsx`:状态栏项、点击打开管理、命令、信任 / 不信任 / 删除、加粗继承条目、授权弹窗提示、git 刷新
- e2e `tests/e2e/workspace-trust.spec.ts`:打开新文件夹弹窗 → 不信任 → 状态栏受限、git 探针未运行 → 管理里信任 → 状态栏项消失、
  git 装饰出现;重启保留;已信任上级下的子文件夹不再询问
