# plugin-symlink-escape(插件仓库里的符号链接不能把宿主的读写引到插件目录之外)

## 背景

`installFromGit` 原样保留克隆树里的符号链接,而宿主会以自己的权限读插件安装目录里的文件:

- `plugin-data:load` 读 `userData/plugins/<id>/data.json`(就在安装目录里)。恶意仓库提交
  `data.json -> ../<受害插件 id>/data.json`,零权限插件 `loadData()` 即读到别的插件的持久化数据;
  目标不是 JSON 对象时,其内容还会被复制成 `data.json.corrupt`(敏感内容落盘)。
- `manifest.json` / main 入口同理:`main.js -> ~/.ssh/id_rsa` 会被当插件源码送进 renderer。

## 行为

- **安装**:克隆树(不含 `.git`)里出现任何符号链接(文件 / 目录 / 悬空;树内树外不区分)→
  `installFromGit` 抛 `PLUGIN_SYMLINK_REJECTED`,在读 manifest 之前中止,不落地、无残留。
- **`plugin-data:load`**:`data.json` 是符号链接或硬链接 → 当作无数据返回 `{}`,不读目标、不生成 `.corrupt`。
- **`plugin-data:save-serialized`**:`data.json` 是符号链接(含悬空)→ 先删掉链接再写,结果是插件目录里的普通文件;
  链接目标不被改写,也不在目标旁留锁目录。
- **已安装目录的读取**(列举 / 激活读 main / 单插件重载):`manifest.json` 或 main 入口经符号链接
  解析到插件目录(realpath)之外 → 该插件视为不可用(跳过),不读取链接目标。插件目录本身是符号链接
  (本地开发把仓库链进 `plugins/`)、目录内指向目录内的链接照旧可用。

## 残余

- 读取点的「realpath 包含判定 → open」之间不是原子的;能在这之间改写插件目录的攻击者已有等同权限,不在本主题范围。
