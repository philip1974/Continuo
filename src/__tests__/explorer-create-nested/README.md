# explorer-create-nested(新建时一次输入嵌套路径)

## 背景

对齐 VSCode 资源管理器:新建文件 / 文件夹的输入框里可以直接输入 `a/b/c.ts`,逐级创建中间目录
(VSCode `validateFileName` 按 `/[\\/]/` 拆段、每段单独校验,`onSuccess` 用 `joinPath` 一次建出)。
此前 Continuo 把整串交给单段 leaf 校验,报「Invalid file name」(第四十一轮审计 #5)。

## 行为契约

1. 拆段(`electron/shared/leaf-name.ts` `splitRelativeName`):`/` 与 `\` 都是分隔符(所有平台,同 VSCode;POSIX 上 `\`
   本就被 leaf 规则拒);每段按单段 leaf 规则校验。空段(开头 / 结尾 / 连续分隔符,即绝对路径、UNC、`a//b`、`a/`)、
   `.` / `..`、盘符 `C:` 一律拒 → `FS_BAD_NAME`。结果必在给定父目录内,与单段名的路径安全校验同强度,不放宽。
2. main `createFile(dir, name)` / `createDir(parent, name)`:缺的中间目录逐段非递归 `mkdir` 建出(mkdir -p 语义,
   但记下哪些是本次建的);已存在的目录沿用;中间段是已存在的文件 → `FS_NOT_DIRECTORY`。最后一段排他创建
   (文件 `open wx`、目录 `mkdir`),已存在 → `FS_EEXIST`。
3. 任一步失败 → 本次建出的中间目录回滚(最深先删,只删空目录),已存在的目录不动。
4. 返回 `FsCreated { path, created }`:path = 新建项,created = 本次新建的最上层项(没有新建中间目录时 = path)。
5. 资源管理器(`FolderTree` `submitCreate`):成功后刷新 created 所在目录,逐级展开到新项并选中;新建的是文件时在编辑器打开。
6. 撤销记录覆盖整条链(见 `explorer-file-undo` 规则 5):撤销删 created(连同其下新建的目录与文件),已存在的目录不删;
   重做按「created 的名字 / 余下的段」重新逐级创建。

## 规范

- `create-nested.spec.ts`:拆段校验(规则 1)、main 逐级创建 / 冲突 / 回滚 / 返回值(规则 2-4),真实临时目录。
- `../explorer-tree/folder-tree-create.spec.tsx`「新建时输入嵌套路径」:树里展开到新项、选中、打开(规则 5)。
- `../explorer-file-undo/file-undo.spec.ts`「一次输入嵌套路径的新建」:撤销 / 重做整条链(规则 6)。
- e2e:`tests/e2e/explorer-create-nested.spec.ts`(右键新建 `na/nb/nc.ts` → 磁盘与树;⌘Z 撤销整条链)。
