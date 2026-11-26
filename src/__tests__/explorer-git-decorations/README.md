# explorer-git-decorations(资源管理器 git 状态装饰 + 默认显示点文件)

对齐 VSCode 资源管理器:

- **点文件默认可见**:`explorer.showHiddenFiles` 默认 `true`(VSCode 不隐藏点文件,只按 `files.exclude` 排除)。固定排除集即
  `fs:list-dir` 默认 exclude(`LIST_DIR_DEFAULT_EXCLUDE`):VSCode `files.exclude` 默认的 `.git / .svn / .hg / CVS / .DS_Store /
  Thumbs.db`,另含 Continuo 既有的 `node_modules`(VSCode 只在 `search.exclude` 排除它)。设置只存 override:之前显式设为 `false`
  的用户保留该选择。Quick Open / 在文件中查找本来就列点文件、排除同一份基础集(`WORKSPACE_SCAN_EXCLUDE` 在其上追加构建产物)。
- **git 状态装饰**(VSCode git 扩展 FileDecorationProvider + GitIgnoreDecorationProvider):文件名按状态着色,右侧显示状态字母;
  文件夹继承子项颜色、不显示字母;`.gitignore` 命中项置灰。设置 `explorer.decorations.colors` / `explorer.decorations.badges`
  (默认都开,三语),两项都关时不再查询 git。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/shared/git-status.ts` | 通道 `git:status`、装饰种类、快照形状(跨进程) |
| `electron/main/services/git-status.service.ts` | 跑 `git rev-parse` + `git status --porcelain=v1 -z --ignored=matching`;解析;超时 / 输出上限 / 并发上限 / 同根合并 |
| `electron/main/ipc/git.ipc.ts` | safeHandle 接线;根取自发送窗口的工作区登记 |
| `src/panels/Explorer/git-decorations.ts` | 快照 → 每行装饰(文件夹继承、整目录未跟踪 / 忽略);颜色 class、文案 key |
| `src/panels/Explorer/hooks/useGitStatus.ts` | 取快照与刷新(fs watch 广播 / 保存 / 窗口获焦,防抖 + 单飞;侧栏隐藏期间只记脏) |
| `src/panels/Explorer/FileRow.tsx` / `FolderTree.tsx` | 名称颜色、徽标字母、悬浮提示与读屏文案 |
| `src/styles/theme.css` | `--md-git-*` 槽位(light / dark 各一套,取 VSCode `gitDecoration.*` 默认色,低对比的几个按 WCAG 调整)→ `text-git-*` |

## 行为

### 状态 → 装饰(`git-status-service.spec.ts` / `git-decorations.spec.ts`)

| porcelain XY | 种类 | 字母 |
|---|---|---|
| `?? ` | untracked | U |
| `!! ` | ignored(置灰) | 无 |
| `DD AU UD UA DU AA UU` | conflict | ! |
| 工作区侧 `M` / `T` / `D` / `A` / `R` | modified / modified / deleted / added / renamed | M / T / D / A / R |
| 仅暂存区侧 `M` / `T` / `A` / `D` / `R` / `C` | modified / modified / added / deleted / renamed / renamed | M / T / A / D / R / C |

- 工作区侧优先于暂存区侧(`MM` → 工作区的 M);同一路径多条记录(如 `D ` + `??`)按 VSCode 收集顺序 index < untracked <
  working tree < merge 取后者
- 重命名 / 复制只装饰新路径
- 路径相对工作区根(工作区可以是仓库的子目录:按 `rev-parse --show-prefix` 去前缀,根外条目丢弃)
- 文件夹:颜色取子项中优先级最高者(冲突 > 修改 > 新增 > 重命名 > 未跟踪);已删除、已忽略不向上传播;不显示字母
- 整个目录未跟踪(`?? dir/`)→ 目录本身着未跟踪色,其下文件显示 U;整个目录被忽略(`!! dir/`)→ 目录及其下各项置灰

### 安全与资源(`git-status-service.spec.ts`)

- 只读:`GIT_OPTIONAL_LOCKS=0`(不写 index、不抢 `index.lock`);剥离宿主机密与改读别处仓库的 `GIT_*`;强制 `core.fsmonitor=false`;
  禁止一切传输;execFile + 参数数组(不经 shell)
- cwd 只能是发送窗口已登记的工作区根:IPC 入参 `{ root }` 是 renderer 期望的根,只用来比对 —— 与登记根不符(换根后
  `window:notify-root` 尚未到达、或从「未打开文件夹」首次打开登记还没到)→ `GIT_STATUS_STALE`,不跑 git;renderer 不能指定目录
- 非仓库 / 未装 git / 命令失败 → `null`(静默);单条命令超时 10s、输出上限 32MiB、条目上限 100k
- 全局并发上限 2;同一根至多一次在跑 + 一次排队,排队期间的请求合并到排队那次

### 刷新(`use-git-status.spec.tsx`)

- 挂载 / 换根时取一次;根变了旧快照立即不再使用,迟到的旧根结果丢弃
- 换根后 main 回 STALE(资源管理器的 effect 先于 App 推 notify-root)→ 每 100ms 重试,至多 30 次;登记到达后装饰随即出现,
  不必等窗口获焦或文件变化;卸载 / 换根后不再重试
- 工作区根内的 `fs:dir-changed`(含仅内容变化)、编辑器保存、窗口获焦 → 防抖 300ms(持续变化下至多每 2s)刷新;根外变化忽略
- 在途时再触发只补跑一次
- 侧栏隐藏期间不查询,只记脏;再次显示时补一次
- 装饰两项设置都关 → 不查询

### 渲染(`file-row-git.spec.tsx`)

- 文件:名称 `text-git-<kind>`;右侧字母(与名称同色,`aria-hidden`);读屏与悬浮提示带状态文案(「已修改」等,VSCode 装饰 tooltip)
- 文件夹:只着色,无字母、无文案;忽略项:只置灰,无文案
- `explorer.decorations.colors=false` → 名称不着色(字母仍在);`explorer.decorations.badges=false` → 无字母(颜色仍在)
- 插件装饰的 textColor 仍覆盖名称颜色(内联 style)

### 点文件默认可见(`hidden-files-default.spec.ts`)

- `explorer.showHiddenFiles` 默认 `true`;排除集与 VSCode `files.exclude` 默认一致(外加 `node_modules`)
- 已存的显式 `false` 仍生效

## 与 VSCode 的差异

- 文件夹继承颜色时不画 VSCode 的圆点徽标(codicon `circle-filled`),只着色
- 不区分暂存区修改与工作区修改的颜色(VSCode 两个槽位默认同色);重命名 / 复制与未跟踪同色(VSCode 默认同值)
- 子模块不单独着色
- 用 `--untracked-files=normal`(整个未跟踪目录一条记录,渲染时展开到其下各项),VSCode 默认 `-uall`

## e2e

`tests/e2e/explorer-git-decorations.spec.ts`:点文件默认可见、`.git` 不可见;临时 git 仓库里改文件出现 M、新文件出现 U、
忽略项置灰、文件夹继承颜色;关掉设置后装饰消失;不触发窗口获焦地换根(打开最近 → 子目录 / 另一仓库)后装饰出现。
