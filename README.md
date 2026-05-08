# SmartCode Editor

> A browser-based code editor with real-time IntelliSense powered by a self-hosted LSP bridge.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Java](https://img.shields.io/badge/Java-JDK%2021-orange.svg)
![C/C++](https://img.shields.io/badge/C%2FC%2B%2B-clangd-blue.svg)

Supports **Java** (via Eclipse JDT Language Server) and **C/C++** (via clangd) out of the box. No build step required — open `editor.html` and start coding.

---

##  Features

- Syntax highlighting for Java, C, and C++
- Real-time autocomplete and diagnostics via LSP over WebSocket
- Inline error/warning markers
- Three usage modes — multi-file project, folder workspace, or embedded single-file editor
- Zero browser install — only the LSP bridge needs Docker

---

##  Architecture

```
Browser (editor.html)
  ├── CodeMirror 5          — editing surface, syntax highlighting
  ├── editorMain.js         — file management, tabs, autosave, diagnostics
  ├── lspClient.js          — WebSocket ↔ LSP JSON-RPC bridge (client side)
  └── smartCodeEditor.js    — public API  (initEditor / EditorAPI)

LSP Bridge (Docker)
  ├── server.js             — HTTP + WebSocket server
  ├── clangd                — C/C++ language server
  └── jdtls (Eclipse JDT)   — Java language server
```

The browser connects to the LSP bridge over WebSocket. The bridge forwards JSON-RPC messages between the editor and the language servers running inside the container.

---

##  Quick Start

### 1. Start the LSP bridge

```bash
cd server
docker build -t smartcode-lsp .
docker run -d \
  -p 3000:3000 \
  -v /your/workspace:/workspace \
  --name smartcode-lsp \
  smartcode-lsp
```

### 2. Open the editor

Open `editor.html` directly in a browser, or serve it with any static file server:

```bash
npx serve .
# then open http://localhost:3000
```

> **Note:** The File System Access API used for open/save requires Chrome or Edge 86+. Firefox is not currently supported for file operations.

---

##  Usage Modes

SmartCode supports three distinct usage modes configured at initialisation time.

---

### Mode 1 — Project mode *(default)*

Full multi-file editor with tabs, autosave, and project files. Best for standalone use.

```js
var ed = smartCodeEditor.initEditor(
  "editorDiv",   // container element id
  true,          // show toolbar
  true,          // show tab bar + status bar
  true,          // show diagnostics panel
  1              // mode
);
```

All open files are visible to the LSP simultaneously, so cross-file completions and diagnostics work correctly. Users can open a project file (JSON listing source files) or pick a directory.

**Opening a project programmatically:**

```js
ed.openProject({
  id:         "my-project",
  name:       "My Project",
  files: [
    { path: "Main.java",   content: "..." },
    { path: "Helper.java", content: "..." }
  ],
  activeFile: "Main.java"
});
```

**Opening a folder:**

```js
ed.openDirectoryProject(); // opens native OS directory picker
```

---

### Mode 2 — Folder workspace mode

Same as mode 1, but launches directly into a directory picker at startup.

```js
var ed = smartCodeEditor.initEditor("editorDiv", true, true, true, 2);
```

---

### Mode 3 — ALGator mode *(isolated single-file editor)*

No tabs, no autosave, no concept of filenames. Designed for embedding multiple independent editors on the same page. Each instance is completely isolated.

```js
var ed = smartCodeEditor.initEditor(
  "editorDiv",   // container element id
  false,         // no toolbar
  false,         // no tab bar / status bar
  true,          // diagnostics panel (auto-hides when no errors)
  3,             // mode
  {
    language: "java",      // "java" | "c" | "cpp"
    folder:   "mylib/src"  // optional — workspace subfolder for LSP context
  }
);

ed.whenReady().then(() => {
  ed.setContent("public class Main {\n    // ...\n}");
  console.log(ed.getContent());
});
```

> In mode 3 the diagnostics panel **automatically appears when there are errors or warnings and hides itself when there are none.** Multiple editors on the same page share the single LSP bridge connection but each maintains its own virtual file URI, so completions and diagnostics remain independent.

---

## 📖 API Reference

All modes return an `EditorAPI` object.

| Method | Modes | Description |
|---|---|---|
| `setContent(code, language?)` | 1 2 3 | Set editor content. Optionally switch language (`"java"`, `"c"`, `"cpp"`). |
| `getContent()` | 1 2 3 | Return current editor content as a string. |
| `setLanguage(lang)` | 1 2 3 | Switch language mode without changing content. |
| `getLanguage()` | 1 2 3 | Return current language string. |
| `setReadOnly(bool)` | 1 2 3 | Enable or disable read-only mode. |
| `focus()` | 1 2 3 | Give focus to the editor. |
| `whenReady()` | 1 2 3 | Returns a Promise that resolves when the editor and LSP are ready. |
| `destroy()` | 1 2 3 | Clean up the instance and close its LSP file. |
| `.cm` | 1 2 3 | Direct access to the underlying CodeMirror instance. |
| `onChange(fn)` | 1 2 3 | Callback `fn(content, filename)` fired on every edit. |
| `onSave(fn)` | 1 2 3 | Callback `fn(content, filename)` fired on save. |
| `onFileOpen(fn)` | 1 2 3 | Callback `fn(filename, language)` fired when a file opens. |
| `save()` | 1 2 | Manually trigger save. |
| `openFile(filename)` | 1 2 | Open a file by name. |
| `openProject(project)` | 1 | Load a project object. |
| `openDirectoryProject()` | 1 2 | Open native OS directory picker. |
| `getProjectInfo()` | 1 2 | Return current project metadata. |
| `setDiagnosticsVisible(bool)` | 1 2 3 | Show or hide the diagnostics panel. |
| `setToolbarVisible(bool)` | 1 2 | Show or hide the toolbar. |
| `setTabStatusbarVisible(bool)` | 1 2 | Show or hide tabs and status bar. |

---

##  LSP Bridge HTTP API

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Server status, connected client counts, workspace file list. |
| `/scan?folder=path` | GET | All files under `workspace/path` recursively. Omit `folder` to scan the whole workspace. |
| `/workspace/path/to/file` | GET | Read a file from the workspace (subdirectory paths supported). |
| `/workspace/path/to/file` | POST | Write a file to the workspace. Body is plain UTF-8 text. |

**WebSocket endpoints:**

| Path | Language server |
|---|---|
| `ws://host:3000/` | clangd (C / C++) |
| `ws://host:3000/java` | Eclipse JDT LS (Java) |

---

##  Project File Format

A project is a plain JSON file that can be stored anywhere on the user's machine. The server `workspace` folder is used only as a temporary LSP staging area — users do not need to know it exists.

```json
{
  "id": "my-project",
  "name": "My Project",
  "files": [
    { "path": "Main.java",   "content": "public class Main { ... }" },
    { "path": "Helper.java", "content": "public class Helper { ... }" }
  ],
  "activeFile": "Main.java"
}
```

---

##  Configuration

Edit `src/js/config.js` to change server URLs, timeouts, and completion behaviour.

```js
const CFG = Object.freeze({
  server: {
    wsUrl:     "ws://localhost:3000",
    javaWsUrl: "ws://localhost:3000/java",
    httpUrl:   "http://localhost:3000"
  },
  editor: {
    completionDelay: 120,  // ms after trigger character (. -> ::)
    identifierDelay: 300,  // ms after typing identifier characters
    memberMaxItems:  40,
    identifierMax:   20,
    javaMemberMax:   60
  },
  java: {
    initDelay: 1200        // ms to wait for jdtls initialisation
  }
});
```

---







---

##  Known Limitations

- **Firefox** is not supported for file open/save (no File System Access API).
- **C/C++ IntelliSense** works best when a `CMakeLists.txt` is present so clangd can read `compile_commands.json`. Without it, clangd uses fallback flags and may miss includes.
- **LSP index** is not persisted between page loads — each session starts fresh.

---

##  License

MIT
