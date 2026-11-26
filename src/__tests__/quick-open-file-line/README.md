# Quick Open(⌘P)支持 `文件名:行号`

对齐 VSCode Quick Open(`extractRangeFromFilter`):查询末尾带行列时,先剥掉行列再匹配文件,打开选中的文件后跳到该行。此前输入
`long.ts:200` 拿整串做模糊匹配 →「No matching files」。

## 行为

1. **格式**(照抄 VSCode `LINE_COLON_PATTERN`):`file:行`、`file:行:列`、`file#行`、`file(行)`、`file(行,列)`、`file (行)`、
   `file:line 行`、`file:行-行`(范围只取起点)。只有分隔符没有数字(`file:` / `file#`)→ 第 1 行(VSCode 同);行号 0 视为第 1 行。
   以 `:` 开头仍是「转到行」模式(见 `editor-goto-line`);剥掉行列后为空 → 不当作文件查询。
2. **匹配与显示**:列表按剥掉行列的部分做模糊匹配与高亮(`long.ts:200` 列出 long.ts)。
3. **打开**:Enter / 点击 → 打开文件并把光标移到该行(列),该行居中;Markdown 编辑 / 预览按源码行定位 —— 与「在文件中查找」打开结果
   同一入口(`editor.openFile({ line, column })`)。行号超出文档 → 只打开文件(同该入口)。
4. **导航历史**:只记一条(目标位置),后退一次即回到来处(程序化定位,见 `editor-navigation-history` 第 2 条)。
5. 不带行列的查询照旧:打开文件,不改光标位置(恢复上次的视图状态)。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/quick-open/goto-line.ts` | `parseFileLineQuery`:剥出文件查询与行列 |
| `src/plugins/quick-open/QuickOpenModal.tsx` | 按剥掉后的查询匹配;带行列时经 `coApp.editor.openFile` 打开并定位 |

## 规范

- `quick-open-file-line.spec.tsx`
