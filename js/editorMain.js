// editorMain.js — zahteva config.js (mora biti naložen prej v HTML)
let editor;
let diagnosticMarks      = [];
let autosaveTimer        = null;
let completionTimer      = null;
let isLanguageChange = false;
let clangdInitialized    = false;
let javaInitialized      = false;

// Vse nastavitve iz config.js
const CFG = SmartCodeConfig;

// Obnovi zadnji jezik iz localStorage
const SAVED_MODE = localStorage.getItem("smartcode-mode") || "text/x-c++src";

const languageIds = {
  "text/x-java":   "java",
  "text/x-csrc":   "c",
  "text/x-c++src": "cpp"
};
const themes = {
  "text/x-java":   "eclipse",
  "text/x-csrc":   "default",
  "text/x-c++src": "eclipse"
};
const snippets = {
  "text/x-java": `public class Main {
  public static int add(int a, int b) {
    return a + b;
  }

  public static void main(String[] args) {
    String text = "Hello";
    System.out.println(text.length());
    System.out.println(add(2, 3));
  }
}`,
  "text/x-csrc": `#include <stdio.h>
#include <string.h>

struct Point {
    int x;
    int y;
};

int sum(int a, int b) {
    return a + b;
}

int main(void) {
    struct Point p;
    p.x = 10;
    p.y = 20;
    printf("%d\\n", sum(3, 4));
    printf("%d %d\\n", p.x, p.y);
    return 0;
}`,
  "text/x-c++src": `#include <iostream>
#include <string>
#include <vector>

class Person {
public:
    std::string name;
    int age;
};

int add(int a, int b) {
    return a + b;
}

int main() {
    Person p;
    std::string text = "Hello";
    std::vector<int> nums;

    nums.push_back(10);
    nums.push_back(20);

    std::cout << text << std::endl;
    std::cout << add(2, 3) << std::endl;
    return 0;
}`
};


const docState = {
  uri:        `${CFG.workspace.rootUri}/main.cpp`,
  languageId: "cpp",
  version:    1
};


function getFilename(mode)  { return CFG.workspace.files[mode] || "main.cpp"; }
function getCurrentMode()   { return editor?.getOption("mode") ?? SAVED_MODE; }
function getUri(mode)       { return `${CFG.workspace.rootUri}/${getFilename(mode)}`; }
function isClangd()         { const m = getCurrentMode(); return m === "text/x-c++src" || m === "text/x-csrc"; }
function isJava()           { return getCurrentMode() === "text/x-java"; }

function updateDocState(mode) {
  docState.languageId = languageIds[mode] || "cpp";
  docState.uri        = getUri(mode);
}

function setValueSafe(val) {
  isLanguageChange = true;
  editor.setValue(val);
  isLanguageChange = false;
}

//LSP routing
function lspRequest(method, params) {
  if (isJava())   return sendJavaRequest(method, params);
  if (isClangd()) return sendLspRequest(method, params);
  return Promise.reject(new Error("No LSP for this language"));
}

function lspNotification(method, params) {
  if (isJava())   { sendJavaNotification(method, params); return; }
  if (isClangd()) { sendLspNotification(method, params);  return; }
}

function lspReady() {
  if (isJava())   return isJavaLspReady();
  if (isClangd()) return isLspReady();
  return false;
}

//Snippet cleanup
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
  if (item.insertText)        return stripSnippets(item.insertText);
  return item.label;
}

//Startup
document.addEventListener("DOMContentLoaded", async () => {
  initEditor();
  initUI();
  await loadFromServer(getCurrentMode());
  initClangdLsp();
  initJavaLsp();
});

//Editor
function initEditor() {
  const ta = document.getElementById("editor");
  if (!ta) return console.error("Missing #editor");

  editor = CodeMirror.fromTextArea(ta, {
    mode:              SAVED_MODE,
    theme:             themes[SAVED_MODE] || "eclipse",
    lineNumbers:       true,
    matchBrackets:     true,
    autoCloseBrackets: true,
    indentUnit:        2,
    tabSize:           2,
    lineWrapping:      false,
    extraKeys: {
      "Ctrl-Space": () => { if (lspReady()) requestCompletion(null); },
      "Ctrl-S":     () => saveToServer(false)
    }
  });

  editor.setSize("100%", "100%");
  editor.refresh();
  editor.on("cursorActivity", updateCursorInfo);

  editor.on("change", (_cm, _ch) => {
    if (isLanguageChange) return;
    docState.version++;
    setAutosaveInfo("Autosave: pending…", "autosave-pending");

    lspNotification("textDocument/didChange", {
      textDocument:   { uri: docState.uri, version: docState.version },
      contentChanges: [{ text: editor.getValue() }]
    });

    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => saveToServer(true), CFG.editor.autosaveDelay);
  });

  editor.on("inputRead", (_cm, change) => {
    if (!lspReady()) return;

    const ch  = change.text?.[0];
    if (!ch) return;

    const cur  = editor.getCursor();
    const line = editor.getLine(cur.line) || "";

    if (ch === ".") {
      clearTimeout(completionTimer);
      if (editor.state.completionActive) editor.closeHint();
      completionTimer = setTimeout(() => requestCompletion("."), CFG.editor.completionDelay);
      return;
    }

    if (ch === ">" && cur.ch >= 2 && line[cur.ch - 2] === "-") {
      clearTimeout(completionTimer);
      if (editor.state.completionActive) editor.closeHint();
      completionTimer = setTimeout(() => requestCompletion(">"), CFG.editor.completionDelay);
      return;
    }

    if (ch === ":" && cur.ch >= 2 && line[cur.ch - 2] === ":") {
      clearTimeout(completionTimer);
      if (editor.state.completionActive) editor.closeHint();
      completionTimer = setTimeout(() => requestCompletion(":"), CFG.editor.completionDelay);
      return;
    }

    if (/^[a-zA-Z_]$/.test(ch)) {
      clearTimeout(completionTimer);
      completionTimer = setTimeout(() => requestCompletion(null), CFG.editor.identifierDelay);
      return;
    }

    if (change.origin === "+delete" && editor.state.completionActive) {
      clearTimeout(completionTimer);
      completionTimer = setTimeout(() => requestCompletion(null), CFG.editor.identifierDelay);
    }
  });

  updateCursorInfo();
}

//UI
function initUI() {
  const sel = document.getElementById("languageSelect");
  if (sel) sel.value = SAVED_MODE;

  document.getElementById("languageSelect")?.addEventListener("change", changeLanguage);
  document.getElementById("saveBtn")?.addEventListener("click", () => saveToServer(false));
  document.getElementById("loadBtn")?.addEventListener("click", () => loadFromServer(getCurrentMode()));
  document.getElementById("openBtn")?.addEventListener("click", () => document.getElementById("fileInput")?.click());
  document.getElementById("fileInput")?.addEventListener("change", onLocalFileSelected);
}

//LSP clangd
function initClangdLsp() {
  connectLsp(CFG.server.wsClangd);

  onLspOpen(async () => {
    if (clangdInitialized) return;
    clangdInitialized = true;
    if (isClangd()) setServerInfo("LSP: clangd ✓");

    try {
      await sendLspRequest("initialize", {
        processId: null,
        rootUri:   CFG.workspace.rootUri,
        capabilities: lspCapabilities()
      });
      sendLspNotification("initialized", {});
      if (isClangd()) sendDidOpen();
    } catch (e) {
      console.error("clangd init failed:", e);
    }
  });

  onLspClose(() => { clangdInitialized = false; if (isClangd()) setServerInfo("LSP: disconnected"); });
  onLspError(() => { if (isClangd()) setServerInfo("LSP: error"); });
  onLspDiagnostics(params => { if (isClangd()) renderDiagnostics(params?.diagnostics || []); });
}

//LSP jdtls
function initJavaLsp() {
  connectJavaLsp(CFG.server.wsJava);

  onJavaLspOpen(async () => {
    if (javaInitialized) return;
    javaInitialized = true;
    if (isJava()) setServerInfo("LSP: jdtls connecting…");

    await new Promise(r => setTimeout(r, CFG.editor.javaInitDelay));

    try {
      await sendJavaRequest("initialize", {
        processId: null,
        rootUri:   CFG.workspace.rootUri,
        capabilities: lspCapabilities()
      });
      sendJavaNotification("initialized", {});
      if (isJava()) {
        setServerInfo("LSP: jdtls ✓");
        sendDidOpen();
      }
    } catch (e) {
      console.error("jdtls init failed:", e);
      javaInitialized = false;
      if (isJava()) setServerInfo("LSP: jdtls retrying…");
      setTimeout(() => connectJavaLsp(CFG.server.wsJava), CFG.editor.javaRetryDelay);
    }
  });

  onJavaLspClose(() => {
    javaInitialized = false;
    if (isJava()) setServerInfo("LSP: jdtls disconnected");
    setTimeout(() => {
      if (!javaInitialized) connectJavaLsp(CFG.server.wsJava);
    }, CFG.editor.javaRetryDelay);
  });

  onJavaLspError(() => { if (isJava()) setServerInfo("LSP: jdtls error"); });
  onJavaLspDiagnostics(params => { if (isJava()) renderDiagnostics(params?.diagnostics || []); });
}

function lspCapabilities() {
  return {
    textDocument: {
      completion: {
        completionItem: {
          insertTextFormat:    { valueSet: [1, 2] },
          documentationFormat: ["plaintext", "markdown"],
          snippetSupport:      true,
          resolveSupport:      { properties: ["documentation", "detail"] }
        },
        contextSupport: true
      },
      hover:              { contentFormat: ["plaintext", "markdown"] },
      publishDiagnostics: { relatedInformation: true }
    }
  };
}

function sendDidOpen() {
  lspNotification("textDocument/didOpen", {
    textDocument: {
      uri:        docState.uri,
      languageId: docState.languageId,
      version:    docState.version,
      text:       editor.getValue()
    }
  });
}

function sendDidClose(uri) {
  lspNotification("textDocument/didClose", { textDocument: { uri } });
}

function updateServerInfo() {
  if (isClangd()) {
    setServerInfo(clangdInitialized ? "LSP: clangd ✓" : "LSP: connecting…");
  } else if (isJava()) {
    setServerInfo(javaInitialized ? "LSP: jdtls ✓" : "LSP: connecting…");
  } else {
    setServerInfo("LSP: —");
  }
}

//Completion
function requestCompletion(triggerChar = null) {
  if (!lspReady()) return;

  const cur   = editor.getCursor();
  const token = editor.getTokenAt(cur);

  const isMember    = triggerChar === "." || triggerChar === ">" || triggerChar === ":";
  const typedPrefix = isMember ? "" : (token.string || "");

  const minLen = isJava() && !isMember
    ? CFG.editor.javaMinPrefix
    : CFG.editor.clangdMinPrefix;

  if (!isMember && typedPrefix.length < minLen) {
    if (editor.state.completionActive) editor.closeHint();
    return;
  }

  const from = isMember
    ? CodeMirror.Pos(cur.line, cur.ch)
    : CodeMirror.Pos(cur.line, token.start);
  const to = CodeMirror.Pos(cur.line, cur.ch);

  lspRequest("textDocument/completion", {
    textDocument: { uri: docState.uri },
    position:     { line: cur.line, character: cur.ch },
    context: triggerChar
      ? { triggerKind: 2, triggerCharacter: triggerChar }
      : { triggerKind: 1 }
  })
  .then(result => {
    let items = Array.isArray(result) ? result : (result?.items ?? []);
    if (!items.length) { if (editor.state.completionActive) editor.closeHint(); return; }

    if (typedPrefix) {
      const lower = typedPrefix.toLowerCase();
      items = items.filter(item => {
        const label  = (item.label      || "").toLowerCase();
        const filter = (item.filterText || "").toLowerCase();
        return label.startsWith(lower) || filter.startsWith(lower);
      });
    }

    if (isClangd()) {
      if (isMember) {
        const members = items.filter(i => (i.sortText || "9") < "4");
        if (members.length > 0) items = members;
      } else {
        items = items.filter(i => (i.sortText || "9") < "7");
      }
    } else if (isJava()) {
      if (isMember) {
        const members = items.filter(i => (i.sortText || "z").startsWith("a"));
        if (members.length > 0) items = members;
      } else {
        const relevant = items.filter(i => {
          const s = i.sortText || "z";
          return s.startsWith("a") || s.startsWith("b");
        });
        if (relevant.length > 0) items = relevant;
      }
    }

    if (!items.length) { if (editor.state.completionActive) editor.closeHint(); return; }

    items.sort((a, b) => (a.sortText || a.label).localeCompare(b.sortText || b.label));

    const maxItems = isMember
      ? (isJava() ? CFG.editor.javaMemberMax : CFG.editor.memberMaxItems)
      : CFG.editor.identifierMax;
    items = items.slice(0, maxItems);

    if (editor.state.completionActive) editor.closeHint();

    CodeMirror.showHint(editor, () => ({
      from,
      to,
      list: items.map(item => ({
        text:        getInsertText(item),
        displayText: item.label,
        className:   "lsp-hint-item"
      }))
    }), {
      completeSingle: false,
      alignWithWord:  true,
      closeOnUnfocus: true
    });
  })
  .catch(e => console.error("Completion failed:", e));
}

//Save/Load 
async function saveToServer(silent = false) {
  const filename = getFilename(getCurrentMode());
  try {
    const res = await fetch(`${CFG.server.httpUrl}/workspace/${filename}`, {
      method:  "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body:    editor.getValue()
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setAutosaveInfo("Autosave: saved ✓", "autosave-ok");
    lspNotification("textDocument/didSave", { textDocument: { uri: docState.uri } });
    setTimeout(() => setAutosaveInfo("Autosave: —", "autosave-idle"), 2500);
  } catch (e) {
    setAutosaveInfo("Autosave: failed ✗", "autosave-fail");
    if (!silent) alert(`Save failed: ${e.message}`);
  }
}

async function loadFromServer(mode) {
  updateDocState(mode);
  const filename = getFilename(mode);
  try {
    const res  = await fetch(`${CFG.server.httpUrl}/workspace/${filename}`);
    const text = res.status === 404
      ? (snippets[mode] || "")
      : await res.text();
    if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
    setValueSafe(text || snippets[mode] || "");
  } catch (e) {
    console.warn("Load failed, using snippet:", e.message);
    setValueSafe(snippets[mode] || "");
  }

  editor.clearHistory();
  clearDiagnostics();
  setAutosaveInfo("Autosave: —", "autosave-idle");
  updateCursorInfo();

  if (isClangd() && clangdInitialized) { sendDidClose(docState.uri); sendDidOpen(); }
  if (isJava()   && javaInitialized)   { sendDidClose(docState.uri); sendDidOpen(); }
}

async function onLocalFileSelected(e) {
  const file = e.target.files[0];
  if (!file || !editor) return;

  const reader = new FileReader();
  reader.onload = async ev => {
    sendDidClose(docState.uri);

    const name = file.name.toLowerCase();
    let mode = getCurrentMode();
    if      (name.endsWith(".java"))                                         mode = "text/x-java";
    else if (name.endsWith(".c"))                                            mode = "text/x-csrc";
    else if (name.endsWith(".cpp") || name.endsWith(".cc") || name.endsWith(".cxx")) mode = "text/x-c++src";

    editor.setOption("mode",  mode);
    editor.setOption("theme", themes[mode]);
    const sel = document.getElementById("languageSelect");
    if (sel) sel.value = mode;
    updateDocState(mode);
    docState.version++;

    setValueSafe(ev.target.result || "");
    editor.clearHistory();
    clearDiagnostics();
    sendDidOpen();
    updateCursorInfo();
    updateServerInfo();
    await saveToServer(true);
  };
  reader.readAsText(file);
}

async function changeLanguage() {
  const sel = document.getElementById("languageSelect");
  if (!sel || !editor) return;
  const mode = sel.value;

  localStorage.setItem("smartcode-mode", mode);

  await saveToServer(true);
  sendDidClose(docState.uri);
  clearDiagnostics();

  editor.setOption("mode",  mode);
  editor.setOption("theme", themes[mode]);
  editor.refresh();
  editor.focus();
  docState.version++;

  updateServerInfo();
  await loadFromServer(mode);
}

//Diagnostics
function renderDiagnostics(diagnostics) {
  clearDiagnostics();
  diagnostics.forEach(diag => {
    const from = { line: diag.range.start.line, ch: diag.range.start.character };
    const to   = { line: diag.range.end.line,   ch: diag.range.end.character };
    const mark = editor.markText(from, to, {
      className:  diag.severity === 1 ? "cm-lsp-error" : "cm-lsp-warning",
      attributes: { title: diag.message }
    });
    diagnosticMarks.push(mark);
  });
}
function clearDiagnostics() { diagnosticMarks.forEach(m => m.clear()); diagnosticMarks = []; }

//Status bar 
function updateCursorInfo() {
  const pos = editor?.getCursor();
  if (!pos) return;
  const el = document.getElementById("cursorInfo");
  if (el) el.textContent = `Ln ${pos.line + 1}, Col ${pos.ch + 1}`;
}
function setServerInfo(t)      { const el = document.getElementById("serverInfo");   if (el) el.textContent = t; }
function setAutosaveInfo(t, c) { const el = document.getElementById("autosaveInfo"); if (!el) return; el.textContent = t; el.className = c; }
