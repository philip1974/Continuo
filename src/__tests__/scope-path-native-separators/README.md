# 尚不存在的 scope 目录:路径分隔符归一化

行为契约:**插件请求的 fs scope 目录即使此刻还不存在,授权落地的路径也使用本平台的分隔符**,
这样目录之后被创建时,这条授权仍然生效,授权弹窗显示的也是一条正常的本平台路径。

## 背景

授权落地前 main 会把 scope 路径归一化(`~` 展开 + `realpath`)。目录不存在时 `realpath` 失败,
回退到「只展开 `~`」的值。`~` 展开是字符串拼接(`<home>` + `/dir`),插件也可能直接给
`C:/proj/out` 这样的正斜杠路径 —— 在 Windows 上回退值于是成了 `C:\Users\x/dir`:

- 授权弹窗(`displayPath`)显示混合分隔符的路径;
- 目录之后被创建,fs 操作的目标经 `realpath` 得到全反斜杠路径,与落地的 scope 做
  `scope + 分隔符` 前缀匹配时对不上 → 这条授权永远不生效(误拒,不是越权)。

目录已存在时 `realpath` 本身会给出本平台分隔符,不受影响。

## 行为

- Windows 上,回退值里的 `/` 全部换成 `\`(`~/dir` → `C:\Users\x\dir`;`C:/proj/out` → `C:\proj\out`)。
- 其它平台回退值原样不变(`\` 在 POSIX 是合法文件名字符,不能动)。
- 只换分隔符:不折叠 `..`、不做别的改写。
- 端到端:对一个尚不存在的目录授权(路径可用正斜杠书写)→ 之后创建该目录 → 目录内的读写通过校验。

## 不在本主题验证

- `~user` 形式无法展开时退化为原始路径(见 `49-polish-bugfixes/scope-grant-canonicalizes-path.spec.ts`)。
- 弹窗如何渲染 `displayPath`(见 `plugin-fs-scope-display-path`)。
