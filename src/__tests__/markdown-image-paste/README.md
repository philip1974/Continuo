# Markdown 粘贴 / 拖入图片(markdown-image-paste)

在 Markdown 文档里粘贴截图、从 Finder 拖入图片 → 图片落成文档旁的文件,文档里插入指向它的**相对路径**。修复前编辑视图写进
`![](blob:file:///…)`(Crepe 上传器没配 `onUpload` 时用 `URL.createObjectURL`),图片根本没保存;源码视图粘贴图片什么都不发生。

## 参考:VSCode 的做法(`extensions/markdown-language-features/src/languageFeatures/copyFiles/`)

- `ResourcePasteOrDropProvider`:粘贴 / 拖入的数据里有媒体文件 → `createEditForMediaFiles`:
  - 文件已在某个工作区文件夹里(`file.uri` 有值且 `getWorkspaceFolder` 命中)→ 直接引用,不复制;
  - 否则 `NewFilePathGenerator` 生成新文件:`markdown.copyFiles.destination` 缺省 = **文档所在目录** + 原文件名(截图粘贴是 Chromium
    给的 `image.png`);重名按 `markdown.copyFiles.overwriteBehavior` 缺省 `nameIncrementally` → `image-1.png`、`image-2.png`;
  - 无标题文档(`untitled:`)不复制(没有可放的目录)。
  `markdown.editor.filePaste.enabled` / `markdown.editor.drop.enabled` 缺省 `smart`,`…copyIntoWorkspace` 缺省 `mediaFiles`。
- `createUriListSnippet`:图片插入 `![alt text](path)`(alt 是片段占位,插入后选中),其余 `[text](path)`,多项空格分隔;路径相对文档
  目录(`getRelativeMdPath`,`/` 分隔),`escapeMarkdownLinkPath`:含空白 / 控制字符、`<` 开头或括号不配对 → `<…>`,**不做 `%20` 编码**。
- 文本粘贴优先:图片插入的编辑 `yieldTo` 文本,剪贴板里有文字时默认粘贴文字。
- 插入走一次编辑(可撤销);新文件由同一 WorkspaceEdit 创建。

## 行为

1. **编辑视图(Milkdown)/ 源码视图(CodeMirror)粘贴截图、拖入图片文件**:
   - Finder 拖来、已在工作区内的图片 → 直接引用其相对路径,不复制;
   - 剪贴板图片 / 工作区外的文件 → 经主进程(`fs:save-document-image`)写进文档所在目录,文件名取原名(截图为 `image.png`),
     重名加序号 `image-1.png`,**从不覆盖**已有文件;插入相对文档目录的路径(空白 → `<…>`);
   - 源码视图:插入 `![alt text](路径)`,选中 `alt text`(同 VSCode 片段占位);存图期间的输入保留、插入点随之映射;
     剪贴板里有文字 → 照常粘贴文字;
   - 编辑视图:插入图片节点(alt 留空 —— 编辑视图里改不了 alt),序列化为 `![](路径)`;存图期间显示「正在保存图片…」占位;
   - 一次撤销撤回插入(图片文件留着)。
2. **绝不写入 `blob:` / `data:`**:存不下来(文档没保存过、文档不在工作区内、写入失败、不是图片、超过 50 MiB)→ 提示原因,什么都不插。
   粘贴 / 拖入的 HTML 里 `src` 为 `blob:` / `data:` 的图片被丢掉并提示,其余内容照常粘贴。
3. **主进程的安全边界**(`fs:save-document-image`,zod 严格入参):
   - 文档须是发送窗口打开过的 Markdown 文档,且在该窗口的工作区内;目的地 = 文档所在目录,realpath 后仍须在工作区内
     (目录链接指向外部 → 拒绝);
   - 文件名由主进程生成:只取末段、去掉分隔符 / Windows 非法字符 / 控制字符 / 双向文本控制符,扩展名按**文件头**识别出的格式
     (png / jpeg / gif / webp / bmp / avif / ico;svg 不收),保留名回退 `image.<ext>` —— 不可能穿越目录;
   - 排他创建(`wx`):同名已存在或是(悬空)链接 → 换下一个序号,不跟随、不覆盖;大小上限 50 MiB(同图片预览)。
4. 重启后图片照常显示(相对路径按文档目录解析,见 `editor-image-preview`)。

## 与 VSCode 的差异

- 文档在工作区外(经「打开文件」打开)时 VSCode 复制到文档目录;Continuo 只允许工作区内的文档落盘新图片(提示原因,不插入)。
- 没有 `markdown.copyFiles.destination` / `overwriteBehavior` / `…enabled` 等设置,固定为 VSCode 的缺省行为。
- 编辑视图插入的图片 alt 为空(VSCode 源码编辑器插入 `alt text` 占位);源码视图与 VSCode 相同。
- 拖入 / 粘贴非图片文件(PDF 等)不插入链接(VSCode ⇧ 拖入会插 `[text](…)`);资源管理器拖来的文件见 `explorer-drag-out`。

## 规范文件

- `save-document-image.spec.ts`:主进程落盘(目的地、命名与序号、不覆盖、清洗、文件头识别、大小上限、工作区 / 链接边界、IPC schema)。
- `media-insert.spec.ts`:相对路径与转义、源码片段、工作区内引用 / 外部复制、无标题 / 工作区外 / 失败的提示。
- `source-mode-paste.spec.ts`:源码视图粘贴(插入与选中占位、期间输入的映射、撤销、文字优先、失败不插、代码文件不接)。
- `edit-mode-paste.spec.tsx`:编辑视图(真实 Crepe)粘贴不写 blob:、工作区内引用、失败不插、HTML 内嵌图片丢弃、撤销。
- e2e:`tests/e2e/markdown-image-paste.spec.ts`(真实应用里编辑 / 源码视图粘贴 png → 文件落盘、md 为相对路径、重启后显示;
  Finder 拖入工作区内 / 外的图片)。
