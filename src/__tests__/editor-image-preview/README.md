# 编辑器图片预览与 Markdown 相对路径图片(对齐 VSCode media-preview / markdown 预览)

行为契约:**打开 png / jpg / jpeg / jpe / gif / webp / ico / bmp / avif 文件时,编辑区显示只读图片预览,不再读成文本报
「文件是二进制或非 UTF-8」;Markdown 编辑 / 预览模式里 `![alt](./q.png)` 这类相对路径图片按文档所在目录解析并显示,
源文本不被改写。** 图片数据只经主进程受控通道读取(不放开 `file:`),CSP 不变。

## VSCode 参照

- 内置扩展 media-preview 的 `imagePreview.previewEditor`(selector `*.{jpg,jpe,jpeg,png,bmp,gif,ico,webp,avif}`):只读,
  图片居中、大于编辑区时按比例缩小适应(不放大小图),透明像素下衬棋盘格;状态栏显示尺寸(`宽x高`)与文件大小;
  文件在磁盘上变化后重新加载;加载失败显示「加载图片时出错」。`.svg` 不在其中 —— VSCode 把 svg 当文本打开,Continuo 同(保持现状)。
- imagePreview 缩放(media/imagePreview.js):初始「适应」(状态栏「整个图像」);单击放大、⌥单击缩小,按档位
  10% 20% … 90% 100% 150% 200% 300% 500% 700% 1000% 1500% 2000%(上下限 10% / 2000%);⌘ / ⌃ 滚轮与触控板捏合按 ×(1 ∓ 0.075)
  连续缩放;光标 zoom-in(按住 ⌥ 为 zoom-out);放大后像素化显示(VSCode 阈值 300%,Continuo 按需求超过 100% 即像素化),
  超出视图可滚动。
- markdown-language-features 预览:相对图片按文档目录解析(`asWebviewUri`),只能加载 `localResourceRoots` 内的文件 ——
  工作区目录;**文档不属于工作区时加上文档所在目录**(`getLocalResourceRoots`);
  严格安全级别 CSP `img-src 'self' https: data:` —— 允许 https 远程图片,不允许 http。
- Milkdown commonmark 自带 `insertImageInputRule`:键入 `![alt](src "title")` 即转图片节点。

## 行为

### 图片文件(只读视图)

- 打开路径(Explorer / Quick Open / 链接 / 会话恢复 / 外部同步)按扩展名路由:图片不经 `fs:read-file` 文本读取,tab
  内容只是磁盘 `stat` 指纹(`mtimeMs:size:ino`),用于外部修改检测;编辑区渲染只读 `ImageViewer`。
- 图片数据经 `fs:read-image`(主进程 `readImage`)读取为 data URL:扩展名必须是上述格式(否则 FS_DENIED),
  单 fd 有界读,超过 50 MiB → FS_FILE_TOO_LARGE,视图显示「图片过大」提示而不读入。
- 图片居中,`max-width/max-height: 100%` + `object-fit: contain` 缩放适应;图片背后棋盘格(语义 token 色,亮暗主题都可辨);
  右下角显示「宽 × 高 · 文件大小」(VSCode 在状态栏;Continuo 状态栏对图片 tab 不显示行 / 词 / 字符统计)。
- **缩放**(`image-zoom.spec.tsx`):初始适应;单击视图放大一档、⌥单击缩小一档(从「适应」起按适应时的实际显示比例算);
  ⌘ / ⌃ 滚轮与捏合(Chromium 以 ctrlKey wheel 上报)连续缩放,不带修饰键的滚轮照常滚动;缩放以指针(键盘为视图中心)下的
  图片点为中心;焦点在视图上时 `+` / `=` 放大、`-` 缩小、`0` 或 ⌘0(Ctrl+0)回适应。比例超过 100% `image-rendering: pixelated`;
  放大后图片按 `宽 × 比例` 排版,容器滚动(居中用 `margin:auto`,左 / 上侧也能滚到)。光标 zoom-in,按住 ⌥ 时 zoom-out。
  右下角追加当前比例:「…· 150%」,适应时为「整个图像」(en `Whole Image`,ko `전체 이미지`)。
- 不可编辑、不变脏、不参与自动保存;⌘S 对图片 tab 是 no-op(不写盘、不报错)。
- 外部修改:外部同步对图片 tab 只做 `stat`,指纹变化 → reloadEpoch 递增 → 视图重挂并重新读图;删除 → 与干净文本 tab
  同一出口(removePaths 关闭 tab;图片 tab 永不脏,不会进入 orphaned)。
- 可访问性:视图根可聚焦(tabIndex=0,F6 / 点 tab / 打开后焦点落点),名称「<文件名>，图片预览」
  (en `<name>, Image Preview`,ko `<name>, 이미지 미리 보기`)。

### Markdown 图片(Milkdown 编辑 / 预览)

- 行内 image 节点经自定义 nodeView 渲染(不启用 Crepe ImageBlock,不改变序列化):`src` 原样留在文档里,保存后仍是 `./q.png`。
- 解析规则(`resolveMarkdownImageSource`):
  - 相对 / 绝对本地路径 → 按 md 所在目录解析(同链接解析 `resolveLink`,含 `%20` 解码、`..` 折叠、UNC 限制),
    再经 `fs:read-image` 且 `workspaceOnly` + `documentPath`(当前 md 路径):主进程的**允许根** = 发送窗口的工作区根,
    加上 —— 仅当 `documentPath` 是**本窗口经 `fs:read-file` 读取过的 Markdown 文档**(main 按窗口记账,
    `window-editor-documents.service`,窗口关闭清空、每窗口上限 256)—— 该文档所在目录(含子目录)。renderer 自报、本窗口没打开过
    的文档不加根(`outside-doc-image.spec.ts`)。先字面判定、再 realpath 图片与根复判(符号链接逃逸拒绝);都不在 / 无任何根 →
    FS_DENIED。非图片扩展名不请求。
  - `https:` → 原样加载(CSP `img-src https:` 现状,与 VSCode 默认一致);`data:image/*` → 原样。
  - `http:` / `file:` / 其它协议 → 不加载。
- 加载失败或不加载 → 渲染 alt 文字占位(虚线框,`role=img` 名称「图片无法显示：<alt>」),不出现破图图标。
- 编辑模式键入完整图片语法 `![alt](path)`(可带 `"title"`)→ 即转成行内 image 节点(`insertImageInputRule`),同上显示;
  序列化回原样 `![alt](path)`,不再保存成转义文本 `!\[alt]\(path)`。

## Modules

| File | Role |
|---|---|
| `electron/shared/image-preview.ts` | 可预览扩展名 → MIME、`MAX_IMAGE_PREVIEW_BYTES` |
| `electron/main/ipc/fs/read-image.ts` | `readImage(path, allowedRoots?)`:格式 / 允许根(字面 + realpath)/ 大小校验 → data URL |
| `electron/main/ipc/fs.ipc.ts` | 注册 `fs:read-image`(workspaceOnly 时允许根 = 发送窗口工作区根 + 本窗口打开过的文档目录);`fs:read-file` 登记读过的 Markdown 文档 |
| `electron/main/services/window-editor-documents.service.ts` | 每窗口打开过的 Markdown 文档登记(上限、关窗清空) |
| `electron/preload/index.ts` | `coApi.fs.readImage(path, opts?)` |
| `src/panels/Editor/editor-image.ts` | `readEditorFile`(图片 → stat 指纹)、`formatBinarySize` |
| `src/panels/Editor/ImageViewer.tsx` | 只读图片视图 |
| `src/panels/Editor/markdown-image-view.ts` | `resolveMarkdownImageSource` + Milkdown image nodeView |
| `src/panels/Editor/EditorPanel.tsx` / `editor-file-actions.ts` / `useExternalFileSync.ts` / `editor-file-deps.ts` | 路由、⌘S no-op、外部同步 |

## Specs

- `read-image.spec.ts`:主进程读图(格式、上限、工作区与符号链接逃逸)
- `open-image.spec.tsx`:打开 / 视图 / 保存 no-op / 超限提示 / 外部修改重载
- `markdown-image.spec.tsx`:解析规则 + 真实 Crepe 渲染与序列化不变 + 键入图片语法转图片
- `outside-doc-image.spec.ts`:工作区外文档的同目录图片(main 记账、伪造 documentPath / 他窗 / 关窗 / 符号链接逃逸)
- `image-zoom.spec.tsx`:图片预览缩放
