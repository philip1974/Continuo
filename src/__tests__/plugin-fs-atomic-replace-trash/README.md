# plugin-fs-atomic-replace-trash(atomicReplace 的 trash 落点与清扫不出 scope、只动宿主自己的 trash)

## 背景

`app.fs.atomicReplaceWithinScope(staging, final, { overwrite: true })` 覆盖已有 `final` 时,宿主先把旧
`final` 改名成同目录下的 trash,再把 `staging` 改名成 `final`,最后删 trash;替换前还顺手回收该目录里
超过 24 小时的残留 trash(回滚失败 / 崩溃留下的)。

此前两处过宽:

- 只校验 `staging` / `final` 各自在 rw scope 内且同父目录。`final` 等于 scope 根时,父目录已在 scope 外,
  宿主照样清扫它 —— `atomicReplaceWithinScope('/Users/x/proj', '/Users/x/proj')` 会让宿主递归删除
  `/Users/x/` 下所有超过 24 小时的 `.trash-*`(之后替换本身报错,但删除已发生)。
- 清扫只看前缀 `.trash-` + mtime。scope 内普通的一次替换,也会静默删掉用户自己命名的旧 `.trash-xxx`。

## 行为

- `staging` 与 `final` 的共同父目录必须**自身**落在该插件的某条 rw scope 内,否则整个操作以 `ScopeError`
  拒绝,且发生在任何文件系统变更之前(不清扫、不落 trash、不替换)。因此 `final` 不能是 scope 根;
  父目录只被只读 scope 覆盖也拒绝。
- `staging` 与 `final` 是同一路径 → `ScopeError`,文件原样。
- 清扫只回收宿主自己生成形态的 trash:`.trash-<原名>-<13 位毫秒时间戳>-<4 位 base36>`
  (生成与识别共用同一组常量)。其它 `.trash-*`(用户 / 其它工具的)再旧也不动。
- 过期须同时满足:名字里的时间戳(移入 trash 的时刻)与条目自身 mtime 都早于 24 小时前。
  目录改名不更新自身 mtime,只看 mtime 会把刚移入 trash 的旧目录当成过期。
- 按条目自身判定(不跟随符号链接);删除也只删条目本身。
- 清扫范围仍是该目录下全部宿主形态的过期 trash(不限本次目标同名):只扫同名的话,之后再没被替换过的
  目标留下的 trash 永远没人回收。
- 正常替换成功后不留下本次的 trash。
- 覆盖时 `staging → final` 失败会把旧 `final` 从 trash 挪回(回滚)。回滚也失败 → 旧内容只剩 trash 里那一份:
  抛给插件的错误信息带上 trash 的完整路径(在该插件 rw scope 内)并保留原始错误码,主进程 `console.error`
  记同一路径。回滚成功时错误就是原始错误。

## 规范

- `atomic-replace-trash-scope.spec.ts` —— 真实 IPC handler + 真实 `PathScopeRegistry` + 真实临时目录。
- `rollback-failure-reports-trash.spec.ts` —— 回滚失败时错误信息 / 日志带 trash 路径。
- 清扫函数的单元测试:`electron/main/__tests__/trash-sweep.test.ts`。
