//Preveri odvisnosti
if (typeof SmartCodeConfig === "undefined") throw new Error("config.js ni naložen!");
if (typeof CodeMirror      === "undefined") throw new Error("codemirror.js ni naložen!");
if (typeof connectLsp      === "undefined") throw new Error("lspClient.js ni naložen!");

let editor;
const CFG = SmartCodeConfig;

const fileStates   = new Map();
let   activeFile   = null;   

let diagnosticMarks      = [];
const diagnosticsByFile  = new Map(); 

let autosaveTimer        = null;
let completionTimer      = null;
let signatureTimer       = null;
let isFileSwitch         = false;
let suppressInputRead    = false;
let completionReqSeq     = 0;
let clangdInitialized    = false;
let javaInitialized      = false;
const openedDocs         = new Set();

const DEBUG_LSP = false;

//Jezik, ki ga preverjamo dobimo iz končnice
function modeForFile(filename) {
  const f = (filename || "").toLowerCase();
  if (f.endsWith(".java"))                        return "text/x-java";
  if (f.endsWith(".c"))                           return "text/x-csrc";
  if (f.endsWith(".cpp") || f.endsWith(".cc") || f.endsWith(".cxx") || f.endsWith(".h") || f.endsWith(".hpp"))
                                                  return "text/x-c++src";
  return "text/plain";
}

const languageIds = { "text/x-java": "java", "text/x-csrc": "c", "text/x-c++src": "cpp" };
const themes      = { "text/x-java": "eclipse", "text/x-csrc": "default", "text/x-c++src": "eclipse" };

function uriForFile(filename) {
  return `${CFG.workspace.rootUri}/${filename}`;
}

function isClangdFile(filename) {
  const m = modeForFile(filename);
  return m === "text/x-c++src" || m === "text/x-csrc";
}
function isJavaFile(filename) { return modeForFile(filename) === "text/x-java"; }

function currentMode()  { return modeForFile(activeFile || ""); }
function isClangd()     { return isClangdFile(activeFile || ""); }
function isJava()       { return isJavaFile(activeFile || ""); }

//Docstate iz aktivne datoteke
function docState() {
  const st = fileStates.get(activeFile);
  if (!st) return { uri: "", languageId: "plaintext", version: 1 };
  return st;
}
// LSP routing
function lspRequest(method, params) {
  if (isJava())   return sendJavaRequest(method, params);
  if (isClangd()) return sendLspRequest(method, params);
  return Promise.reject(new Error("No LSP for this language"));
}

function lspNotification(method, params) {
  if (isJava())   { sendJavaNotification(method, params); return; }
  if (isClangd()) { sendLspNotification(method, params); }
}

function lspReady() {
  if (isJava())   return isJavaLspReady();
  if (isClangd()) return isLspReady();
  return false;
}

//Signature hint

let sigEl = null;

function showSignatureHint(html) {
  if (!html) { hideSignatureHint(); return; }
  if (!sigEl) {
    sigEl = document.createElement("div");
    sigEl.className = "cm-signature-hint";
    document.body.appendChild(sigEl);
  }
  sigEl.innerHTML = html;
  sigEl.style.display = "block";
  requestAnimationFrame(() => {
    if (!sigEl || !editor) return;
    const cur    = editor.getCursor();
    const coords = editor.charCoords({ line: cur.line, ch: cur.ch }, "window");
    sigEl.style.left = Math.max(4, coords.left) + "px";
    sigEl.style.top  = (coords.top - sigEl.offsetHeight - 8) + "px";
  });
}

function hideSignatureHint() {
  if (sigEl) sigEl.style.display = "none";
}

function callDepth() {
  if (!editor) return 0;
  const before = (editor.getLine(editor.getCursor().line) || "").slice(0, editor.getCursor().ch);
  let depth = 0, inStr = false, strCh = "";
  for (const ch of before) {
    if (inStr) { if (ch === strCh) inStr = false; continue; }
    if (ch === '"' || ch === "'") { inStr = true; strCh = ch; continue; }
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
  if (item.insertText)        return stripSnippets(item.insertText);
  return item.label || "";
}

function isCallable(item) {
  return [2, 3, 6].includes(item.kind) ||
    (item.label || "").includes("(") ||
    (item.detail || "").includes("(") ||
    (item.insertText || "").includes("(");
}

function _getFunctionName(item) {
  const clean = stripSnippets(item.insertText || item.textEdit?.newText || item.label || "");
  const m = clean.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
  return m ? m[1] : clean.split("(")[0].trim();
}

function getTypedPrefixInfo() {
  const cur  = editor.getCursor();
  const line = editor.getLine(cur.line) || "";
  let start = cur.ch;
  while (start > 0 && /[A-Za-z0-9_$]/.test(line[start - 1])) start--;
  return {
    from:   CodeMirror.Pos(cur.line, start),
    to:     CodeMirror.Pos(cur.line, cur.ch),
    prefix: line.slice(start, cur.ch)
  };
}

function _escapeHtml(s) {
  return (s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

//Startup

document.addEventListener("DOMContentLoaded", async () => {
  initEditor();
  initUI();
  await refreshFileList();   // naloži datoteke iz /scan
  initClangdLsp();
  initJavaLsp();
});

//Editor setup

function initEditor() {
  const ta = document.getElementById("editor");
  if (!ta) { console.error("Missing #editor"); return; }

  editor = CodeMirror.fromTextArea(ta, {
    mode:              "text/plain",
    theme:             "eclipse",
    lineNumbers:       true,
    matchBrackets:     true,
    autoCloseBrackets: true,
    indentUnit:        2,
    tabSize:           2,
    lineWrapping:      false,
    extraKeys: {
      "Ctrl-Space": () => { if (lspReady()) requestCompletion(null); },
      "Ctrl-S":     () => saveActiveFile(false),
      "Esc":        () => { hideSignatureHint(); editor.closeHint?.(); }
    }
  });

  editor.setSize("100%", "100%");
  editor.refresh();
  editor.on("cursorActivity", updateCursorInfo);

  editor.on("change", (_cm, change) => {
    if (isFileSwitch) return;
    const st = fileStates.get(activeFile);
    if (!st) return;
    st.version++;

    setAutosaveInfo("Autosave: pending…", "autosave-pending");

    if (lspReady()) {
      lspNotification("textDocument/didChange", {
        textDocument:   { uri: st.uri, version: st.version },
        contentChanges: [{ text: editor.getValue() }]
      });
    }

    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => saveActiveFile(true), CFG.editor.autosaveDelay);

    //Java sproži completion po vsakem vnašanju
    if (isJava() && change.origin === "+input") {
      const ch = (change.text?.[0] || "").slice(-1);
      if (/^[A-Za-z0-9_$]$/.test(ch)) {
        clearTimeout(completionTimer);
        completionTimer = setTimeout(() => requestCompletion(null), 120);
      }
    }

    //Backspace
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
    const ch  = text.slice(-1);
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
    if (ch === ",") { scheduleSignatureRefresh(",", true, CFG.editor.completionDelay); return; }
    if (ch === ")") {
      clearTimeout(signatureTimer);
      signatureTimer = setTimeout(() => {
        if (callDepth() <= 0) hideSignatureHint();
        else scheduleSignatureRefresh(null, true, 0);
      }, 50);
      return;
    }
    // Identifier — za C/C++
    if (!isJava() && /^[a-zA-Z0-9_$]$/.test(ch)) {
      clearTimeout(completionTimer);
      completionTimer = setTimeout(() => requestCompletion(null), CFG.editor.identifierDelay);
    }
  });

  updateCursorInfo();
}

//File management

//Naloži seznam vseh datotek iz /scan
async function refreshFileList() {
  let files = [];
  try {
    const res = await fetch(`${CFG.server.httpUrl}/scan`);
    if (res.ok) {
      const data = await res.json();
      //Filtriraj samo koristne datoteke
      files = (data.files || []).filter(f => {
        const low = f.toLowerCase();
        return low.endsWith(".java") || low.endsWith(".c") || low.endsWith(".cpp") ||
               low.endsWith(".cc")  || low.endsWith(".cxx") || low.endsWith(".h") ||
               low.endsWith(".hpp");
      });
    }
  } catch (e) {
    console.warn("refreshFileList: /scan failed:", e.message);
    //Fallback na privzete datoteke
    files = ["main.cpp", "main.c", "main.java"];
  }

  //Zagotovi da so privzete datoteke vedno prisotne
  for (const def of ["main.cpp", "main.c", "main.java"]) {
    if (!files.includes(def)) files.push(def);
  }

  //Za vsako datoteko ustvari state če ga še ni
  for (const f of files) {
    if (!fileStates.has(f)) {
      fileStates.set(f, {
        uri:        uriForFile(f),
        languageId: languageIds[modeForFile(f)] || "plaintext",
        version:    1,
        content:    null   //null = še ni naložena
      });
    }
  }
  const lastFile = localStorage.getItem("smartcode-file");
  const target   = (lastFile && fileStates.has(lastFile)) ? lastFile : files[0];

  renderTabs();
  await openFile(target);
}

//Odpri datoteko
async function openFile(filename) {
  if (!fileStates.has(filename)) {
    fileStates.set(filename, {
      uri:        uriForFile(filename),
      languageId: languageIds[modeForFile(filename)] || "plaintext",
      version:    1,
      content:    null
    });
    renderTabs();
  }

  const st = fileStates.get(filename);

  //Naloži vsebino če je še ni
  if (st.content === null) {
    try {
      const res = await fetch(`${CFG.server.httpUrl}/workspace/${filename}`);
      st.content = res.status === 404 ? defaultSnippet(filename) : await res.text();
    } catch {
      st.content = defaultSnippet(filename);
    }
  }

  //Shrani vsebino trenutne datoteke
  if (activeFile && activeFile !== filename) {
    const cur = fileStates.get(activeFile);
    if (cur) cur.content = editor.getValue();
  }

  //Pošlji didClose za prejšnjo datoteko
  if (activeFile && activeFile !== filename) {
    const old = fileStates.get(activeFile);
    if (old && openedDocs.has(old.uri)) {
      sendDidCloseForFile(activeFile);
    }
  }

  activeFile = filename;
  localStorage.setItem("smartcode-file", filename);

  const mode  = modeForFile(filename);
  const theme = themes[mode] || "eclipse";

  isFileSwitch = true;
  editor.setOption("mode",  mode);
  editor.setOption("theme", theme);
  editor.setValue(st.content || "");
  editor.clearHistory();
  isFileSwitch = false;

  editor.refresh();
  editor.focus();

  clearDiagnosticsForFile(st.uri);
  hideSignatureHint();
  setAutosaveInfo("Autosave: —", "autosave-idle");
  updateCursorInfo();
  updateServerInfo();
  renderTabs();

  //Pošlji didOpen za novo datoteko
  if (lspReady()) sendDidOpenForFile(filename);
}

function defaultSnippet(filename) {
  const mode = modeForFile(filename);
  const base = filename.replace(/\.[^.]+$/, "");
  const cls  = base.charAt(0).toUpperCase() + base.slice(1);

  if (mode === "text/x-java")
    return `public class ${cls} {\n\n    public static void main(String[] args) {\n        \n    }\n}\n`;
  if (mode === "text/x-csrc")
    return `#include <stdio.h>\n\nint main(void) {\n    \n    return 0;\n}\n`;
  if (mode === "text/x-c++src")
    return `#include <iostream>\n\nint main() {\n    \n    return 0;\n}\n`;
  return "";
}

//Tabs rendering
function renderTabs() {
  const bar = document.getElementById("tabBar");
  if (!bar) return;

  bar.innerHTML = "";
  for (const [filename] of fileStates) {
    const tab = document.createElement("div");
    tab.className = "tab" + (filename === activeFile ? " tab-active" : "");

    const icon = document.createElement("span");
    icon.className = "tab-icon";
    icon.textContent = fileIcon(filename);

    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = filename;

    const close = document.createElement("button");
    close.className = "tab-close";
    close.textContent = "×";
    close.title = "Zapri";
    close.addEventListener("click", e => {
      e.stopPropagation();
      closeTab(filename);
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
  if (m === "text/x-java")   return "☕";
  if (m === "text/x-csrc")   return "🔵";
  if (m === "text/x-c++src") return "🟣";
  return "📄";
}

function closeTab(filename) {
  if (fileStates.size <= 1) return;  // vsaj ena datoteka mora ostati
  const st = fileStates.get(filename);
  if (st) sendDidCloseForFile(filename);
  fileStates.delete(filename);

  if (activeFile === filename) {
    const remaining = [...fileStates.keys()];
    openFile(remaining[0]);
  } else {
    renderTabs();
  }
}

// UI buttons


function initUI() {
  document.getElementById("newFileBtn")?.addEventListener("click", createNewFile);
  document.getElementById("saveBtn")?.addEventListener("click", () => saveActiveFile(false));
  document.getElementById("openBtn")?.addEventListener("click", () => document.getElementById("fileInput")?.click());
  document.getElementById("fileInput")?.addEventListener("change", onLocalFilesSelected);
}

async function createNewFile() {
  const name = prompt("Ime datoteke (npr. Helper.java, utils.cpp, math.c):");
  if (!name || !name.trim()) return;
  const filename = name.trim();

  //Ustvari prazno datoteko na strežniku
  const content = defaultSnippet(filename);
  try {
    await fetch(`${CFG.server.httpUrl}/workspace/${filename}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: content
    });
  } catch (e) {
    alert("Napaka pri ustvarjanju datoteke: " + e.message);
    return;
  }

  fileStates.set(filename, {
    uri:        uriForFile(filename),
    languageId: languageIds[modeForFile(filename)] || "plaintext",
    version:    1,
    content
  });

  renderTabs();
  await openFile(filename);

  //Odpri novo Java datoteko v jdtls
  if (isJavaFile(filename) && javaInitialized) {
    sendJavaNotification("textDocument/didOpen", {
      textDocument: {
        uri:        uriForFile(filename),
        languageId: "java",
        version:    1,
        text:       content
      }
    });
    openedDocs.add(uriForFile(filename));
  }
}

async function onLocalFilesSelected(e) {
  const files = Array.from(e.target.files || []);
  for (const file of files) {
    const text = await file.text();
    const filename = file.name;

    //Shrani na strežnik
    try {
      await fetch(`${CFG.server.httpUrl}/workspace/${filename}`, {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: text
      });
    } catch (e) { console.warn("Upload failed:", e); }

    fileStates.set(filename, {
      uri:        uriForFile(filename),
      languageId: languageIds[modeForFile(filename)] || "plaintext",
      version:    1,
      content:    text
    });
  }
  renderTabs();
  if (files.length > 0) await openFile(files[files.length - 1].name);
  e.target.value = "";
}

//LSP — clangd

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
      if (isClangd() && activeFile) sendDidOpenForFile(activeFile);
    } catch (e) { console.error("clangd init failed:", e); }
  });

  onLspClose(() => { clangdInitialized = false; if (isClangd()) setServerInfo("LSP: disconnected"); });
  onLspError(() => { if (isClangd()) setServerInfo("LSP: error"); });
  onLspDiagnostics(params => {
    if (isClangd()) renderDiagnostics(params?.diagnostics || [], params?.uri);
  });
}

//LSP — jdtls

function initJavaLsp() {
  connectJavaLsp(CFG.server.wsJava);

  onJavaLspOpen(async () => {
    if (javaInitialized) return;
    javaInitialized = true;
    if (isJava()) setServerInfo("LSP: jdtls connecting…");

    await new Promise(r => setTimeout(r, CFG.editor.javaInitDelay));

    try {
      await sendJavaRequest("initialize", {
        processId:        null,
        rootUri:          CFG.workspace.rootUri,
        workspaceFolders: [{ uri: CFG.workspace.rootUri, name: "workspace" }],
        capabilities:     lspCapabilities()
      });
      sendJavaNotification("initialized", {});
      sendJavaNotification("workspace/didChangeConfiguration", {
        settings: {
          java: {
            completion:   { enabled: true, guessMethodArguments: true },
            signatureHelp: { enabled: true }
          }
        }
      });

      if (isJava()) setServerInfo("LSP: jdtls ✓");

      await openAllJavaFilesInLsp();

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
    setTimeout(() => { if (!javaInitialized) connectJavaLsp(CFG.server.wsJava); },
      CFG.editor.javaRetryDelay);
  });

  onJavaLspError(() => { if (isJava()) setServerInfo("LSP: jdtls error"); });
  onJavaLspDiagnostics(params => {
    if (isJava()) renderDiagnostics(params?.diagnostics || [], params?.uri);
  });
}

//Odpri VSE .java datoteke v workspace
async function openAllJavaFilesInLsp() {
  let javaFiles = [];

  try {
    const res = await fetch(`${CFG.server.httpUrl}/scan`);
    if (res.ok) {
      const data = await res.json();
      javaFiles = (data.files || []).filter(f => f.endsWith(".java"));
    }
  } catch {
    javaFiles = [...fileStates.keys()].filter(f => f.endsWith(".java"));
  }

  for (const filename of javaFiles) {
    const uri = uriForFile(filename);
    if (openedDocs.has(uri)) continue;

    //Naloži vsebino
    let text = fileStates.get(filename)?.content;
    if (!text) {
      try {
        const res = await fetch(`${CFG.server.httpUrl}/workspace/${filename}`);
        text = res.ok ? await res.text() : defaultSnippet(filename);
      } catch { text = defaultSnippet(filename); }
    }

    openedDocs.add(uri);
    sendJavaNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "java", version: 1, text }
    });
  }

  // Odpri zadnjo aktivno datoteko 
  if (activeFile && isJavaFile(activeFile)) {
    sendDidOpenForFile(activeFile);
  }
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
      signatureHelp: {
        signatureInformation: {
          documentationFormat:  ["plaintext", "markdown"],
          parameterInformation: { labelOffsetSupport: true }
        },
        contextSupport: true
      },
      hover:              { contentFormat: ["plaintext", "markdown"] },
      publishDiagnostics: { relatedInformation: true }
    },
    workspace: {
      workspaceFolders:      true,
      didChangeWatchedFiles: { dynamicRegistration: true }
    }
  };
}

function sendDidOpenForFile(filename) {
  const st = fileStates.get(filename);
  if (!st || !lspReady()) return;

  const text = filename === activeFile ? editor.getValue() : (st.content || "");
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
  openedDocs.delete(st.uri);
  if (!lspReady()) return;
  lspNotification("textDocument/didClose", { textDocument: { uri: st.uri } });
}

function updateServerInfo() {
  if (isClangd()) setServerInfo(clangdInitialized ? "LSP: clangd ✓" : "LSP: connecting…");
  else if (isJava()) setServerInfo(javaInitialized ? "LSP: jdtls ✓" : "LSP: connecting…");
  else setServerInfo("LSP: —");
}

// Signature Help

function requestSignatureHelp(triggerChar, isRetrigger) {
  if (!lspReady()) return;
  const st  = docState();
  const cur = editor.getCursor();

  lspRequest("textDocument/signatureHelp", {
    textDocument: { uri: st.uri },
    position:     { line: cur.line, character: cur.ch },
    context: {
      triggerKind:      triggerChar ? 2 : 1,
      isRetrigger:      isRetrigger ?? false,
      triggerCharacter: triggerChar || undefined
    }
  })
  .then(result => {
    if (!result?.signatures?.length) { hideSignatureHint(); return; }
    const sig      = result.signatures[result.activeSignature ?? 0];
    if (!sig) { hideSignatureHint(); return; }
    const paramIdx = result.activeParameter ?? sig.activeParameter ?? 0;
    const params   = sig.parameters || [];
    let   label    = _escapeHtml(sig.label);

    if (params[paramIdx]) {
      const p = params[paramIdx];
      let pLabel, pStart, pEnd;
      if (Array.isArray(p.label)) {
        [pStart, pEnd] = p.label;
        pLabel = sig.label.slice(pStart, pEnd);
      } else {
        pLabel = p.label;
        pStart = sig.label.indexOf(pLabel);
        pEnd   = pStart + pLabel.length;
      }
      if (pStart >= 0) {
        label = _escapeHtml(sig.label.slice(0, pStart)) +
                "<strong>" + _escapeHtml(pLabel) + "</strong>" +
                _escapeHtml(sig.label.slice(pEnd));
      }
    }
    showSignatureHint(label);
  })
  .catch(() => {});
}

//Completion

function requestCompletion(triggerChar = null) {
  if (!lspReady()) return;

  const st       = docState();
  const reqSeq   = ++completionReqSeq;
  const reqVer   = st.version;
  const reqMode  = currentMode();
  const reqCur   = editor.getCursor();
  const isMember = triggerChar === "." || triggerChar === ">" || triggerChar === ":";
  const { from, to, prefix } = getTypedPrefixInfo();
  const typedPrefix = isMember ? "" : prefix;

  if (!isMember && typedPrefix.length < 1) {
    if (editor.state.completionActive) editor.closeHint?.();
    return;
  }

  lspRequest("textDocument/completion", {
    textDocument: { uri: st.uri },
    position:     { line: reqCur.line, character: reqCur.ch },
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
    if (!items.length) { if (editor.state.completionActive) editor.closeHint?.(); return; }

    //Filtriraj po prefixu
    if (typedPrefix && (!isJava() || isMember)) {
      const lower = typedPrefix.toLowerCase();
      items = items.filter(item =>
        (item.label || "").toLowerCase().startsWith(lower) ||
        (item.filterText || "").toLowerCase().startsWith(lower) ||
        stripSnippets(item.insertText || "").toLowerCase().startsWith(lower)
      );
    }

    //sortText filter
    if (isClangd()) {
      if (isMember) { const m = items.filter(i => (i.sortText || "9") < "4"); if (m.length) items = m; }
      else          { items = items.filter(i => (i.sortText || "9") < "7"); }
    } else if (isJava() && isMember) {
      const m = items.filter(i => !((i.sortText||"").startsWith("zzz") || (i.sortText||"").startsWith("ZZZ")));
      if (m.length) items = m;
    }

    if (!items.length) { if (editor.state.completionActive) editor.closeHint?.(); return; }

    items.sort((a, b) => (a.sortText || a.label || "").localeCompare(b.sortText || b.label || ""));
    const max = isMember ? (isJava() ? CFG.editor.javaMemberMax : CFG.editor.memberMaxItems) : CFG.editor.identifierMax;
    items = items.slice(0, max);

    if (editor.state.completionActive) editor.closeHint?.();

    CodeMirror.showHint(editor, () => ({
      from, to,
      list: items.map(item => {
        const callable = isCallable(item);
        return {
          displayText: callable
            ? (item.label.includes("(") ? item.label : item.label + "(…)")
            : item.label,
          hint(cm) {
            suppressInputRead = true;
            try {
              if (callable) {
                cm.replaceRange(_getFunctionName(item) + "()", from, to, "complete");
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
    }), { completeSingle: false, alignWithWord: true, closeOnUnfocus: true });
  })
  .catch(e => console.error("Completion failed:", e));
}

//Save

async function saveActiveFile(silent = false) {
  if (!activeFile) return;
  const st      = fileStates.get(activeFile);
  const content = editor.getValue();
  if (st) st.content = content;

  try {
    const res = await fetch(`${CFG.server.httpUrl}/workspace/${activeFile}`, {
      method:  "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body:    content
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setAutosaveInfo("Autosave: saved ✓", "autosave-ok");

    if (lspReady() && st) {
      lspNotification("textDocument/didSave", { textDocument: { uri: st.uri } });
      if (isJava() && javaInitialized) {
        sendJavaNotification("workspace/didChangeWatchedFiles", {
          changes: [{ uri: st.uri, type: 2 }]
        });
      }
    }

    setTimeout(() => setAutosaveInfo("Autosave: —", "autosave-idle"), 2500);
  } catch (e) {
    setAutosaveInfo("Autosave: failed ✗", "autosave-fail");
    if (!silent) alert(`Save failed: ${e.message}`);
  }
}

//Diagnostics — per file

function renderDiagnostics(diagnostics, uri) {
  const activeUri = fileStates.get(activeFile)?.uri;
  if (uri && uri !== activeUri) {
    diagnosticsByFile.set(uri, diagnostics);
    return;
  }
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

function clearDiagnostics() {
  diagnosticMarks.forEach(m => m.clear());
  diagnosticMarks = [];
}

function clearDiagnosticsForFile(uri) {
  diagnosticsByFile.delete(uri);
  clearDiagnostics();
}

//Status bar

function updateCursorInfo() {
  const pos = editor?.getCursor();
  if (!pos) return;
  const el = document.getElementById("cursorInfo");
  if (el) el.textContent = `Ln ${pos.line + 1}, Col ${pos.ch + 1}`;
}
function setServerInfo(t)      { const el = document.getElementById("serverInfo");   if (el) el.textContent = t; }
function setAutosaveInfo(t, c) { const el = document.getElementById("autosaveInfo"); if (!el) return; el.textContent = t; el.className = c; }
