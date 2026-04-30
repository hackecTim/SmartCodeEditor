//Preveri odvisnosti
if (typeof SmartCodeConfig === "undefined") throw new Error("config.js ni naložen!");
if (typeof CodeMirror === "undefined") throw new Error("codemirror.js ni naložen!");

let editor;
const CFG = SmartCodeConfig;

const fileStates = new Map();
let activeFile = null;

let diagnosticMarks = [];
const diagnosticsByFile = new Map();

let autosaveTimer = null;
let completionTimer = null;
let signatureTimer = null;
let isFileSwitch = false;
let suppressInputRead = false;
let completionReqSeq = 0;
let clangdInitialized = false;
let javaInitialized = false;
const openedDocs = new Set();

let activeFolderHandle = null;

const DEBUG_LSP = false;

// Funkcije za pomoč

function debugLog(...args) {
  if (DEBUG_LSP) console.log(...args);
}

function hasServerSupport() {
  return !!(CFG.server?.httpUrl && CFG.server?.wsClangd && CFG.server?.wsJava);
}

function supportsFsAccess() {
  return !!window.showOpenFilePicker && !!window.showDirectoryPicker;
}

function normalizePath(path) {
  return String(path || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function baseName(path) {
  const p = normalizePath(path);
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapePathSegment(segment) {
  return encodeURIComponent(segment).replace(/%2F/g, "/");
}

function severityToClass(severity) {
  if (severity === 1) return "error";
  if (severity === 2) return "warning";
  if (severity === 3) return "info";
  return "hint";
}

function severityToLabel(severity) {
  if (severity === 1) return "Error";
  if (severity === 2) return "Warning";
  if (severity === 3) return "Info";
  return "Hint";
}

//Browser cache

function cacheKeyForFile(filename) {
  return `smartcode:file:${normalizePath(filename)}`;
}

function cacheFileListKey() {
  return "smartcode:filelist";
}

function persistFileListToBrowser() {
  try {
    localStorage.setItem(cacheFileListKey(), JSON.stringify([...fileStates.keys()]));
  } catch (e) {
    console.warn("persistFileListToBrowser failed:", e.message);
  }
}

function persistFileToBrowser(filename, content) {
  try {
    localStorage.setItem(cacheKeyForFile(filename), content ?? "");
    persistFileListToBrowser();
    return true;
  } catch (e) {
    console.warn("persistFileToBrowser failed:", e.message);
    return false;
  }
}

function readFileFromBrowser(filename) {
  try {
    return localStorage.getItem(cacheKeyForFile(filename));
  } catch {
    return null;
  }
}

function loadBrowserWorkspace() {
  try {
    const raw = localStorage.getItem(cacheFileListKey());
    const files = raw ? JSON.parse(raw) : [];

    for (const filename of files) {
      const norm = normalizePath(filename);
      const text = readFileFromBrowser(norm);
      if (text !== null && !fileStates.has(norm)) {
        fileStates.set(norm, createFileState(norm, {
          content: text,
          dirty: false
        }));
      }
    }
  } catch (e) {
    console.warn("loadBrowserWorkspace failed:", e.message);
  }
}

//Pregled končnice

function modeForFile(filename) {
  const f = normalizePath(filename).toLowerCase();
  if (f.endsWith(".java")) return "text/x-java";
  if (f.endsWith(".c")) return "text/x-csrc";
  if (
    f.endsWith(".cpp") ||
    f.endsWith(".cc") ||
    f.endsWith(".cxx") ||
    f.endsWith(".h") ||
    f.endsWith(".hpp")
  ) return "text/x-c++src";
  return "text/plain";
}

const languageIds = {
  "text/x-java": "java",
  "text/x-csrc": "c",
  "text/x-c++src": "cpp",
  "text/plain": "plaintext"
};

const themes = {
  "text/x-java": "eclipse",
  "text/x-csrc": "eclipse",
  "text/x-c++src": "eclipse",
  "text/plain": "eclipse"
};

function uriForFile(filename) {
  return `${CFG.workspace.rootUri}/${normalizePath(filename)}`;
}

function isClangdFile(filename) {
  const m = modeForFile(filename);
  return m === "text/x-c++src" || m === "text/x-csrc";
}

function isJavaFile(filename) {
  return modeForFile(filename) === "text/x-java";
}

function isCodeFile(filename) {
  const m = modeForFile(filename);
  return m === "text/x-java" || m === "text/x-csrc" || m === "text/x-c++src";
}

function shouldMirrorFile(filename) {
  const f = normalizePath(filename).toLowerCase();
  return (
    f.endsWith(".java") ||
    f.endsWith(".c") ||
    f.endsWith(".cpp") ||
    f.endsWith(".cc") ||
    f.endsWith(".cxx") ||
    f.endsWith(".h") ||
    f.endsWith(".hpp") ||
    f.endsWith("compile_commands.json") ||
    f.endsWith("cmakelists.txt") ||
    f.endsWith(".project") ||
    f.endsWith(".classpath") ||
    f.includes(".settings/")
  );
}

function currentMode() {
  return modeForFile(activeFile || "");
}

function isClangd() {
  return isClangdFile(activeFile || "");
}

function isJava() {
  return isJavaFile(activeFile || "");
}

function createFileState(filename, extra = {}) {
  const mode = modeForFile(filename);
  return {
    filename: normalizePath(filename),
    uri: uriForFile(filename),
    languageId: languageIds[mode] || "plaintext",
    version: 1,
    content: null,
    handle: null,
    dirty: false,
    ...extra
  };
}

function ensureFileState(filename, extra = {}) {
  const key = normalizePath(filename);
  if (!fileStates.has(key)) {
    fileStates.set(key, createFileState(key, extra));
  } else {
    Object.assign(fileStates.get(key), extra || {});
  }
  return fileStates.get(key);
}

//Docstate iz aktivne datoteke
function docState() {
  const st = fileStates.get(activeFile);
  if (!st) return { uri: "", languageId: "plaintext", version: 1 };
  return st;
}

//Local file

async function readHandleText(handle) {
  const file = await handle.getFile();
  return await file.text();
}

async function ensureLocalHandleForState(filename, st) {
  if (st.handle) return st.handle;

  if (activeFolderHandle) {
    const parts = normalizePath(filename).split("/").filter(Boolean);
    if (!parts.length) return null;

    let dir = activeFolderHandle;
    for (const segment of parts.slice(0, -1)) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }

    st.handle = await dir.getFileHandle(parts[parts.length - 1], { create: true });
    return st.handle;
  }

  if (window.showSaveFilePicker) {
    st.handle = await window.showSaveFilePicker({
      suggestedName: baseName(filename) || filename,
      excludeAcceptAllOption: false
    });
    return st.handle;
  }

  return null;
}

async function loadContentForState(filename, st) {
  const norm = normalizePath(filename);

  if (st.handle) {
    try {
      const text = await readHandleText(st.handle);
      st.content = text;
      persistFileToBrowser(norm, text);
      return text;
    } catch (e) {
      console.warn("Local file read failed:", norm, e.message);
    }
  }

  if (hasServerSupport()) {
    try {
      const res = await fetch(`${CFG.server.httpUrl}/workspace/${escapePathSegment(norm)}`, {
        cache: "no-store"
      });

      if (res.ok) {
        const text = await res.text();
        st.content = text;
        persistFileToBrowser(norm, text);
        return text;
      }
    } catch (e) {
      console.warn("Workspace file read failed:", norm, e.message);
    }
  }

  const cached = readFileFromBrowser(norm);
  if (cached !== null) {
    st.content = cached;
    return cached;
  }

  st.content = defaultSnippet(norm);
  return st.content;
}

async function writeStateToLocal(filename, st, { promptIfNeeded = true } = {}) {
  if (!st) return false;

  const content = filename === activeFile && editor ? editor.getValue() : (st.content ?? "");
  st.content = content;

  let handle = st.handle || null;

  if (!handle && promptIfNeeded) {
    try {
      handle = await ensureLocalHandleForState(filename, st);
    } catch (e) {
      console.warn("Local save picker cancelled or failed:", e.message);
      return false;
    }
  }

  if (!handle) return false;

  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();

  st.handle = handle;
  return true;
}

// Server mirror datotek

async function syncFileToServer(filename, content) {
  if (!hasServerSupport()) return false;
  if (!shouldMirrorFile(filename)) return false;

  const rel = normalizePath(filename);
  if (!rel) return false;

  try {
    const res = await fetch(`${CFG.server.httpUrl}/workspace/${escapePathSegment(rel)}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: content ?? ""
    });
    return res.ok;
  } catch (e) {
    console.warn("syncFileToServer failed:", rel, e.message);
    return false;
  }
}

async function mirrorStateToServer(filename) {
  const st = fileStates.get(filename);
  if (!st) return false;
  const content = filename === activeFile && editor ? editor.getValue() : (st.content ?? "");
  return await syncFileToServer(filename, content);
}

async function notifyServerFileChange(filename, type = 2) {
  if (!hasServerSupport()) return;

  const st = fileStates.get(filename);
  if (!st) return;

  if (isJavaFile(filename) && javaInitialized && typeof sendJavaNotification === "function") {
    sendJavaNotification("workspace/didChangeWatchedFiles", {
      changes: [{ uri: st.uri, type }]
    });
  }
}

//LSP routing

function lspRequest(method, params) {
  if (!hasServerSupport()) return Promise.reject(new Error("No server"));
  if (isJava() && typeof sendJavaRequest === "function") return sendJavaRequest(method, params);
  if (isClangd() && typeof sendLspRequest === "function") return sendLspRequest(method, params);
  return Promise.reject(new Error("No LSP for this language"));
}

function lspNotification(method, params) {
  if (!hasServerSupport()) return;
  if (isJava() && typeof sendJavaNotification === "function") {
    sendJavaNotification(method, params);
    return;
  }
  if (isClangd() && typeof sendLspNotification === "function") {
    sendLspNotification(method, params);
  }
}

function lspReady() {
  if (!hasServerSupport()) return false;

  if (isJava()) {
    return javaInitialized && typeof isJavaLspReady === "function" && isJavaLspReady();
  }

  if (isClangd()) {
    return clangdInitialized && typeof isLspReady === "function" && isLspReady();
  }

  return false;
}

//Signature hint

let sigEl = null;

function showSignatureHint(html) {
  if (!html) {
    hideSignatureHint();
    return;
  }

  if (!sigEl) {
    sigEl = document.createElement("div");
    sigEl.className = "cm-signature-hint";
    document.body.appendChild(sigEl);
  }

  sigEl.innerHTML = html;
  sigEl.style.display = "block";

  requestAnimationFrame(() => {
    if (!sigEl || !editor) return;
    const cur = editor.getCursor();
    const coords = editor.charCoords({ line: cur.line, ch: cur.ch }, "window");
    sigEl.style.left = Math.max(4, coords.left) + "px";
    sigEl.style.top = (coords.top - sigEl.offsetHeight - 8) + "px";
  });
}

function hideSignatureHint() {
  if (sigEl) sigEl.style.display = "none";
}

function callDepth() {
  if (!editor) return 0;

  const cur = editor.getCursor();
  const before = (editor.getLine(cur.line) || "").slice(0, cur.ch);
  let depth = 0;
  let inStr = false;
  let strCh = "";

  for (const ch of before) {
    if (inStr) {
      if (ch === strCh) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      strCh = ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")" && depth > 0) depth--;
  }

  return depth;
}

function scheduleSignatureRefresh(triggerChar, isRetrigger, delay) {
  clearTimeout(signatureTimer);
  signatureTimer = setTimeout(() => {
    if (callDepth() > 0) requestSignatureHelp(triggerChar, isRetrigger);
    else hideSignatureHint();
  }, delay ?? CFG.editor.completionDelay);
}

//Completion pomoč

function stripSnippets(text) {
  if (!text) return "";
  return text
    .replace(/\$\{[0-9]+:[^}]*\}/g, "")
    .replace(/\$\{[0-9]+\}/g, "")
    .replace(/\$[0-9]+/g, "")
    .replace(/\$\{[^}]+\}/g, "")
    .trimEnd();
}

function getInsertText(item) {
  if (item.textEdit?.newText) return stripSnippets(item.textEdit.newText);
  if (item.insertText) return stripSnippets(item.insertText);
  return item.label || "";
}

function isCallable(item) {
  return [2, 3, 6].includes(item.kind) ||
    (item.label || "").includes("(") ||
    (item.detail || "").includes("(") ||
    (item.insertText || "").includes("(");
}

function getFunctionName(item) {
  const clean = stripSnippets(item.insertText || item.textEdit?.newText || item.label || "");
  const m = clean.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
  return m ? m[1] : clean.split("(")[0].trim();
}

// Vrne ikono in barvo glede na LSP completion item kind
function getKindInfo(kind) {
  switch (kind) {
    case 1:  return { icon: "⊡", color: "#888" };          // Text
    case 2:  return { icon: "m", color: "#c792ea" };        // Method
    case 3:  return { icon: "ƒ", color: "#82aaff" };        // Function
    case 4:  return { icon: "C", color: "#f78c6c" };        // Constructor
    case 5:  return { icon: "◈", color: "#ffcb6b" };        // Field
    case 6:  return { icon: "m", color: "#c792ea" };        // Variable (method-like)
    case 7:  return { icon: "C", color: "#f78c6c" };        // Class
    case 8:  return { icon: "I", color: "#89ddff" };        // Interface
    case 9:  return { icon: "M", color: "#c3e88d" };        // Module
    case 10: return { icon: "◈", color: "#ffcb6b" };        // Property
    case 11: return { icon: "e", color: "#f78c6c" };        // Unit
    case 12: return { icon: "=", color: "#c3e88d" };        // Value
    case 13: return { icon: "∈", color: "#f78c6c" };        // Enum
    case 14: return { icon: "k", color: "#ff5370" };        // Keyword
    case 15: return { icon: "S", color: "#89ddff" };        // Snippet
    case 16: return { icon: "#", color: "#ffcb6b" };        // Color
    case 17: return { icon: "F", color: "#888" };           // File
    default: return { icon: "·", color: "#888" };
  }
}

function getTypedPrefixInfo() {
  const cur = editor.getCursor();
  const line = editor.getLine(cur.line) || "";
  let start = cur.ch;

  while (start > 0 && /[A-Za-z0-9_$]/.test(line[start - 1])) start--;

  return {
    from: CodeMirror.Pos(cur.line, start),
    to: CodeMirror.Pos(cur.line, cur.ch),
    prefix: line.slice(start, cur.ch)
  };
}

function escapeHtmlBasic(s) {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function installEditorBoldStyles() {
  if (document.getElementById("smartcode-editor-bold-style")) return;

  const style = document.createElement("style");
  style.id = "smartcode-editor-bold-style";
  style.textContent = `
    .CodeMirror.smartcode-mode-c .cm-keyword,
    .CodeMirror.smartcode-mode-c .cm-builtin,
    .CodeMirror.smartcode-mode-c .cm-atom,
    .CodeMirror.smartcode-mode-c .cm-meta,
    .CodeMirror.smartcode-mode-cpp .cm-keyword,
    .CodeMirror.smartcode-mode-cpp .cm-builtin,
    .CodeMirror.smartcode-mode-cpp .cm-atom,
    .CodeMirror.smartcode-mode-cpp .cm-meta {
      font-weight: 700;
    }

    .CodeMirror-hints .lsp-hint-prefix {
      font-weight: 700 !important;
    }
  `;
  document.head.appendChild(style);
}

function updateEditorLanguageClass(mode) {
  const wrap = editor?.getWrapperElement?.();
  if (!wrap) return;

  wrap.classList.remove(
    "smartcode-mode-java",
    "smartcode-mode-c",
    "smartcode-mode-cpp",
    "smartcode-mode-plain"
  );

  if (mode === "text/x-java") wrap.classList.add("smartcode-mode-java");
  else if (mode === "text/x-csrc") wrap.classList.add("smartcode-mode-c");
  else if (mode === "text/x-c++src") wrap.classList.add("smartcode-mode-cpp");
  else wrap.classList.add("smartcode-mode-plain");
}

function appendLabelWithBoldPrefix(labelSpan, label, prefix) {
  const text = String(label || "");
  const p = String(prefix || "");

  if (!p) {
    labelSpan.textContent = text;
    return;
  }

  const idx = text.toLowerCase().indexOf(p.toLowerCase());
  if (idx < 0) {
    labelSpan.textContent = text;
    return;
  }

  labelSpan.appendChild(document.createTextNode(text.slice(0, idx)));

  const boldPart = document.createElement("strong");
  boldPart.className = "lsp-hint-prefix";
  boldPart.textContent = text.slice(idx, idx + p.length);
  labelSpan.appendChild(boldPart);

  labelSpan.appendChild(document.createTextNode(text.slice(idx + p.length)));
}

//Startup

document.addEventListener("DOMContentLoaded", async () => {
  initEditor();
  initUI();

  loadBrowserWorkspace();
  await refreshFileList();

  if (hasServerSupport()) {
    initClangdLsp();
    initJavaLsp();
  } else {
    setServerInfo("LSP: off");
  }
});

// Editor setup

function initEditor() {
  const ta = document.getElementById("editor");
  if (!ta) {
    console.error("Missing #editor");
    return;
  }

  editor = CodeMirror.fromTextArea(ta, {
    mode: "text/plain",
    theme: "eclipse",
    lineNumbers: true,
    matchBrackets: true,
    autoCloseBrackets: true,
    indentUnit: 2,
    tabSize: 2,
    lineWrapping: false,
    gutters: ["CodeMirror-linenumbers", "lsp-diagnostics-gutter"],
    extraKeys: {
      "Ctrl-Space": () => { if (lspReady()) requestCompletion(null); },
      "Ctrl-S":     () => saveActiveFile(false),
      "Esc":        () => { hideSignatureHint(); editor.closeHint?.(); },

      "Left": (cm) => {
        cm.execCommand("goCharLeft");
        if (cm.state.completionActive) {
          clearTimeout(completionTimer);
          completionTimer = setTimeout(() => {
            const { prefix } = getTypedPrefixInfo();
            if (prefix.length >= 1) requestCompletion(null);
            else cm.closeHint?.();
          }, 60);
        }
      },

      "Right": (cm) => {
        cm.execCommand("goCharRight");
        if (cm.state.completionActive) {
          clearTimeout(completionTimer);
          completionTimer = setTimeout(() => {
            const { prefix } = getTypedPrefixInfo();
            if (prefix.length >= 1) requestCompletion(null);
            else cm.closeHint?.();
          }, 60);
        }
      }
    }
  });

  editor.setSize("100%", "100%");
  installEditorBoldStyles();
  updateEditorLanguageClass("text/plain");
  editor.refresh();
  editor.on("cursorActivity", () => {
  updateCursorInfo();

  clearTimeout(signatureTimer);

  signatureTimer = setTimeout(() => {
    if (!lspReady()) {
      hideSignatureHint();
      return;
    }

    if (callDepth() > 0) {
      requestSignatureHelp(null, true);
    } else {
      hideSignatureHint();
    }
  }, 120);
});

  editor.on("change", (_cm, change) => {
  if (isFileSwitch) return;

  const changedFile = activeFile;
  const st = fileStates.get(changedFile);
  if (!st) return;

    st.version++;
    st.dirty = true;
    st.content = editor.getValue();

    persistFileToBrowser(changedFile, st.content);

    setAutosaveInfo("Autosave: pending…", "autosave-pending");
    renderTabs();

    if (lspReady()) {
      lspNotification("textDocument/didChange", {
        textDocument: { uri: st.uri, version: st.version },
        contentChanges: [{ text: st.content }]
      });
    }

    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => saveFile(changedFile, true), CFG.editor.autosaveDelay);
    
    if (isJava() && change.origin === "+input") {
      const inserted = Array.isArray(change.text) ? change.text.join("") : "";
      const ch = inserted ? inserted[inserted.length - 1] : "";
      if (/^[A-Za-z0-9_$]$/.test(ch)) {
        clearTimeout(completionTimer);
        completionTimer = setTimeout(() => requestCompletion(null), 120);
      }
    }

    if (change.origin === "+delete") {
      clearTimeout(completionTimer);
      const { prefix } = getTypedPrefixInfo();

      if (editor.state.completionActive || prefix.length >= 1) {
        completionTimer = setTimeout(() => requestCompletion(null), 120);
      }

      if (callDepth() > 0) scheduleSignatureRefresh(null, true, 120);
      else hideSignatureHint();
    }
  });

  editor.on("inputRead", (_cm, change) => {
    if (suppressInputRead || !lspReady()) return;
    if (change.origin === "complete" || change.origin === "setValue") return;

    const text = (change.text || []).join("\n");
    if (!text || text.includes("\n")) return;

    const ch = text.slice(-1);
    const cur = editor.getCursor();
    const line = editor.getLine(cur.line) || "";

    if (ch === ".") {
      clearTimeout(completionTimer);
      if (editor.state.completionActive) editor.closeHint?.();
      completionTimer = setTimeout(() => requestCompletion("."), CFG.editor.completionDelay);
      return;
    }

    if (ch === ">" && cur.ch >= 2 && line[cur.ch - 2] === "-") {
      clearTimeout(completionTimer);
      if (editor.state.completionActive) editor.closeHint?.();
      completionTimer = setTimeout(() => requestCompletion(">"), CFG.editor.completionDelay);
      return;
    }

    if (ch === ":" && cur.ch >= 2 && line[cur.ch - 2] === ":") {
      clearTimeout(completionTimer);
      if (editor.state.completionActive) editor.closeHint?.();
      completionTimer = setTimeout(() => requestCompletion(":"), CFG.editor.completionDelay);
      return;
    }

    if (ch === "(") {
      if (editor.state.completionActive) editor.closeHint?.();
      scheduleSignatureRefresh("(", false, 80);
      return;
    }

    if (ch === ",") {
      scheduleSignatureRefresh(",", true, CFG.editor.completionDelay);
      return;
    }

    if (ch === ")") {
      clearTimeout(signatureTimer);
      signatureTimer = setTimeout(() => {
        if (callDepth() <= 0) hideSignatureHint();
        else scheduleSignatureRefresh(null, true, 0);
      }, 50);
      return;
    }

    //Identifier — za C/C++
    if (!isJava() && /^[a-zA-Z0-9_$]$/.test(ch)) {
      clearTimeout(completionTimer);
      completionTimer = setTimeout(() => requestCompletion(null), CFG.editor.identifierDelay);
    }
  });

  updateCursorInfo();
}

//File management

async function refreshFileList() {
  let files = [];

  if (hasServerSupport()) {
    try {
      const res = await fetch(`${CFG.server.httpUrl}/scan`);
      if (res.ok) {
        const data = await res.json();
        files = (data.files || []).filter(f => isCodeFile(f));
      }
    } catch (e) {
      console.warn("refreshFileList: /scan failed:", e.message);
    }
  }

  if (!files.length) {
    files = [...fileStates.keys()].filter(isCodeFile);
  }

  for (const def of ["main.cpp", "main.c", "main.java"]) {
  if (!files.includes(def)) files.push(def);
}

  for (const f of files) {
  const norm = normalizePath(f);

  if (!fileStates.has(norm)) {
    fileStates.set(norm, createFileState(norm, {
      content: null
    }));
  } else if (hasServerSupport()) {
    const st = fileStates.get(norm);

    if (st && !st.dirty && !st.handle) {
      st.content = null;
    }
  }
}

  const lastFile = localStorage.getItem("smartcode-file");
  const target = (lastFile && fileStates.has(lastFile)) ? lastFile : files[0];

  renderTabs();
  await openFile(target);
}

async function openFile(filename) {
  const norm = normalizePath(filename);

  if (!fileStates.has(norm)) {
  fileStates.set(norm, createFileState(norm, {
    content: null
  }));
  renderTabs();
}

const st = fileStates.get(norm);

if (st.content === null) {
  await loadContentForState(norm, st);
}

  if (activeFile && activeFile !== norm) {
    const cur = fileStates.get(activeFile);
    if (cur) cur.content = editor.getValue();
  }

  if (activeFile && activeFile !== norm) {
    const old = fileStates.get(activeFile);
    if (old && isClangdFile(activeFile) && openedDocs.has(old.uri)) {
      sendDidCloseForFile(activeFile);
    }
  }

  activeFile = norm;
  localStorage.setItem("smartcode-file", norm);

  const mode = modeForFile(norm);
  const theme = themes[mode] || "eclipse";

  isFileSwitch = true;
  editor.setOption("mode", mode);
  editor.setOption("theme", theme);
  editor.setValue(st.content || "");
  editor.clearHistory();
  isFileSwitch = false;

  editor.refresh();
  editor.focus();

  clearDiagnostics();
  hideSignatureHint();
  setAutosaveInfo(st.dirty ? "Autosave: pending…" : "Autosave: —", st.dirty ? "autosave-pending" : "autosave-idle");
  updateCursorInfo();
  updateServerInfo();
  renderTabs();

  if (lspReady()) sendDidOpenForFile(norm);

  const existingDiagnostics = diagnosticsByFile.get(st.uri) || [];
  renderDiagnostics(existingDiagnostics, st.uri);
}

function defaultSnippet(filename) {
  const mode = modeForFile(filename);
  const rawBase = baseName(filename).replace(/\.[^.]+$/, "");
  const cls = (rawBase.charAt(0).toUpperCase() + rawBase.slice(1)).replace(/[^A-Za-z0-9_$]/g, "") || "Main";

  if (mode === "text/x-java") {
    return `public class ${cls} {\n\n    public static void main(String[] args) {\n        \n    }\n}\n`;
  }

  if (mode === "text/x-csrc") {
    return `#include <stdio.h>\n\nint main(void) {\n    \n    return 0;\n}\n`;
  }

  if (mode === "text/x-c++src") {
    return `#include <iostream>\n\nint main() {\n    \n    return 0;\n}\n`;
  }

  return "";
}

//Tabs rendering
function renderTabs() {
  const bar = document.getElementById("tabBar");
  if (!bar) return;

  bar.innerHTML = "";
  for (const [filename, st] of fileStates) {
    if (!isCodeFile(filename)) continue;

    const tab = document.createElement("div");
    tab.className = "tab" + (filename === activeFile ? " tab-active" : "");

    const icon = document.createElement("span");
    icon.className = "tab-icon";
    icon.textContent = fileIcon(filename);

    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = filename + (st?.dirty ? " •" : "");

    const close = document.createElement("button");
    close.className = "tab-close";
    close.textContent = "×";
    close.title = "Zapri tab (desni klik = izbriši datoteko)";
    close.addEventListener("click", e => {
      e.stopPropagation();
      closeTab(filename);
    });
    close.addEventListener("contextmenu", e => {
      e.preventDefault();
      e.stopPropagation();
      showTabContextMenu(filename, e.clientX, e.clientY);
    });

    tab.appendChild(icon);
    tab.appendChild(label);
    tab.appendChild(close);
    tab.addEventListener("click", () => openFile(filename));
    bar.appendChild(tab);
  }
}

function fileIcon(filename) {
  const m = modeForFile(filename);
  if (m === "text/x-java") return "☕";
  if (m === "text/x-csrc") return "🔵";
  if (m === "text/x-c++src") return "🟣";
  return "📄";
}

async function closeTab(filename) {
  const codeTabs = [...fileStates.keys()].filter(isCodeFile);
  if (codeTabs.length <= 1) return;

  const st = fileStates.get(filename);
  if (st?.dirty) {
    const ok = confirm(`Datoteka ${filename} ni shranjena. Zaprem tab?`);
    if (!ok) return;
  }

  sendDidCloseForFile(filename);

  if (activeFile === filename) {
    fileStates.delete(filename);
    const remaining = [...fileStates.keys()].filter(isCodeFile);
    activeFile = null;
    if (remaining.length) await openFile(remaining[0]);
  } else {
    fileStates.delete(filename);
    renderTabs();
  }

  persistFileListToBrowser();
}

function showTabContextMenu(filename, x, y) {
  document.getElementById("sc-ctx-menu")?.remove();

  const menu = document.createElement("div");
  menu.id = "sc-ctx-menu";
  menu.className = "sc-context-menu";
  menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:9999;`;

  const items = [
    { label: "📋 Preimenuj",   action: () => renameFile(filename) },
    { label: "🗑 Izbriši datoteko", action: () => deleteFile(filename), danger: true },
  ];

  for (const item of items) {
    const btn = document.createElement("button");
    btn.className = "sc-ctx-item" + (item.danger ? " sc-ctx-danger" : "");
    btn.textContent = item.label;
    btn.addEventListener("click", () => { menu.remove(); item.action(); });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);

  const dismiss = (e) => {
    if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener("mousedown", dismiss); }
  };
  setTimeout(() => document.addEventListener("mousedown", dismiss), 0);
}

async function deleteFile(filename) {
  const confirmed = confirm(`Izbriši datoteko "${filename}"?\n\nDatoteka bo trajno izbrisana iz brskalnika.`);
  if (!confirmed) return;

  sendDidCloseForFile(filename);
  fileStates.delete(filename);

  if (typeof Storage !== "undefined" && Storage.deleteFile) {
    await Storage.deleteFile(filename).catch(() => {});
  }

  localStorage.removeItem(`sc:file:${filename}`);
  const files = JSON.parse(localStorage.getItem("sc:files") || "[]").filter(f => f !== filename);
  localStorage.setItem("sc:files", JSON.stringify(files));

  if (activeFile === filename) {
    const remaining = [...fileStates.keys()].filter(isCodeFile);
    activeFile = null;
    if (remaining.length) await openFile(remaining[0]);
  } else {
    renderTabs();
  }

  persistFileListToBrowser();
}

async function renameFile(filename) {
  const newName = prompt("Novo ime datoteke:", filename);
  if (!newName?.trim() || newName === filename) return;

  const st = fileStates.get(filename);
  if (!st) return;

  const content = filename === activeFile ? editor.getValue() : (st.content || "");

  const newSt = {
    uri:        uriForFile(newName),
    languageId: languageIds[modeForFile(newName)] || "plaintext",
    version:    1,
    content,
    dirty:      false
  };

  sendDidCloseForFile(filename);
  fileStates.delete(filename);

  if (typeof Storage !== "undefined" && Storage.saveFile) {
    await Storage.saveFile(newName, content).catch(() => {});
    await Storage.deleteFile(filename).catch(() => {});
  }
  localStorage.setItem(`sc:file:${newName}`, content);
  localStorage.removeItem(`sc:file:${filename}`);

  fileStates.set(newName, newSt);

  if (activeFile === filename) {
    activeFile = newName;
    localStorage.setItem("sc:active", newName);
  }

  renderTabs();
  persistFileListToBrowser();
  if (lspReady()) sendDidOpenForFile(newName);
}

//UI buttons
function initUI() {
  document.getElementById("newFileBtn")?.addEventListener("click", createNewFile);
  document.getElementById("saveBtn")?.addEventListener("click", () => saveActiveFile(false));

  //Open button: če browser podpira File System Access, uporabi to
  document.getElementById("openBtn")?.addEventListener("click", async () => {
    if (window.showOpenFilePicker) {
      await openFilesWithPicker();
    } else {
      document.getElementById("fileInput")?.click();
    }
  });

  document.getElementById("openFolderBtn")?.addEventListener("click", openFolderWorkspace);
  document.getElementById("fileInput")?.addEventListener("change", onLocalFilesSelected);
}

async function createNewFile() {
  const name = prompt("Ime datoteke (npr. Helper.java, utils.cpp, math.c):");
  if (!name || !name.trim()) return;

  const filename = normalizePath(name.trim());
  const content = defaultSnippet(filename);

  const st = ensureFileState(filename, {
    content,
    dirty: true
  });

  persistFileToBrowser(filename, content);
  renderTabs();
  await openFile(filename);

  if (hasServerSupport()) {
    await syncFileToServer(filename, content);

    if (isJavaFile(filename) && javaInitialized && typeof sendJavaNotification === "function") {
      sendJavaNotification("textDocument/didOpen", {
        textDocument: {
          uri: st.uri,
          languageId: "java",
          version: st.version,
          text: content
        }
      });
      openedDocs.add(st.uri);
    }
  }
}

async function onLocalFilesSelected(e) {
  const files = Array.from(e.target.files || []);

  for (const file of files) {
    const text = await file.text();
    const filename = normalizePath(file.webkitRelativePath || file.name);

    ensureFileState(filename, {
      content: text,
      handle: null,
      dirty: false
    });

    persistFileToBrowser(filename, text);
    await syncFileToServer(filename, text);
  }

  renderTabs();
  if (files.length > 0) {
    const last = files[files.length - 1];
    await openFile(normalizePath(last.webkitRelativePath || last.name));
  }

  if (hasServerSupport() && javaInitialized) {
    await openAllJavaFilesInLsp();
  }

  e.target.value = "";
}

async function openFilesWithPicker() {
  if (!window.showOpenFilePicker) {
    document.getElementById("fileInput")?.click();
    return;
  }

  const handles = await window.showOpenFilePicker({ multiple: true });

  for (const handle of handles) {
    const filename = normalizePath(handle.name);
    const text = await readHandleText(handle);

    ensureFileState(filename, {
      content: text,
      handle,
      dirty: false
    });

    persistFileToBrowser(filename, text);
    await syncFileToServer(filename, text);
  }

  renderTabs();
  if (handles.length) await openFile(normalizePath(handles[handles.length - 1].name));

  if (hasServerSupport() && javaInitialized) {
    await openAllJavaFilesInLsp();
  }
}

async function walkDirectory(dirHandle, prefix = "") {
  const files = [];

  for await (const [name, entry] of dirHandle.entries()) {
    const rel = prefix ? `${prefix}/${name}` : name;

    if (entry.kind === "directory") {
      files.push(...await walkDirectory(entry, rel));
    } else {
      files.push({ path: normalizePath(rel), handle: entry });
    }
  }

  return files;
}

async function openFolderWorkspace() {
  if (!window.showDirectoryPicker) {
    alert("Open Folder deluje v Chromium brskalnikih (Chrome / Edge).");
    return;
  }

  const dirHandle = await window.showDirectoryPicker();
  activeFolderHandle = dirHandle;

  const entries = await walkDirectory(dirHandle);
  const files = entries.filter(e => isCodeFile(e.path) || shouldMirrorFile(e.path));

  for (const entry of files) {
    const text = await readHandleText(entry.handle);

    ensureFileState(entry.path, {
      content: text,
      handle: entry.handle,
      dirty: false
    });

    persistFileToBrowser(entry.path, text);
    await syncFileToServer(entry.path, text);
  }

  renderTabs();

  const firstCode = files.map(e => e.path).find(isCodeFile);
  if (firstCode) await openFile(firstCode);

  if (hasServerSupport() && javaInitialized) {
    await openAllJavaFilesInLsp();
  }
}

//LSP — clangd

function initClangdLsp() {
  if (typeof connectLsp !== "function") return;

  connectLsp(CFG.server.wsClangd);

  onLspOpen(async () => {
    if (clangdInitialized) return;
    clangdInitialized = true;
    if (isClangd()) setServerInfo("LSP: clangd ✓");

    try {
      await sendLspRequest("initialize", {
        processId: null,
        rootUri: CFG.workspace.rootUri,
        capabilities: lspCapabilities()
      });

      sendLspNotification("initialized", {});

      if (isClangd() && activeFile) {
        sendDidOpenForFile(activeFile);
      }
    } catch (e) {
      console.error("clangd init failed:", e);
    }
  });

  onLspClose(() => {
    clangdInitialized = false;
    if (isClangd()) setServerInfo("LSP: disconnected");
  });

  onLspError(() => {
    if (isClangd()) setServerInfo("LSP: error");
  });

  onLspDiagnostics(params => {
    if (params) renderDiagnostics(params.diagnostics || [], params.uri);
  });
}

//LSP — jdtls

function initJavaLsp() {
  if (typeof connectJavaLsp !== "function") return;

  connectJavaLsp(CFG.server.wsJava);

  onJavaLspOpen(async () => {
  if (javaInitialized) return;
  if (isJava()) setServerInfo("LSP: jdtls connecting…");

  await new Promise(r => setTimeout(r, CFG.editor.javaInitDelay));

    try {
      await sendJavaRequest("initialize", {
        processId: null,
        rootUri: CFG.workspace.rootUri,
        workspaceFolders: [{ uri: CFG.workspace.rootUri, name: "workspace" }],
        capabilities: lspCapabilities()
      });

      sendJavaNotification("initialized", {});
      javaInitialized = true;

      sendJavaNotification("workspace/didChangeConfiguration", {
        settings: {
          java: {
            completion: { enabled: true, guessMethodArguments: true },
            signatureHelp: { enabled: true }
          }
        }
      });

      if (isJava()) setServerInfo("LSP: jdtls ✓");

      await openAllJavaFilesInLsp();

      if (activeFile && isJavaFile(activeFile)) {
        sendDidOpenForFile(activeFile);
      }
    } catch (e) {
      console.error("jdtls init failed:", e);
      javaInitialized = false;
      if (isJava()) setServerInfo("LSP: jdtls retrying…");
      setTimeout(() => {
        if (typeof connectJavaLsp === "function") connectJavaLsp(CFG.server.wsJava);
      }, CFG.editor.javaRetryDelay);
    }
  });

  onJavaLspClose(() => {
    javaInitialized = false;
    openedDocs.clear();
    if (isJava()) setServerInfo("LSP: jdtls disconnected");

    setTimeout(() => {
      if (!javaInitialized && typeof connectJavaLsp === "function") {
        connectJavaLsp(CFG.server.wsJava);
      }
    }, CFG.editor.javaRetryDelay);
  });

  onJavaLspError(() => {
    if (isJava()) setServerInfo("LSP: jdtls error");
  });

  onJavaLspDiagnostics(params => {
    if (params) renderDiagnostics(params.diagnostics || [], params.uri);
  });
}

//Odpri VSE .java datoteke v workspace
async function openAllJavaFilesInLsp() {
  if (!hasServerSupport() || !javaInitialized) return;

  const javaFiles = [...fileStates.keys()].filter(f => f.endsWith(".java"));

  for (const filename of javaFiles) {
    const st = fileStates.get(filename);
    if (!st) continue;
    if (openedDocs.has(st.uri)) continue;

    const text = st.content == null
  ? await loadContentForState(filename, st)
  : st.content;

await syncFileToServer(filename, text);

    openedDocs.add(st.uri);
    sendJavaNotification("textDocument/didOpen", {
      textDocument: { uri: st.uri, languageId: "java", version: st.version, text }
    });
  }
}

function lspCapabilities() {
  return {
    textDocument: {
      completion: {
        completionItem: {
          insertTextFormat: { valueSet: [1, 2] },
          documentationFormat: ["plaintext", "markdown"],
          snippetSupport: true,
          resolveSupport: { properties: ["documentation", "detail"] }
        },
        contextSupport: true
      },
      signatureHelp: {
        signatureInformation: {
          documentationFormat: ["plaintext", "markdown"],
          parameterInformation: { labelOffsetSupport: true }
        },
        contextSupport: true
      },
      hover: { contentFormat: ["plaintext", "markdown"] },
      publishDiagnostics: { relatedInformation: true }
    },
    workspace: {
      workspaceFolders: true,
      didChangeWatchedFiles: { dynamicRegistration: true }
    }
  };
}

function sendDidOpenForFile(filename) {
  const st = fileStates.get(filename);
  if (!st || !lspReady()) return;

  const text = filename === activeFile ? editor.getValue() : (st.content || "");
  if (openedDocs.has(st.uri)) {
    lspNotification("textDocument/didClose", { textDocument: { uri: st.uri } });
    openedDocs.delete(st.uri);
  }

  openedDocs.add(st.uri);
  lspNotification("textDocument/didOpen", {
    textDocument: {
      uri:        st.uri,
      languageId: st.languageId,
      version:    st.version,
      text
    }
  });
}

function sendDidCloseForFile(filename) {
  const st = fileStates.get(filename);
  if (!st) return;

  if (!openedDocs.has(st.uri)) return;
  openedDocs.delete(st.uri);

  if (!lspReady()) return;
  lspNotification("textDocument/didClose", { textDocument: { uri: st.uri } });
}

function updateServerInfo() {
  if (!hasServerSupport()) {
    setServerInfo("LSP: off");
    return;
  }

  if (isClangd()) setServerInfo(clangdInitialized ? "LSP: clangd ✓" : "LSP: connecting…");
  else if (isJava()) setServerInfo(javaInitialized ? "LSP: jdtls ✓" : "LSP: connecting…");
  else setServerInfo("LSP: —");
}

//Signature Help

function requestSignatureHelp(triggerChar, isRetrigger) {
  if (!lspReady()) return;

  const st = docState();
  const cur = editor.getCursor();

  lspRequest("textDocument/signatureHelp", {
    textDocument: { uri: st.uri },
    position: { line: cur.line, character: cur.ch },
    context: {
      triggerKind: triggerChar ? 2 : 1,
      isRetrigger: isRetrigger ?? false,
      triggerCharacter: triggerChar || undefined
    }
  })
    .then(result => {
      if (!result?.signatures?.length) {
        hideSignatureHint();
        return;
      }

      const sig = result.signatures[result.activeSignature ?? 0];
      if (!sig) {
        hideSignatureHint();
        return;
      }

      const paramIdx = result.activeParameter ?? sig.activeParameter ?? 0;
      const params = sig.parameters || [];
      let label = escapeHtmlBasic(sig.label);

      if (params[paramIdx]) {
        const p = params[paramIdx];
        let pLabel, pStart, pEnd;

        if (Array.isArray(p.label)) {
          [pStart, pEnd] = p.label;
          pLabel = sig.label.slice(pStart, pEnd);
        } else {
          pLabel = p.label;
          pStart = sig.label.indexOf(pLabel);
          pEnd = pStart + pLabel.length;
        }

        if (pStart >= 0) {
          label =
            escapeHtmlBasic(sig.label.slice(0, pStart)) +
            "<strong>" + escapeHtmlBasic(pLabel) + "</strong>" +
            escapeHtmlBasic(sig.label.slice(pEnd));
        }
      }

      showSignatureHint(label);
    })
    .catch(() => {});
}

// Completion

function requestCompletion(triggerChar = null) {
  if (!lspReady()) return;

  const st = docState();
  const reqSeq = ++completionReqSeq;
  const reqVer = st.version;
  const reqMode = currentMode();
  const reqCur = editor.getCursor();
  const isMember = triggerChar === "." || triggerChar === ">" || triggerChar === ":";
  const { from, to, prefix } = getTypedPrefixInfo();
  const typedPrefix = isMember ? "" : prefix;

  if (!isMember && typedPrefix.length < 1) {
    if (editor.state.completionActive) editor.closeHint?.();
    return;
  }

  lspRequest("textDocument/completion", {
    textDocument: { uri: st.uri },
    position: { line: reqCur.line, character: reqCur.ch },
    context: triggerChar
      ? { triggerKind: 2, triggerCharacter: triggerChar }
      : { triggerKind: 1 }
  })
    .then(result => {
      if (reqSeq !== completionReqSeq) return;
      if (reqVer !== docState().version && !isJava()) return;
      if (reqMode !== currentMode()) return;

      const cur = editor.getCursor();
      if (cur.line !== reqCur.line || cur.ch < from.ch) return;

      let items = Array.isArray(result) ? result : (result?.items ?? []);
      if (!items.length) {
        if (editor.state.completionActive) editor.closeHint?.();
        return;
      }

      // Filtriraj po prefixu
      if (typedPrefix && (!isJava() || isMember)) {
        const lower = typedPrefix.toLowerCase();
        items = items.filter(item =>
          (item.label || "").toLowerCase().startsWith(lower) ||
          (item.filterText || "").toLowerCase().startsWith(lower) ||
          stripSnippets(item.insertText || "").toLowerCase().startsWith(lower)
        );
      }

      // sortText filter
      if (isClangd()) {
        if (isMember) {
          const m = items.filter(i => (i.sortText || "9") < "4");
          if (m.length) items = m;
        } else {
          items = items.filter(i => (i.sortText || "9") < "7");
        }
      } else if (isJava() && isMember) {
        const m = items.filter(i => {
          const s = i.sortText || "";
          return !(s.startsWith("zzz") || s.startsWith("ZZZ"));
        });
        if (m.length) items = m;
      }

      if (!items.length) {
        if (editor.state.completionActive) editor.closeHint?.();
        return;
      }

      items.sort((a, b) => (a.sortText || a.label || "").localeCompare(b.sortText || b.label || ""));
      const max = isMember
        ? (isJava() ? CFG.editor.javaMemberMax : CFG.editor.memberMaxItems)
        : CFG.editor.identifierMax;

      items = items.slice(0, max);

      if (editor.state.completionActive) editor.closeHint?.();

      CodeMirror.showHint(editor, () => ({
        from,
        to,
        list: items.map(item => {
          const callable = isCallable(item);
          const displayLabel = callable
            ? (item.label.includes("(") ? item.label : item.label + "(…)")
            : item.label;
          return {
            text: callable ? getFunctionName(item) + "()" : getInsertText(item) || item.label,
            render(el) {
              el.className = "CodeMirror-hint lsp-hint-item";

              // Ikona/barva glede na tip (kind)
              const kindIcon = document.createElement("span");
              kindIcon.className = "lsp-hint-kind";
              const kindInfo = getKindInfo(item.kind);
              kindIcon.textContent = kindInfo.icon;
              kindIcon.style.color = kindInfo.color;
              el.appendChild(kindIcon);

              const labelSpan = document.createElement("span");
              labelSpan.className = "lsp-hint-label";

              appendLabelWithBoldPrefix(labelSpan, displayLabel, typedPrefix);
              el.appendChild(labelSpan);

              if (item.detail) {
                const detailSpan = document.createElement("span");
                detailSpan.className = "lsp-hint-detail";
                detailSpan.textContent = item.detail.split("\n")[0].trim().slice(0, 40);
                el.appendChild(detailSpan);
              }
            },
            hint(cm) {
              suppressInputRead = true;
              try {
                if (callable) {
                  cm.replaceRange(getFunctionName(item) + "()", from, to, "complete");
                  const p = cm.getCursor();
                  cm.setCursor({ line: p.line, ch: p.ch - 1 });
                  setTimeout(() => requestSignatureHelp("(", false), 60);
                } else {
                  cm.replaceRange(getInsertText(item) || item.label, from, to, "complete");
                }
              } finally {
                setTimeout(() => { suppressInputRead = false; }, 0);
              }
            }
          };
        })
      }), {
        completeSingle: false,
        alignWithWord: true,
        closeOnUnfocus: true
      });
    })
    .catch(e => console.error("Completion failed:", e));
}

//Save

async function saveFile(filename, silent = false) {
  const norm = normalizePath(filename);
  if (!norm) return;

  const st = fileStates.get(norm);
  if (!st) return;

  const content = norm === activeFile && editor
    ? editor.getValue()
    : (st.content ?? "");

  st.content = content;
  const cachedOk = persistFileToBrowser(norm, content);
  let wroteLocal = false;
  try {
    wroteLocal = await writeStateToLocal(norm, st, {
      promptIfNeeded: !silent
    });
  } catch (e) {
    console.warn("writeStateToLocal failed:", e.message);
  }

  let mirrored = false;
  try {
    mirrored = await mirrorStateToServer(norm);
  } catch (e) {
    console.warn("mirrorStateToServer failed:", e.message);
  }

  if (norm === activeFile && hasServerSupport() && lspReady()) {
    try {
      lspNotification("textDocument/didSave", {
        textDocument: { uri: st.uri }
      });
      await notifyServerFileChange(norm, 2);
    } catch (e) {
      console.warn("LSP didSave notify failed:", e.message);
    }
  }

  if (cachedOk || wroteLocal || mirrored) {
    st.dirty = false;
    renderTabs();

    if (norm === activeFile) {
      if (wroteLocal) {
        setAutosaveInfo("Autosave: saved ✓", "autosave-ok");
      } else if (cachedOk) {
        setAutosaveInfo("Autosave: cached ✓", "autosave-ok");
      } else {
        setAutosaveInfo("Autosave: mirrored ✓", "autosave-pending");
      }

      setTimeout(() => setAutosaveInfo("Autosave: —", "autosave-idle"), 2500);
    }

    return;
  }

  if (norm === activeFile) {
    setAutosaveInfo("Autosave: failed ✗", "autosave-fail");
  }

  if (!silent) {
    alert("Save failed: ni bilo mogoče shraniti ne lokalno ne v browser cache.");
  }
}

async function saveActiveFile(silent = false) {
  if (!activeFile) return;
  return saveFile(activeFile, silent);
}

//Diagnostics — vsaka datoteka posebej

function renderDiagnostics(diagnostics, uri) {
  if (!editor) return;

  const activeUri = fileStates.get(activeFile)?.uri;
  if (uri) diagnosticsByFile.set(uri, diagnostics || []);

  if (uri && uri !== activeUri) return;

  const list = diagnostics || [];
  clearDiagnostics();

  const byLine = new Map();

  list.forEach(diag => {
    const severityClass = severityToClass(diag.severity);
    const from = { line: diag.range.start.line, ch: diag.range.start.character };
    let endLine = diag.range.end.line;
    let endCh = diag.range.end.character;

    if (from.line === endLine && from.ch === endCh) endCh = from.ch + 1;
    if (endLine < from.line) endLine = from.line;

    const lineText = editor.getLine(from.line) || "";
    if (from.line === endLine && endCh > lineText.length) endCh = lineText.length;
    if (from.line === endLine && endCh <= from.ch) endCh = Math.min(lineText.length, from.ch + 1);

    const to = { line: endLine, ch: endCh };
    const mark = editor.markText(from, to, {
      className: `cm-lsp-${severityClass}`,
      attributes: { title: `${severityToLabel(diag.severity)}: ${diag.message}` }
    });
    diagnosticMarks.push(mark);

    const existing = byLine.get(from.line);
    if (!existing) {
      byLine.set(from.line, { severity: diag.severity, diagnostics: [diag] });
    } else {
      existing.diagnostics.push(diag);
      if ((diag.severity || 4) < (existing.severity || 4)) existing.severity = diag.severity;
    }
  });

  for (const [line, info] of byLine.entries()) {
    const severityClass = severityToClass(info.severity);

    const gutterMarker = document.createElement("div");
    gutterMarker.className = `cm-diagnostic-gutter-marker is-${severityClass}`;
    gutterMarker.title = info.diagnostics.map(d => `${severityToLabel(d.severity)}: ${d.message}`).join("\n");
    gutterMarker.textContent = info.severity === 1 ? "●" : info.severity === 2 ? "▲" : "◆";

    editor.setGutterMarker(line, "lsp-diagnostics-gutter", gutterMarker);
    diagnosticMarks.push({ clear: () => editor.setGutterMarker(line, "lsp-diagnostics-gutter", null) });

    editor.addLineClass(line, "background", `cm-diagnostic-line-${severityClass}`);
    diagnosticMarks.push({ clear: () => editor.removeLineClass(line, "background", `cm-diagnostic-line-${severityClass}`) });

    editor.addLineClass(line, "wrap", `cm-diagnostic-linewrap-${severityClass}`);
    diagnosticMarks.push({ clear: () => editor.removeLineClass(line, "wrap", `cm-diagnostic-linewrap-${severityClass}`) });
  }

  renderDiagnosticsPanel(activeUri, list);
}

function renderDiagnosticsPanel(uri, diagnostics) {
  const panel = document.getElementById("diagnosticsPanel");
  const listEl = document.getElementById("diagnosticsList");
  const countEl = document.getElementById("diagnosticsCount");

  if (!panel || !listEl || !countEl) return;

  const items = diagnostics || [];
  const errors = items.filter(d => d.severity === 1).length;
  const warnings = items.filter(d => d.severity === 2).length;
  countEl.textContent = `${errors} errors, ${warnings} warnings`;

  listEl.innerHTML = "";

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "diagnostics-empty";
    empty.textContent = "No errors ware detected.";
    listEl.appendChild(empty);
    panel.classList.remove("has-problems");
    return;
  }

  panel.classList.add("has-problems");

  items.forEach(diag => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `diagnostic-item is-${severityToClass(diag.severity)}`;

    const line = diag.range?.start?.line ?? 0;
    const ch = diag.range?.start?.character ?? 0;
    const source = diag.source ? ` • ${diag.source}` : "";

    row.innerHTML = `
      <span class="diagnostic-severity ${severityToClass(diag.severity)}"></span>
      <span class="diagnostic-main">
        <span class="diagnostic-message">${escapeHtml(diag.message)}</span>
        <span class="diagnostic-meta">${severityToLabel(diag.severity)} • line ${line + 1}, col ${ch + 1}${escapeHtml(source)}</span>
      </span>
    `;

    row.addEventListener("click", () => {
      editor.focus();
      editor.setCursor({ line, ch });
      editor.scrollIntoView({ line, ch }, 120);
    });

    listEl.appendChild(row);
  });
}

function clearDiagnostics() {
  diagnosticMarks.forEach(m => {
    try { m.clear(); } catch {}
  });
  diagnosticMarks = [];

  if (editor) editor.clearGutter("lsp-diagnostics-gutter");
}

function clearDiagnosticsForFile(uri) {
  diagnosticsByFile.delete(uri);
  clearDiagnostics();
  renderDiagnosticsPanel(uri, []);
}

//Status bar

function updateCursorInfo() {
  const pos = editor?.getCursor();
  if (!pos) return;
  const el = document.getElementById("cursorInfo");
  if (el) el.textContent = `Ln ${pos.line + 1}, Col ${pos.ch + 1}`;
}

function setServerInfo(t) {
  const el = document.getElementById("serverInfo");
  if (el) el.textContent = t;
}

function setAutosaveInfo(t, c) {
  const el = document.getElementById("autosaveInfo");
  if (!el) return;
  el.textContent = t;
  el.className = c;
}