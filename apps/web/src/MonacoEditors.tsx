import React, { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import "monaco-editor/esm/vs/language/css/monaco.contribution";
import "monaco-editor/esm/vs/language/html/monaco.contribution";
import "monaco-editor/esm/vs/language/json/monaco.contribution";
import "monaco-editor/esm/vs/language/typescript/monaco.contribution";
import "monaco-editor/esm/vs/basic-languages/bat/bat.contribution";
import "monaco-editor/esm/vs/basic-languages/bicep/bicep.contribution";
import "monaco-editor/esm/vs/basic-languages/clojure/clojure.contribution";
import "monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution";
import "monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution";
import "monaco-editor/esm/vs/basic-languages/dart/dart.contribution";
import "monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution";
import "monaco-editor/esm/vs/basic-languages/elixir/elixir.contribution";
import "monaco-editor/esm/vs/basic-languages/fsharp/fsharp.contribution";
import "monaco-editor/esm/vs/basic-languages/go/go.contribution";
import "monaco-editor/esm/vs/basic-languages/graphql/graphql.contribution";
import "monaco-editor/esm/vs/basic-languages/hcl/hcl.contribution";
import "monaco-editor/esm/vs/basic-languages/ini/ini.contribution";
import "monaco-editor/esm/vs/basic-languages/java/java.contribution";
import "monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution";
import "monaco-editor/esm/vs/basic-languages/lua/lua.contribution";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution";
import "monaco-editor/esm/vs/basic-languages/mdx/mdx.contribution";
import "monaco-editor/esm/vs/basic-languages/mysql/mysql.contribution";
import "monaco-editor/esm/vs/basic-languages/perl/perl.contribution";
import "monaco-editor/esm/vs/basic-languages/pgsql/pgsql.contribution";
import "monaco-editor/esm/vs/basic-languages/php/php.contribution";
import "monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution";
import "monaco-editor/esm/vs/basic-languages/protobuf/protobuf.contribution";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution";
import "monaco-editor/esm/vs/basic-languages/r/r.contribution";
import "monaco-editor/esm/vs/basic-languages/redis/redis.contribution";
import "monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution";
import "monaco-editor/esm/vs/basic-languages/rust/rust.contribution";
import "monaco-editor/esm/vs/basic-languages/scala/scala.contribution";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution";
import "monaco-editor/esm/vs/basic-languages/solidity/solidity.contribution";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution";
import "monaco-editor/esm/vs/basic-languages/swift/swift.contribution";
import "monaco-editor/esm/vs/basic-languages/twig/twig.contribution";
import "monaco-editor/esm/vs/basic-languages/vb/vb.contribution";
import "monaco-editor/esm/vs/basic-languages/xml/xml.contribution";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution";

(self as unknown as {
  MonacoEnvironment?: {
    getWorker: (_moduleId: string, label: string) => Worker;
  };
}).MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new CssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  }
};

type EditorTheme = "xedoc-light" | "xedoc-dark" | "xedoc-aurora" | "xedoc-midnight" | "vs-light" | "vs-dark" | "hc-black";
type IdeEditorCommand = "focus" | "selectAll" | "format";
type IdeEditorCommandRequest = {
  id: number;
  command: IdeEditorCommand;
};
type EditorCursorState = {
  lineNumber: number;
  column: number;
  selectionLength: number;
};
type ProjectFileEntry = {
  path: string;
  name: string;
  type: "file" | "directory";
  depth: number;
  size?: number;
  mtimeMs?: number;
};

const XEDOC_EDITOR_THEME_DEFINITIONS: Record<string, monaco.editor.IStandaloneThemeData> = {
  "xedoc-light": {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6b7280", fontStyle: "italic" },
      { token: "keyword", foreground: "a40e26", fontStyle: "bold" },
      { token: "number", foreground: "7c3aed" },
      { token: "string", foreground: "0a7a53" },
      { token: "regexp", foreground: "b45309" },
      { token: "type.identifier", foreground: "8250df" },
      { token: "identifier", foreground: "1f2937" },
      { token: "delimiter", foreground: "57606a" }
    ],
    colors: {
      "editor.background": "#fbfbf8",
      "editor.foreground": "#1f2328",
      "editorLineNumber.foreground": "#8c959f",
      "editorLineNumber.activeForeground": "#0969da",
      "editorCursor.foreground": "#0969da",
      "editor.selectionBackground": "#0969da2b",
      "editor.inactiveSelectionBackground": "#0969da18",
      "editor.lineHighlightBackground": "#0969da0d",
      "editor.findMatchBackground": "#ffd33d66",
      "editor.findMatchHighlightBackground": "#ffd33d33",
      "editorBracketMatch.background": "#54aeff22",
      "editorBracketMatch.border": "#0969da"
    }
  },
  "xedoc-dark": {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "8b949e", fontStyle: "italic" },
      { token: "keyword", foreground: "ff7b72", fontStyle: "bold" },
      { token: "number", foreground: "d2a8ff" },
      { token: "string", foreground: "a5d6ff" },
      { token: "regexp", foreground: "ffa657" },
      { token: "type.identifier", foreground: "79c0ff" },
      { token: "identifier", foreground: "e6edf3" },
      { token: "delimiter", foreground: "c9d1d9" }
    ],
    colors: {
      "editor.background": "#101214",
      "editor.foreground": "#e6edf3",
      "editorLineNumber.foreground": "#6e7681",
      "editorLineNumber.activeForeground": "#7ee787",
      "editorCursor.foreground": "#7ee787",
      "editor.selectionBackground": "#2f81f74a",
      "editor.inactiveSelectionBackground": "#2f81f72a",
      "editor.lineHighlightBackground": "#7ee7870f",
      "editor.findMatchBackground": "#d2992255",
      "editor.findMatchHighlightBackground": "#d2992228",
      "editorBracketMatch.background": "#23863638",
      "editorBracketMatch.border": "#7ee787"
    }
  },
  "xedoc-aurora": {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "94a3b8", fontStyle: "italic" },
      { token: "keyword", foreground: "f472b6", fontStyle: "bold" },
      { token: "number", foreground: "c084fc" },
      { token: "string", foreground: "67e8f9" },
      { token: "regexp", foreground: "fbbf24" },
      { token: "type.identifier", foreground: "a78bfa" },
      { token: "identifier", foreground: "e2e8f0" },
      { token: "delimiter", foreground: "cbd5e1" }
    ],
    colors: {
      "editor.background": "#0f172a",
      "editor.foreground": "#e2e8f0",
      "editorLineNumber.foreground": "#64748b",
      "editorLineNumber.activeForeground": "#67e8f9",
      "editorCursor.foreground": "#f472b6",
      "editor.selectionBackground": "#67e8f933",
      "editor.inactiveSelectionBackground": "#67e8f91e",
      "editor.lineHighlightBackground": "#f472b60f",
      "editor.findMatchBackground": "#fbbf2455",
      "editor.findMatchHighlightBackground": "#fbbf2426",
      "editorBracketMatch.background": "#c084fc30",
      "editorBracketMatch.border": "#c084fc"
    }
  },
  "xedoc-midnight": {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "7c8aa5", fontStyle: "italic" },
      { token: "keyword", foreground: "93c5fd", fontStyle: "bold" },
      { token: "number", foreground: "fbbf24" },
      { token: "string", foreground: "34d399" },
      { token: "regexp", foreground: "fb7185" },
      { token: "type.identifier", foreground: "c4b5fd" },
      { token: "identifier", foreground: "e5e7eb" },
      { token: "delimiter", foreground: "cbd5e1" }
    ],
    colors: {
      "editor.background": "#0b1020",
      "editor.foreground": "#e5e7eb",
      "editorLineNumber.foreground": "#64748b",
      "editorLineNumber.activeForeground": "#93c5fd",
      "editorCursor.foreground": "#fbbf24",
      "editor.selectionBackground": "#1d4ed84f",
      "editor.inactiveSelectionBackground": "#1d4ed82b",
      "editor.lineHighlightBackground": "#93c5fd0e",
      "editor.findMatchBackground": "#fbbf2452",
      "editor.findMatchHighlightBackground": "#fbbf2424",
      "editorBracketMatch.background": "#1d4ed838",
      "editorBracketMatch.border": "#93c5fd"
    }
  }
};

for (const [themeName, themeData] of Object.entries(XEDOC_EDITOR_THEME_DEFINITIONS)) {
  monaco.editor.defineTheme(themeName, themeData);
}

function normalizeProjectFilePath(path: string) {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
}

function filePathLooksOpenable(value: string): boolean {
  return /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9][A-Za-z0-9_.-]{0,16}$/.test(value);
}

function stripReferenceLineSuffix(value: string): string {
  const match = value.match(/^(.+\.[A-Za-z0-9][A-Za-z0-9_.-]{0,16})(?::\d+(?::\d+)?)$/);
  return match?.[1] ?? value;
}

function editorLanguageFromPath(path: string): string {
  const filename = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (filename === "dockerfile" || filename.endsWith(".dockerfile")) return "dockerfile";
  if (filename === "makefile") return "makefile";
  if (filename === ".gitignore" || filename === ".dockerignore") return "plaintext";
  if (filename === ".env" || filename.startsWith(".env.")) return "ini";
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["ts", "tsx", "mts", "cts"].includes(ext)) return "typescript";
  if (["js", "jsx", "mjs", "cjs"].includes(ext)) return "javascript";
  if (ext === "json") return "json";
  if (ext === "css") return "css";
  if (["scss", "sass"].includes(ext)) return "scss";
  if (ext === "less") return "less";
  if (["html", "htm"].includes(ext)) return "html";
  if (["vue", "svelte", "astro", "ejs"].includes(ext)) return "html";
  if (ext === "xml") return "xml";
  if (["svg", "xhtml"].includes(ext)) return "xml";
  if (["md", "markdown"].includes(ext)) return "markdown";
  if (ext === "mdx") return "mdx";
  if (["yml", "yaml"].includes(ext)) return "yaml";
  if (["sh", "bash", "zsh"].includes(ext)) return "shell";
  if (["bat", "cmd"].includes(ext)) return "bat";
  if (["ps1", "psm1"].includes(ext)) return "powershell";
  if (ext === "sql") return filename.includes("mysql") ? "mysql" : filename.includes("pgsql") || filename.includes("postgres") ? "pgsql" : "sql";
  if (ext === "mysql") return "mysql";
  if (["pgsql", "psql"].includes(ext)) return "pgsql";
  if (ext === "py") return "python";
  if (ext === "go") return "go";
  if (ext === "rs") return "rust";
  if (ext === "java") return "java";
  if (["kt", "kts"].includes(ext)) return "kotlin";
  if (["php", "php4", "php5", "phtml", "ctp", "inc"].includes(ext) || filename.endsWith(".blade.php")) return "php";
  if (["toml", "ini", "conf", "cfg", "editorconfig"].includes(ext)) return "ini";
  if (["hcl", "tf", "tfvars"].includes(ext)) return "hcl";
  if (ext === "bicep") return "bicep";
  if (ext === "sol") return "solidity";
  if (ext === "proto") return "protobuf";
  if (ext === "redis") return "redis";
  if (ext === "twig") return "twig";
  if (["rb", "rake"].includes(ext) || filename === "gemfile") return "ruby";
  if (["c", "h", "cc", "cpp", "cxx", "hpp", "hxx"].includes(ext)) return "cpp";
  if (["cs", "csx"].includes(ext)) return "csharp";
  if (["fs", "fsi", "fsx"].includes(ext)) return "fsharp";
  if (["vb", "vbs"].includes(ext)) return "vb";
  if (["swift"].includes(ext)) return "swift";
  if (["dart"].includes(ext)) return "dart";
  if (["lua"].includes(ext)) return "lua";
  if (["pl", "pm"].includes(ext)) return "perl";
  if (["r"].includes(ext)) return "r";
  if (["scala", "sc"].includes(ext)) return "scala";
  if (["clj", "cljs", "cljc"].includes(ext)) return "clojure";
  if (["ex", "exs"].includes(ext)) return "elixir";
  if (["graphql", "gql"].includes(ext)) return "graphql";
  return "plaintext";
}

const PROJECT_REFERENCE_EXTENSION_CANDIDATES = [
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "css", "scss", "sass", "less",
  "html", "htm", "vue", "svelte", "astro", "php", "phtml", "sql", "mysql", "pgsql",
  "py", "go", "rs", "java", "kt", "kts", "rb", "c", "h", "cpp", "hpp", "cs",
  "swift", "dart", "lua", "pl", "pm", "r", "scala", "clj", "ex", "exs",
  "graphql", "gql", "md", "mdx", "yml", "yaml", "toml", "ini", "conf", "cfg",
  "hcl", "tf", "tfvars", "bicep", "sol", "proto", "twig", "svg", "png", "jpg",
  "jpeg", "webp"
];

function normalizeRelativeProjectPath(path: string) {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

function currentProjectFileDirectory(path: string) {
  const parts = normalizeProjectFilePath(path).split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function cleanEditorReferenceCandidate(value: string) {
  let candidate = value.trim().replace(/^['"`(<[{]+|['"`)>}\],.;:]+$/g, "");
  if (!candidate || candidate.includes("\0")) return "";
  candidate = stripReferenceLineSuffix(candidate);
  try {
    if (/^https?:\/\//i.test(candidate)) candidate = decodeURIComponent(new URL(candidate).pathname);
  } catch {
    return "";
  }
  try {
    candidate = decodeURIComponent(candidate);
  } catch {
    // Keep the raw candidate if percent-decoding fails.
  }
  return candidate.replace(/[?#].*$/g, "").replace(/\\/g, "/").trim();
}

function projectFileCandidatesFromReference(rawValue: string, currentPath: string) {
  const cleaned = cleanEditorReferenceCandidate(rawValue);
  if (!cleaned || cleaned.includes("://") || cleaned === ".git" || cleaned.startsWith(".git/")) return [];
  const baseDir = currentProjectFileDirectory(currentPath);
  const primary = cleaned.startsWith(".")
    ? normalizeRelativeProjectPath(`${baseDir}/${cleaned}`)
    : normalizeRelativeProjectPath(cleaned.replace(/^\/+/, ""));
  if (!primary) return [];
  const candidates = [primary];
  const leaf = primary.split("/").pop() ?? primary;
  const hasExtension = /\.[A-Za-z0-9][A-Za-z0-9_.-]{0,16}$/.test(leaf);
  if (!hasExtension) {
    for (const ext of PROJECT_REFERENCE_EXTENSION_CANDIDATES) {
      candidates.push(`${primary}.${ext}`);
      candidates.push(`${primary}/index.${ext}`);
    }
  }
  return [...new Set(candidates)];
}

function resolveProjectFileReference(rawValue: string, currentPath: string, entries: ProjectFileEntry[]) {
  const candidates = projectFileCandidatesFromReference(rawValue, currentPath);
  if (!candidates.length) return "";
  const files = entries.filter((entry) => entry.type === "file");
  const byPath = new Map(files.map((entry) => [normalizeProjectFilePath(entry.path).toLowerCase(), normalizeProjectFilePath(entry.path)]));
  for (const candidate of candidates) {
    const match = byPath.get(normalizeProjectFilePath(candidate).toLowerCase());
    if (match) return match;
  }
  if (!files.length) {
    const fallback = candidates.find(filePathLooksOpenable);
    return fallback ? normalizeProjectFilePath(fallback) : "";
  }
  const leaf = normalizeProjectFilePath(candidates[0] ?? "").split("/").filter(Boolean).pop()?.toLowerCase();
  if (!leaf) return "";
  const leafMatches = files
    .map((entry) => normalizeProjectFilePath(entry.path))
    .filter((path) => path.split("/").pop()?.toLowerCase() === leaf);
  return leafMatches.length === 1 ? leafMatches[0] : "";
}

function editorReferenceAtPosition(model: monaco.editor.ITextModel, position: monaco.Position) {
  const line = model.getLineContent(position.lineNumber);
  const offset = Math.max(0, position.column - 1);
  const pattern = /(["'`])([^"'`\s]+)\1|[^\s"'`()<>[\]{}]+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line))) {
    const start = match.index;
    const end = match.index + match[0].length;
    if (offset < start || offset > end) continue;
    return match[2] ?? match[0];
  }
  return "";
}

function editorSelectedText(editor: monaco.editor.ICodeEditor, model: monaco.editor.ITextModel) {
  const selections = editor.getSelections() ?? [];
  return selections
    .map((selection) => model.getValueInRange(selection).trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function projectFileTargetAtEditorPosition(
  editor: monaco.editor.ICodeEditor,
  model: monaco.editor.ITextModel,
  currentPath: string,
  entries: ProjectFileEntry[],
  position = editor.getPosition()
) {
  const selected = editorSelectedText(editor, model);
  const selectedTarget = selected ? resolveProjectFileReference(selected, currentPath, entries) : "";
  if (selectedTarget) return selectedTarget;
  if (!position) return "";
  return resolveProjectFileReference(editorReferenceAtPosition(model, position), currentPath, entries);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function revealSymbolDefinitionInModel(editor: monaco.editor.ICodeEditor, model: monaco.editor.ITextModel, position = editor.getPosition()) {
  const selected = editorSelectedText(editor, model);
  const symbol = selected && /^[A-Za-z_$][\w$]*$/.test(selected)
    ? selected
    : position
      ? model.getWordAtPosition(position)?.word ?? ""
      : "";
  if (!symbol) return false;
  const escaped = escapeRegExp(symbol);
  const patterns = [
    new RegExp(`\\b(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\b`),
    new RegExp(`\\b(?:export\\s+)?(?:class|interface|type|enum)\\s+${escaped}\\b`),
    new RegExp(`\\b(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\b`),
    new RegExp(`\\b${escaped}\\s*[:=]\\s*`)
  ];
  const currentLine = position?.lineNumber ?? 0;
  for (let lineNumber = 1; lineNumber <= model.getLineCount(); lineNumber += 1) {
    const line = model.getLineContent(lineNumber);
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (!match || (lineNumber === currentLine && (match.index ?? 0) + 1 === position?.column)) continue;
      const column = (match.index ?? 0) + 1;
      editor.setPosition({ lineNumber, column });
      editor.revealPositionInCenterIfOutsideViewport({ lineNumber, column }, monaco.editor.ScrollType.Smooth);
      editor.focus();
      return true;
    }
  }
  return false;
}

type MonacoCodeEditorProps = {
  value: string;
  path: string;
  theme: EditorTheme;
  findQuery: string;
  findIndex: number;
  command?: IdeEditorCommandRequest | null;
  onChange: (value: string) => void;
  onSave?: () => void;
  onCursorChange?: (cursor: EditorCursorState) => void;
  projectFiles?: ProjectFileEntry[];
  onOpenFile?: (path: string) => void | Promise<void>;
};

export function MonacoCodeEditor({
  value,
  path,
  theme,
  findQuery,
  findIndex,
  command,
  onChange,
  onSave,
  onCursorChange,
  projectFiles = [],
  onOpenFile
}: MonacoCodeEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<monaco.editor.ITextModel | null>(null);
  const decorationRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onCursorChangeRef = useRef(onCursorChange);
  const onOpenFileRef = useRef(onOpenFile);
  const projectFilesRef = useRef(projectFiles);
  const pathRef = useRef(path);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    onCursorChangeRef.current = onCursorChange;
  }, [onCursorChange]);

  useEffect(() => {
    onOpenFileRef.current = onOpenFile;
  }, [onOpenFile]);

  useEffect(() => {
    projectFilesRef.current = projectFiles;
  }, [projectFiles]);

  useEffect(() => {
    pathRef.current = path;
  }, [path]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const compactEditor = typeof window !== "undefined" && window.matchMedia("(max-width: 480px)").matches;
    const uri = monaco.Uri.parse(`file:///${path.replace(/\\/g, "/").replace(/^\/+/, "")}`);
    const model = monaco.editor.createModel(value, editorLanguageFromPath(path), uri);
    modelRef.current = model;
    const editor = monaco.editor.create(container, {
      model,
      theme,
      automaticLayout: true,
      minimap: compactEditor ? { enabled: false } : { enabled: true, maxColumn: 90, renderCharacters: false, scale: 0.72 },
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, Liberation Mono, monospace",
      fontSize: compactEditor ? 12 : 13,
      lineHeight: compactEditor ? 18 : 20,
      scrollBeyondLastLine: false,
      scrollBeyondLastColumn: compactEditor ? 0 : 5,
      wordWrap: compactEditor ? "on" : "off",
      wrappingIndent: "same",
      lineNumbersMinChars: compactEditor ? 2 : 5,
      tabSize: 2,
      insertSpaces: true,
      renderWhitespace: "selection",
      roundedSelection: false,
      bracketPairColorization: { enabled: true },
      guides: {
        bracketPairs: true,
        indentation: true
      },
      occurrencesHighlight: "multiFile",
      renderLineHighlight: "all",
      cursorBlinking: "smooth",
      cursorSmoothCaretAnimation: "on",
      smoothScrolling: true,
      contextmenu: true,
      fixedOverflowWidgets: true
    });
    editorRef.current = editor;
    decorationRef.current = editor.createDecorationsCollection();
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onSaveRef.current?.();
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyA, () => {
      editor.setSelection(model.getFullModelRange());
      editor.revealPosition({ lineNumber: 1, column: 1 }, monaco.editor.ScrollType.Immediate);
      editor.focus();
    });
    const openFileAtPosition = (position: monaco.Position | null) => {
      const target = projectFileTargetAtEditorPosition(editor, model, pathRef.current, projectFilesRef.current, position);
      if (!target) return false;
      void onOpenFileRef.current?.(target);
      return true;
    };
    const goToDefinitionAtPosition = (position: monaco.Position | null) => {
      if (openFileAtPosition(position)) return true;
      return revealSymbolDefinitionInModel(editor, model, position ?? editor.getPosition());
    };
    const mouseSubscription = editor.onMouseDown((event) => {
      if (!event.event.leftButton || (!event.event.ctrlKey && !event.event.metaKey)) return;
      if (event.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT) return;
      const position = event.target.position;
      if (!position) return;
      if (!goToDefinitionAtPosition(position)) return;
      event.event.preventDefault();
      event.event.stopPropagation();
    });
    const goToFileAction = editor.addAction({
      id: "xedoc.goToFile",
      label: "Go to File",
      contextMenuGroupId: "navigation",
      contextMenuOrder: 1.1,
      run: () => {
        openFileAtPosition(editor.getPosition());
      }
    });
    const goToDefinitionAction = editor.addAction({
      id: "xedoc.goToDefinition",
      label: "Go to Definition",
      contextMenuGroupId: "navigation",
      contextMenuOrder: 1.2,
      run: () => {
        goToDefinitionAtPosition(editor.getPosition());
      }
    });
    const reportCursor = () => {
      const position = editor.getPosition();
      if (!position) return;
      const selection = editor.getSelection();
      const selectionLength = selection ? model.getValueInRange(selection).length : 0;
      onCursorChangeRef.current?.({
        lineNumber: position.lineNumber,
        column: position.column,
        selectionLength
      });
    };
    reportCursor();
    const subscription = editor.onDidChangeModelContent(() => {
      onChangeRef.current(model.getValue());
      reportCursor();
    });
    const cursorSubscription = editor.onDidChangeCursorPosition(reportCursor);
    const selectionSubscription = editor.onDidChangeCursorSelection(reportCursor);
    return () => {
      subscription.dispose();
      cursorSubscription.dispose();
      selectionSubscription.dispose();
      mouseSubscription.dispose();
      goToFileAction.dispose();
      goToDefinitionAction.dispose();
      decorationRef.current?.clear();
      decorationRef.current = null;
      editor.dispose();
      model.dispose();
      editorRef.current = null;
      modelRef.current = null;
    };
  }, [path]);

  useEffect(() => {
    const model = modelRef.current;
    if (!model || model.getValue() === value) return;
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], () => null);
  }, [value]);

  useEffect(() => {
    monaco.editor.setTheme(theme);
  }, [theme]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !command) return;
    if (command.command === "focus") {
      editor.focus();
      return;
    }
    if (command.command === "selectAll") {
      editor.trigger("xedoc-menu", "editor.action.selectAll", null);
      editor.focus();
      return;
    }
    if (command.command === "format") {
      void editor.getAction("editor.action.formatDocument")?.run().finally(() => editor.focus());
    }
  }, [command]);

  useEffect(() => {
    const editor = editorRef.current;
    const model = modelRef.current;
    if (!editor || !model) return;
    const needle = findQuery.trim();
    if (!needle) {
      decorationRef.current?.clear();
      return;
    }
    const matches = model.findMatches(needle, false, false, false, null, true, 1000);
    decorationRef.current?.set(matches.map((match) => ({
      range: match.range,
      options: {
        className: "monaco-find-line",
        inlineClassName: "monaco-find-match"
      }
    })));
    if (!matches.length) return;
    const match = matches[((findIndex % matches.length) + matches.length) % matches.length];
    if (!match) return;
    editor.setSelection(match.range);
    editor.revealRangeInCenterIfOutsideViewport(match.range, monaco.editor.ScrollType.Smooth);
  }, [findIndex, findQuery, value]);

  return <div className="monaco-editor-host" ref={containerRef} />;
}

export function MonacoReadOnlyCodeViewer({ value, path }: { value: string; path: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<monaco.editor.ITextModel | null>(null);
  const heightPx = Math.max(220, Math.min(780, value.split(/\r\n|\r|\n/).length * 20 + 34));

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const uri = monaco.Uri.parse(`file:///public/${path.replace(/\\/g, "/").replace(/^\/+/, "")}`);
    const model = monaco.editor.createModel(value, editorLanguageFromPath(path), uri);
    modelRef.current = model;
    monaco.editor.setTheme("xedoc-light");
    const editor = monaco.editor.create(container, {
      model,
      theme: "xedoc-light",
      readOnly: true,
      domReadOnly: true,
      automaticLayout: true,
      minimap: { enabled: true, maxColumn: 90, renderCharacters: false, scale: 0.72 },
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, Liberation Mono, monospace",
      fontSize: 13,
      lineHeight: 20,
      scrollBeyondLastLine: false,
      wordWrap: "off",
      tabSize: 2,
      renderWhitespace: "selection",
      roundedSelection: false,
      bracketPairColorization: { enabled: true },
      guides: {
        bracketPairs: true,
        indentation: true
      },
      renderLineHighlight: "all",
      smoothScrolling: true,
      contextmenu: true,
      fixedOverflowWidgets: true
    });
    editorRef.current = editor;
    return () => {
      editor.dispose();
      model.dispose();
      editorRef.current = null;
      modelRef.current = null;
    };
  }, [path]);

  useEffect(() => {
    const model = modelRef.current;
    if (!model || model.getValue() === value) return;
    model.setValue(value);
  }, [value]);

  return <div className="monaco-editor-host public-file-code-editor" ref={containerRef} style={{ height: `min(72vh, ${heightPx}px)` }} />;
}
