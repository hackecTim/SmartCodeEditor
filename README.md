# SmartCode Editor

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Java](https://img.shields.io/badge/Java-JDK%2021-orange.svg)
![C/C++](https://img.shields.io/badge/C%2FC%2B%2B-clangd-blue.svg)
![Browser](https://img.shields.io/badge/browser-Chrome%20%2F%20Edge%2086%2B-green.svg)

A browser-based code editor with real-time IntelliSense powered by a self-hosted LSP bridge. Supports Java (via Eclipse JDT Language Server) and C/C++ (via clangd) out of the box.

---

## Features

- **Syntax highlighting** for Java, C, and C++
- **Real-time IntelliSense** — autocomplete, diagnostics, hover
- **Inline error/warning markers** with gutter icons 
- **Three usage modes** covering multi-file projects, folder workspaces, and embedded single-file editors
- **Zero install for the user** — runs entirely in the browser; only the LSP bridge server needs Docker

---

## Architecture

```
Browser (editor.html)
  ├── CodeMirror 5          — editing surface, syntax highlighting
  ├── editorMain.js         — file management, tabs, autosave, diagnostics rendering
  ├── lspClient.js          — WebSocket ↔ LSP JSON-RPC bridge (client side)
  └── smartCodeEditor.js    — public API  (initEditor / EditorAPI)

LSP Bridge (Docker)
  ├── server.js             — HTTP + WebSocket server
  ├── clangd               — C/C++ language server
  └── jdtls (Eclipse JDT)  — Java language server
```

The browser connects to the LSP bridge over WebSocket. The bridge forwards JSON-RPC messages between the editor and the language servers running inside the container.

---

## Quick Start

### 1. Start the LSP bridge

```bash
# Iz korena projekta:
docker build -f langserver/docker/Dockerfile -t smartcode-lsp langserver/
docker run -d \
  -p 3000:3000 \
  -v /your/workspace:/workspace \
  --name smartcode-lsp \
  smartcode-lsp
```

### 2. Open the editor

Open `editor.html` directly in a browser (or serve it with any static file server). No build step is needed.

```bash
# Simple static server example
npx serve .
# then open http://localhost:3000
```

> **Note:** The File System Access API used for open/save requires a browser that supports it (Chrome / Edge 86+). Firefox is not currently supported for file operations.

---

## Usage Modes

SmartCode supports three distinct usage modes set at initialisation time.

### Mode 1 — Project mode (default)

Full multi-file editor with tabs, autosave, and project files. Best for standalone use.

```js
var ed = smartCodeEditor.initEditor(
  "editorDiv",   // container element id
  true,          // show toolbar
  true,          // show tab bar + status bar
  true,          // show diagnostics panel
  smartCodeEditor.editorMode.PROJECT
);
```

Users open a project (a JSON file listing source files) or a directory. All open files are visible to the LSP simultaneously, so cross-file completions and diagnostics work correctly.

**Opening a project programmatically:**

```js
ed.openProject({
  id:         "my-project",
  name:       "My Project",
  files:      [{ path: "Main.java", content: "..." }, { path: "Helper.java", content: "..." }],
  activeFile: "Main.java"
});
```

**Opening a folder:**

```js
ed.openDirectoryProject();   // opens native directory picker
```

### `editorMode.FOLDER` — Folder workspace mode

Same as mode 1, but opens directly into a directory picker at startup. Suitable for embedding in tools where the user always works with a folder.

```js
var ed = smartCodeEditor.initEditor("editorDiv", true, true, true, smartCodeEditor.editorMode.FOLDER);
```

### Mode 3 — ALGator mode (isolated single-file editor)

No tabs, no autosave, no concept of filenames. Designed for embedding multiple independent editors on one page. Each instance is completely isolated.

```js
var ed = smartCodeEditor.initEditor(
  "editorDiv",   // container element id
  false,         // no toolbar
  false,         // no tab bar / status bar
  true,          // show diagnostics panel (auto-hides when no errors)
  3,             // mode
  {
    language: "java",       // "java" | "c" | "cpp"
    folder:   "mylib/src"   // optional — workspace subfolder for LSP context files
  }
);

ed.whenReady().then(() => {
  ed.setContent("public class Main {\n    // ...\n}");
  console.log(ed.getContent());
});
```

In mode 3 the diagnostics panel **automatically shows when there are errors/warnings and hides when there are none**. Multiple editors on the same page share the single LSP bridge connection but each maintains its own virtual file URI so completions and diagnostics are independent.

---

## API Reference

All modes return an `EditorAPI` object with the following methods.

| Method | Description |
|---|---|
| `setContent(code, language?)` | Set editor content. Optionally switch language (`"java"`, `"c"`, `"cpp"`). |
| `getContent()` | Return current editor content as a string. |
| `setLanguage(lang)` | Switch language mode without changing content. |
| `getLanguage()` | Return current language string. |
| `setReadOnly(bool)` | Enable or disable read-only mode. |
| `focus()` | Give focus to the editor. |
| `save()` | Manually trigger save (modes 1/2 only). |
| `openFile(filename)` | Open a file by name (modes 1/2 only). |
| `openProject(project)` | Load a project object (mode 1 only). |
| `openDirectoryProject()` | Open native directory picker (modes 1/2 only). |
| `getProjectInfo()` | Return current project metadata (modes 1/2 only). |
| `setDiagnosticsVisible(bool)` | Show or hide the diagnostics panel. |
| `setToolbarVisible(bool)` | Show or hide the toolbar (modes 1/2 only). |
| `setTabStatusbarVisible(bool)` | Show or hide tabs and status bar (modes 1/2 only). |
| `onChange(fn)` | Register a callback `fn(content, filename)` called on every edit. |
| `onSave(fn)` | Register a callback `fn(content, filename)` called on save. |
| `onFileOpen(fn)` | Register a callback `fn(filename, language)` called when a file is opened. |
| `whenReady()` | Returns a Promise that resolves when the editor (and LSP) are ready. |
| `destroy()` | Clean up the editor instance and close its LSP file. |
| `.cm` | Direct access to the underlying CodeMirror instance. |

---

## LSP Bridge HTTP API

The bridge exposes a small REST API alongside the WebSocket endpoints.

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Returns server status, connected client counts, workspace file list. |
| `/scan?folder=path` | GET | Returns all files under `workspace/path` recursively. Omit `folder` to scan the whole workspace. |
| `/workspace/path/to/file` | GET | Read a file from the workspace (supports subdirectory paths). |
| `/workspace/path/to/file` | POST | Write a file to the workspace. Body is plain text. |

WebSocket endpoints:

| Path | Language server |
|---|---|
| `ws://host:3000/` | clangd (C/C++) |
| `ws://host:3000/java` | Eclipse JDT LS (Java) |

---

## Project File Format

A project is a plain JSON file that can be stored anywhere on the user's machine.

```json
{
  "id":         "my-project",
  "name":       "My Project",
  "files": [
    { "path": "Main.java",   "content": "public class Main { ... }" },
    { "path": "Helper.java", "content": "public class Helper { ... }" }
  ],
  "activeFile": "Main.java"
}
```

The `workspace` folder on the server is used only as a temporary staging area for the LSP. Users do not need to know about it.

---

## Configuration

Edit `js/config.js` to change server URLs, timeouts, and completion behaviour.

```js
const CFG = Object.freeze({
  server: {
    wsUrl:      "ws://localhost:3000",
    javaWsUrl:  "ws://localhost:3000/java",
    httpUrl:    "http://localhost:3000"
  },
  editor: {
    completionDelay:  120,   // ms after trigger character (. -> ::)
    identifierDelay:  300,   // ms after typing identifier characters
    memberMaxItems:   40,
    identifierMax:    20,
    javaMemberMax:    60
  },
  java: {
    initDelay:        1200   // ms to wait for jdtls initialisation
  }
});
```

---

## Folder Structure

```
smartcode/
│
├── editor.html                 # Entry point — open this in the browser
│
├── src/                        # Editor front-end source
│   ├── js/
│   │   ├── config.js           # Server URLs, timeouts, completion limits
│   │   ├── editorMain.js       # Core editor logic (tabs, files, diagnostics, LSP integration)
│   │   └── smartCodeEditor.js  # Public API — initEditor() factory
│   │
│   ├── css/
│   │   └── editorStyle.css     # All editor styles
│   │
│   └── img/
│       ├── smartCodeLogo.svg
│       └── smartCodeLogo2.svg
│
├── lib/                        # Third-party libraries (not modified)
│   └── codemirror/             # CodeMirror 5 distribution
│
├── server/                     # LSP bridge (runs in Docker)
│   ├── Dockerfile
│   ├── package.json
│   ├── package-lock.json
│   ├── server.js               # HTTP + WebSocket server, clangd + jdtls management
│   ├── lspClient.js            # Client-side WebSocket ↔ LSP JSON-RPC adapter
│   └── start.sh                # Container entrypoint (cmake + node)
│
└── workspace/                  # Runtime workspace mounted into the Docker container
    ├── .classpath              # Eclipse JDT project descriptor
    ├── .project
    ├── .settings/
    ├── CMakeLists.txt          # clangd compile commands source
    └── compile_commands.json   # Generated by cmake at container start
```

> **Current structure note:** `lspClient.js` currently lives inside `langserver/js/` alongside the server code. It is a **browser** file (loaded by `editor.html`) and should be moved to `src/js/` to make the separation between front-end and back-end code clear. See the recommended structure above.

---

## Requirements

| Component | Requirement |
|---|---|
| Browser | Chrome or Edge 86+ (File System Access API) |
| Docker | 20.10+ |
| Server RAM | ≥ 2 GB recommended (jdtls alone uses ~500 MB) |
| Disk | ~1 GB for the Docker image (JDK 21 + clangd + jdtls) |

---

## Known Limitations

- C/C++ IntelliSense works best when a `CMakeLists.txt` is present so clangd can read `compile_commands.json`. Without it clangd uses fallback flags and may miss includes.
- Each page load starts a fresh LSP session; there is no persistent index cache between sessions.

---

## License

MIT
