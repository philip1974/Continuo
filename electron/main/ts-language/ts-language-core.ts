// TS / JS 语言服务核心(运行在语言服务进程里,见 ts-language-server;纯 Node + typescript,可直接单测)。
// 对应 VSCode 内置 tsserver 的「项目」模型,只取转到定义所需:
// - 项目:文件就近的 tsconfig.json / jsconfig.json(同一目录 tsconfig 优先,tsserver 同);该配置不包含此文件 → 依次看它的
//   project references(solution 式 tsconfig:`files: []` + references)、再往上一级的配置;都不包含 → 推断项目(inferred
//   project),编译选项取 VSCode 对 inferred project 的默认值(见 INFERRED_OPTIONS)。jsconfig 的默认选项同 tsserver(allowJs 等)。
// - 用 ts.createLanguageService + 自己的 LanguageServiceHost(不走 tsserver 协议):不加载 compilerOptions.plugins(语言服务
//   插件是 tsserver 的功能,这里根本不存在加载路径 —— VSCode 对不受信任工作区同样不加载插件)、不做自动类型获取(ATA,无网络)。
// - 文件:未保存的文档来自 overlay(编辑器同步);其余读盘,版本 = mtime + size(每个请求内每个文件最多 stat 一次)——
//   磁盘变化由服务自己发现,不需要文件监听。配置文件变化(mtime)或请求的文件不在项目文件表里 → 重新解析配置(新建的文件进项目)。
// - 只读:只允许读工作区根之内、工作区根及其祖先目录下的 node_modules、以及内置 typescript 的 lib 目录;其余路径一律当不存在。
// BDD: src/__tests__/editor-go-to-definition/

import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { TS_DEFINITIONS_MAX, TS_PREVIEW_MAX, type TsLocation, type TsRange } from '../../shared/ts-language';

/** VSCode 推断项目的默认编译选项(typescript-language-features tsconfig.ts inferredProjectCompilerOptions,TS ≥ 5.4)+ tsserver InferredProject 的固定项。 */
export const INFERRED_OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.Preserve,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ES2022,
  jsx: ts.JsxEmit.ReactJSX,
  allowImportingTsExtensions: true,
  strict: true,
  strictNullChecks: true,
  strictFunctionTypes: true,
  sourceMap: true,
  noEmit: true,
  // tsserver InferredProject
  allowJs: true,
  allowSyntheticDefaultImports: true,
  allowNonTsExtensions: true,
  maxNodeModuleJsDepth: 2,
};

/** tsserver 对 jsconfig.json 项目的默认选项。 */
const JSCONFIG_DEFAULTS: ts.CompilerOptions = {
  allowJs: true,
  maxNodeModuleJsDepth: 2,
  allowSyntheticDefaultImports: true,
  skipLibCheck: true,
  noEmit: true,
};

/** 推断项目根文件数上限(超出重置为当前文件)。 */
const INFERRED_ROOTS_MAX = 1000;
/** project references 的追溯深度上限。 */
const REFERENCE_DEPTH_MAX = 4;

export interface TsLanguageCore {
  /** 未保存文档:text = null → 移除(回到磁盘内容)。 */
  applyChanges(changes: readonly { readonly path: string; readonly text: string | null }[]): void;
  /** 加载 path 所属项目(预热)。 */
  warmup(path: string): void;
  definition(path: string, line: number, column: number): { origin: TsRange | null; definitions: TsLocation[] };
  dispose(): void;
}

/** TS 内部路径(正斜杠、绝对)。 */
function toTsPath(p: string): string {
  return path.resolve(p).replace(/\\/g, '/');
}

/** 交给 renderer 的路径(本平台分隔符)。 */
function toNativePath(p: string): string {
  return path.normalize(p);
}

function isInside(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

/**
 * 只读范围:工作区根之内、内置 typescript lib 目录之内、或路径中第一个 node_modules 段之前的部分是工作区根本身 / 其祖先
 *(模块解析往上找 node_modules,单仓子目录作工作区根时依赖常在上级)。纯字面判定(不 realpath:pnpm 的 node_modules 链接
 * 按其 node_modules 路径读,TS 也按此路径报告定义位置)。
 */
export function makeReadGuard(root: string, libDir: string): (p: string) => boolean {
  const absRoot = path.resolve(root);
  const absLib = path.resolve(libDir);
  return (p) => {
    const abs = path.resolve(p);
    if (isInside(absRoot, abs) || isInside(absLib, abs)) return true;
    const parts = abs.split(path.sep);
    const nm = parts.indexOf('node_modules');
    if (nm < 0) return false;
    const prefix = parts.slice(0, nm).join(path.sep) || path.sep;
    return isInside(prefix, absRoot);
  };
}

interface Project {
  readonly key: string;
  readonly configPath: string | null;
  readonly dir: string;
  options: ts.CompilerOptions;
  fileNames: string[];
  fileSet: Set<string>;
  references: readonly ts.ProjectReference[] | undefined;
  configStamp: string | null;
  parsedAt: number;
  service: ts.LanguageService;
}

export function createTsLanguageCore(opts: { readonly root: string; readonly now?: () => number }): TsLanguageCore {
  const now = opts.now ?? Date.now;
  const root = path.resolve(opts.root);
  const libDir = path.dirname(ts.getDefaultLibFilePath({}));
  const canRead = makeReadGuard(root, libDir);
  const caseSensitive = ts.sys.useCaseSensitiveFileNames;
  const keyOf = (p: string): string => (caseSensitive ? toTsPath(p) : toTsPath(p).toLowerCase());

  const overlay = new Map<string, { readonly fileName: string; readonly text: string; readonly version: number }>();
  let overlaySeq = 0;
  const registry = ts.createDocumentRegistry(caseSensitive, root);
  const projects = new Map<string, Project>();
  const inferredRoots = new Map<string, string>();
  let inferred: Project | null = null;

  // 每个请求一轮的 stat 缓存(请求之间磁盘可能变化)
  let statCache = new Map<string, fs.Stats | null>();
  const statOf = (fileName: string): fs.Stats | null => {
    const k = keyOf(fileName);
    if (statCache.has(k)) return statCache.get(k)!;
    let st: fs.Stats | null = null;
    if (canRead(fileName)) {
      try {
        st = fs.statSync(fileName);
      } catch {
        st = null;
      }
    }
    statCache.set(k, st);
    return st;
  };
  const diskSnapshots = new Map<string, { readonly version: string; readonly snapshot: ts.IScriptSnapshot }>();

  const fileExists = (f: string): boolean => overlay.has(keyOf(f)) || (statOf(f)?.isFile() ?? false);
  const readFile = (f: string): string | undefined => {
    const o = overlay.get(keyOf(f));
    if (o) return o.text;
    if (!canRead(f)) return undefined;
    try {
      return fs.readFileSync(f, 'utf8');
    } catch {
      return undefined;
    }
  };
  const directoryExists = (d: string): boolean => canRead(d) && ts.sys.directoryExists(d);
  const getDirectories = (d: string): string[] => (canRead(d) ? ts.sys.getDirectories(d) : []);
  const readDirectory = (
    d: string,
    extensions?: readonly string[],
    exclude?: readonly string[],
    include?: readonly string[],
    depth?: number,
  ): string[] => (canRead(d) ? ts.sys.readDirectory(d, extensions, exclude, include, depth).filter(canRead) : []);

  const scriptVersion = (fileName: string): string => {
    const o = overlay.get(keyOf(fileName));
    if (o) return `o${o.version}`;
    const st = statOf(fileName);
    return st ? `d${st.mtimeMs}:${st.size}` : 'missing';
  };
  const scriptSnapshot = (fileName: string): ts.IScriptSnapshot | undefined => {
    const k = keyOf(fileName);
    const o = overlay.get(k);
    if (o) return ts.ScriptSnapshot.fromString(o.text);
    const version = scriptVersion(fileName);
    if (version === 'missing') return undefined;
    const cached = diskSnapshots.get(k);
    if (cached?.version === version) return cached.snapshot;
    const text = readFile(fileName);
    if (text === undefined) return undefined;
    const snapshot = ts.ScriptSnapshot.fromString(text);
    diskSnapshots.set(k, { version, snapshot });
    return snapshot;
  };

  const parseHost: ts.ParseConfigFileHost = {
    useCaseSensitiveFileNames: caseSensitive,
    readDirectory,
    fileExists,
    readFile,
    getCurrentDirectory: () => root,
    onUnRecoverableConfigFileDiagnostic: () => {},
  };

  const configStampOf = (configPath: string): string | null => {
    const st = statOf(configPath);
    return st ? `${st.mtimeMs}:${st.size}` : null;
  };

  /** 解析配置;解析失败(读不到等)→ null。plugins 显式去掉(本来也不会加载)。 */
  const parseConfig = (configPath: string) => {
    const isJs = path.basename(configPath).toLowerCase() === 'jsconfig.json';
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, isJs ? JSCONFIG_DEFAULTS : {}, parseHost);
    if (!parsed) return null;
    const options: ts.CompilerOptions = { ...parsed.options, noEmit: true };
    delete options['plugins'];
    return { options, fileNames: parsed.fileNames.map(toTsPath), references: parsed.projectReferences };
  };

  /** 建项目的语言服务(createLanguageService 会立即调用 host,项目对象须先建好)。 */
  const attachService = (p: Project): Project => {
    const getProject = () => p;
    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => getProject().options,
      getScriptFileNames: () => getProject().fileNames,
      getProjectReferences: () => getProject().references,
      getScriptVersion: scriptVersion,
      getScriptSnapshot: scriptSnapshot,
      getCurrentDirectory: () => getProject().dir,
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      fileExists,
      readFile,
      readDirectory,
      directoryExists,
      getDirectories,
      useCaseSensitiveFileNames: () => caseSensitive,
    };
    p.service = ts.createLanguageService(host, registry);
    return p;
  };

  const refreshConfig = (p: Project): void => {
    if (p.configPath === null) return;
    const parsed = parseConfig(p.configPath);
    p.configStamp = configStampOf(p.configPath);
    p.parsedAt = now();
    if (!parsed) {
      p.fileNames = [];
      p.fileSet = new Set();
      p.references = undefined;
      return;
    }
    p.options = parsed.options;
    p.fileNames = parsed.fileNames;
    p.fileSet = new Set(parsed.fileNames.map(keyOf));
    p.references = parsed.references;
  };

  const configProject = (configPath: string): Project => {
    const key = keyOf(configPath);
    let p = projects.get(key);
    if (!p) {
      p = attachService({
        key,
        configPath,
        dir: path.dirname(configPath),
        options: {},
        fileNames: [],
        fileSet: new Set(),
        references: undefined,
        configStamp: null,
        parsedAt: 0,
        service: undefined as unknown as ts.LanguageService,
      });
      projects.set(key, p);
      refreshConfig(p);
    } else if (configStampOf(configPath) !== p.configStamp) {
      refreshConfig(p);
    }
    return p;
  };

  /** 项目是否包含文件;不包含且配置上次解析已过 1 秒 → 重新解析一次(配置 include 之下新建的文件)。 */
  const contains = (p: Project, k: string): boolean => {
    if (p.fileSet.has(k)) return true;
    if (now() - p.parsedAt < 1000) return false;
    refreshConfig(p);
    return p.fileSet.has(k);
  };

  const nearestConfig = (fromDir: string): string | null => {
    for (let dir = fromDir; isInside(root, dir); dir = path.dirname(dir)) {
      for (const name of ['tsconfig.json', 'jsconfig.json']) {
        const candidate = path.join(dir, name);
        if (statOf(candidate)?.isFile()) return candidate;
      }
      if (dir === path.dirname(dir)) break;
    }
    return null;
  };

  const referencedProject = (p: Project, k: string, depth: number, seen: Set<string>): Project | null => {
    if (depth > REFERENCE_DEPTH_MAX) return null;
    for (const ref of p.references ?? []) {
      const refPath = ts.resolveProjectReferencePath(ref);
      if (!canRead(refPath) || seen.has(keyOf(refPath)) || !statOf(refPath)?.isFile()) continue;
      seen.add(keyOf(refPath));
      const child = configProject(refPath);
      if (contains(child, k)) return child;
      const deeper = referencedProject(child, k, depth + 1, seen);
      if (deeper) return deeper;
    }
    return null;
  };

  const inferredProject = (fileName: string, k: string): Project => {
    if (!inferredRoots.has(k)) {
      if (inferredRoots.size >= INFERRED_ROOTS_MAX) inferredRoots.clear();
      inferredRoots.set(k, fileName);
    }
    if (!inferred) {
      inferred = attachService({
        key: '',
        configPath: null,
        dir: root,
        options: INFERRED_OPTIONS,
        fileNames: [],
        fileSet: new Set(),
        references: undefined,
        configStamp: null,
        parsedAt: 0,
        service: undefined as unknown as ts.LanguageService,
      });
    }
    inferred.fileNames = [...inferredRoots.values()];
    inferred.fileSet = new Set(inferredRoots.keys());
    return inferred;
  };

  const projectFor = (fileName: string): Project => {
    const k = keyOf(fileName);
    let configPath = nearestConfig(path.dirname(fileName));
    const seen = new Set<string>();
    while (configPath !== null) {
      seen.add(keyOf(configPath));
      const p = configProject(configPath);
      if (contains(p, k)) return p;
      const viaRef = referencedProject(p, k, 1, seen);
      if (viaRef) return viaRef;
      const parentDir = path.dirname(path.dirname(configPath));
      if (parentDir === path.dirname(configPath)) break;
      configPath = nearestConfig(parentDir);
    }
    return inferredProject(fileName, k);
  };

  const beginRequest = (): void => {
    statCache = new Map();
  };

  const rangeOf = (sf: ts.SourceFile, span: ts.TextSpan): TsRange => {
    const start = sf.getLineAndCharacterOfPosition(span.start);
    const end = sf.getLineAndCharacterOfPosition(span.start + span.length);
    return { line: start.line + 1, column: start.character + 1, endLine: end.line + 1, endColumn: end.character + 1 };
  };

  const sourceFileOf = (p: Project, fileName: string): ts.SourceFile | undefined => {
    const program = p.service.getProgram();
    const sf = program?.getSourceFile(fileName);
    if (sf) return sf;
    // 不在程序里(少见:定义在项目之外的文件)→ 按快照临时建一份只用于行列换算
    const snap = scriptSnapshot(fileName);
    return snap ? ts.createSourceFile(fileName, snap.getText(0, snap.getLength()), ts.ScriptTarget.Latest) : undefined;
  };

  const previewOf = (sf: ts.SourceFile, line0: number): string => {
    const starts = sf.getLineStarts();
    const from = starts[line0] ?? 0;
    const to = starts[line0 + 1] ?? sf.text.length;
    return sf.text.slice(from, to).trim().slice(0, TS_PREVIEW_MAX);
  };

  return {
    applyChanges(changes) {
      for (const c of changes) {
        const fileName = toTsPath(c.path);
        const k = keyOf(fileName);
        if (c.text === null) overlay.delete(k);
        else overlay.set(k, { fileName, text: c.text, version: ++overlaySeq });
      }
    },
    warmup(p) {
      beginRequest();
      const fileName = toTsPath(p);
      if (!canRead(fileName)) return;
      projectFor(fileName).service.getProgram();
    },
    definition(p, line, column) {
      beginRequest();
      const fileName = toTsPath(p);
      if (!canRead(fileName)) return { origin: null, definitions: [] };
      const project = projectFor(fileName);
      const sf = project.service.getProgram()?.getSourceFile(fileName);
      if (!sf) return { origin: null, definitions: [] };
      const starts = sf.getLineStarts();
      const lineIndex = Math.min(Math.max(line - 1, 0), starts.length - 1);
      const lineEnd = lineIndex + 1 < starts.length ? starts[lineIndex + 1]! : sf.text.length;
      const pos = Math.min(starts[lineIndex]! + Math.max(column - 1, 0), lineEnd);
      const r = project.service.getDefinitionAndBoundSpan(fileName, pos);
      if (!r || !r.definitions || r.definitions.length === 0) return { origin: null, definitions: [] };
      const definitions: TsLocation[] = [];
      for (const d of r.definitions.slice(0, TS_DEFINITIONS_MAX)) {
        const target = sourceFileOf(project, d.fileName);
        if (!target) continue;
        const range = rangeOf(target, d.textSpan);
        definitions.push({ path: toNativePath(d.fileName), ...range, preview: previewOf(target, range.line - 1) });
      }
      return { origin: definitions.length > 0 ? rangeOf(sf, r.textSpan) : null, definitions };
    },
    dispose() {
      for (const p of projects.values()) p.service.dispose();
      inferred?.service.dispose();
      projects.clear();
      overlay.clear();
      diskSnapshots.clear();
    },
  };
}
