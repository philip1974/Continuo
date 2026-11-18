# fs-dir-changed-payload-guard (E173)

preload onDirChanged 复用的 fs:dir-changed payload 形态守卫:非对象/path 非字符串/超长 → false。
IPC ingress 纵深防御族(E168-E173),防畸形 push 让 preload listener 抛错或脏 path 进 Explorer
watcher / external-file-sync。

可选 `files`(该目录本次变更项名字,≤ DIR_CHANGED_FILES_MAX):`readFsDirChangedFiles` 校验,畸形 / 超限 →
undefined(退化为目录级,不丢整条事件)。
