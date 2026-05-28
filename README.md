# SmartCode Editor

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Java](https://img.shields.io/badge/Java-JDK%2021-orange.svg)
![C/C++](https://img.shields.io/badge/C%2FC%2B%2B-clangd-blue.svg)
![Browser](https://img.shields.io/badge/browser-Chrome%20%2F%20Edge%2086%2B-green.svg)

SmartCode is a browser-based code editor with real-time IntelliSense powered by a self-hosted LSP bridge. It supports Java through Eclipse JDT Language Server and C/C++ through clangd.

The editor can be used as a full project editor, as a folder-based editor, or as an embedded single-file editor inside another web application.

---

## Features

- **Syntax highlighting** for Java, C, and C++
- **Real-time IntelliSense**: autocomplete, diagnostics, hover and signature help
- **Inline error and warning markers** with gutter icons
- **Cross-file Java support** when all project files are opened or scanned into the LSP workspace
- **Three usage modes**: project, folder and embedded single editor
- **Configurable workspace synchronisation** between `/workspace` and `/algator-root`
- **Optional lsyncd support** for background file watching and synchronisation
- **Browser-only client**: users do not need local language servers installed

---

## Architecture

```text
Browser
  ├── editor.html
  ├── CodeMirror 5
  ├── js/config.js
  ├── js/editorMain.js
  ├── js/smartCodeEditor.js
  └── langserver/js/lspClient.js

Docker LSP Bridge
  ├── langserver/js/server.js
  ├── clangd
  ├── Eclipse JDT Language Server
  ├── lsyncd / rsync
  ├── /workspace
  └── /algator-root
```

The browser communicates with the Docker bridge through WebSocket connections. The bridge forwards LSP JSON-RPC messages to `clangd` or `jdtls`.

Source files are staged in `/workspace`, which is the main LSP working directory. When synchronisation is enabled, changes can be copied from `/workspace` to `/algator-root`.

---

## Quick Start

### 1. Build the Docker image

From the project root:

```bash
docker build -f langserver/docker/Dockerfile -t smartcode-lsp langserver/
```

### 2. Start the LSP bridge

Linux/macOS example:

```bash
docker run --rm -it \
  -p 3000:3000 \
  -e ENABLE_LSYNC=true \
  -e SYNC_ROOT=main \
  -v "$PWD/workspace:/workspace" \
  -v "$PWD/algator-root:/algator-root" \
  smartcode-lsp
```

Windows PowerShell example:

```powershell
docker run --rm -it `
  -p 3000:3000 `
  -e ENABLE_LSYNC=true `
  -e SYNC_ROOT=main `
  -v "C:\xampp\htdocs\smartCodev3\workspace:/workspace" `
  -v "C:\xampp\htdocs\smartCodev3\algator-root:/algator-root" `
  smartcode-lsp
```

`/workspace` is used by the editor and language servers. `/algator-root` is the target folder for synchronisation.

### 3. Open the editor

Open `editor.html` directly in Chrome or Edge, or serve the project with a static server.

```bash
npx serve . -l 8080
```

Then open:

```text
http://localhost:8080/editor.html
```

Do not use port `3000` for the static frontend if the Docker LSP bridge is already using that port.

---

## Docker Options

### Enable or disable lsyncd at runtime

Enable lsyncd:

```bash
-e ENABLE_LSYNC=true
```

Disable lsyncd:

```bash
-e ENABLE_LSYNC=false
```

When lsyncd is disabled, the background watcher is not started. The editor can still write files to `/workspace`; only automatic background watching/syncing is disabled.

### Set the initial sync root

```bash
-e SYNC_ROOT=main
```

This means:

```text
/workspace/main      ->      /algator-root/main
```

The sync root is recursive, so all subfolders inside `main` are included.

If `SYNC_ROOT` is empty or omitted, the whole workspace is used:

```text
/workspace           ->      /algator-root
```

### Build Docker without installing lsyncd

If your `Dockerfile` supports the `INSTALL_LSYNC` build argument, you can build without lsyncd:

```bash
docker build -f langserver/docker/Dockerfile \
  -t smartcode-lsp \
  --build-arg INSTALL_LSYNC=false \
  langserver/
```

If you build without lsyncd, also run the container with:

```bash
-e ENABLE_LSYNC=false
```

---

## Usage Modes

SmartCode uses named constants instead of numeric modes.

```js
smartCodeEditor.editorMode.PROJECT
smartCodeEditor.editorMode.FOLDER
smartCodeEditor.editorMode.SINGLE
```

### Project mode

Project mode is the default full editor. It includes toolbar buttons, tabs, status bar, autosave and diagnostics.

```js
var ed = smartCodeEditor.initEditor(
  "editorDiv",

  true,  // showToolbar: shows the top toolbar with New, Open and Save buttons
  true,  // showTabStatusbar: shows file tabs and the bottom status bar
  true,  // showDiagnostics: shows diagnostics, errors and warnings

  smartCodeEditor.editorMode.PROJECT,

  {
    // Empty syncRoot means the whole /workspace is synced.
    syncRoot: "",

    // Enables or disables background lsyncd watching.
    lsyncEnabled: true
  }
);
```

If your project is inside a specific folder, use that folder as the sync root:

```js
var ed = smartCodeEditor.initEditor(
  "editorDiv",
  true,
  true,
  true,
  smartCodeEditor.editorMode.PROJECT,
  {
    folder: "main",
    syncRoot: "main",
    lsyncEnabled: true
  }
);
```

This uses:

```text
/workspace/main      ->      /algator-root/main
```

including all subfolders.

### Folder mode

Folder mode opens the native directory picker at startup.

```js
var ed = smartCodeEditor.initEditor(
  "editorDiv",
  true,
  true,
  true,
  smartCodeEditor.editorMode.FOLDER,
  {
    syncRoot: "",
    lsyncEnabled: true
  }
);
```

This mode is useful when the user always works with a local folder.

### Single embedded editor mode

Single mode is intended for embedding one isolated editor inside another web application. It does not use tabs or the full project UI.

```js
var ed = smartCodeEditor.initEditor(
  "editorDiv",

  false, // no toolbar
  false, // no tabs or status bar
  true,  // diagnostics panel is enabled

  smartCodeEditor.editorMode.SINGLE,

  {
    language: "java",

    // Folder used as context for LSP completions and diagnostics.
    folder: "main/src",

    // Folder watched/synchronised recursively.
    syncRoot: "main",

    // Enables or disables background lsyncd.
    lsyncEnabled: true
  }
);

ed.whenReady().then(() => {
  ed.setContent("public class Main {\n    public static void main(String[] args) {\n    }\n}", "java");
});
```

For Java cross-file autocomplete, make sure `folder` points to the directory that contains the related `.java` files, or to a parent folder that includes them.

---

## Synchronisation Behaviour

### `syncRoot`

`syncRoot` is a relative path inside `/workspace`.

```js
syncRoot: "main"
```

means:

```text
/workspace/main      ->      /algator-root/main
```

All subfolders inside `main` are included.

```js
syncRoot: ""
```

means:

```text
/workspace           ->      /algator-root
```

### `lsyncEnabled`

`lsyncEnabled` controls the background lsyncd watcher.

```js
lsyncEnabled: true
```

starts or keeps lsyncd active.

```js
lsyncEnabled: false
```

stops or disables lsyncd.

### Change sync root at runtime

```js
await ed.setSyncRoot("main2", true);
```

This changes the sync root to:

```text
/workspace/main2     ->      /algator-root/main2
```

### Disable lsyncd at runtime

```js
await ed.setLsyncEnabled(false);
```

### Enable lsyncd again

```js
await ed.setLsyncEnabled(true);
```

### Sync the whole workspace

```js
await ed.setSyncRoot("", true);
```

This means:

```text
/workspace           ->      /algator-root
```

---

## API Reference

All modes return an `EditorAPI` object.

| Method | Description |
|---|---|
| `setContent(code, language?)` | Sets editor content. Optionally switches language: `"java"`, `"c"` or `"cpp"`. |
| `getContent()` | Returns current editor content. |
| `setLanguage(lang)` | Changes editor language without changing content. |
| `getLanguage()` | Returns current language. |
| `setReadOnly(bool)` | Enables or disables read-only mode. |
| `focus()` | Focuses the editor. |
| `save()` | Manually saves the active file. Available in project/folder modes. |
| `openFile(filename)` | Opens a file by name. Available in project/folder modes. |
| `openProject(project)` | Loads a project object. Available in project mode. |
| `openDirectoryProject()` | Opens the native directory picker. Available in project/folder modes. |
| `getProjectInfo()` | Returns current project metadata. Available in project/folder modes. |
| `setDiagnosticsVisible(bool)` | Shows or hides diagnostics. |
| `setToolbarVisible(bool)` | Shows or hides the toolbar. |
| `setTabStatusbarVisible(bool)` | Shows or hides tabs and the status bar. |
| `setSyncRoot(syncRoot, lsyncEnabled?)` | Changes the active sync root and optionally enables/disables lsyncd. |
| `setLsyncEnabled(bool)` | Enables or disables the background lsyncd watcher. |
| `onChange(fn)` | Registers `fn(content, filename)` callback for edits. |
| `onSave(fn)` | Registers `fn(content, filename)` callback for saves. |
| `onFileOpen(fn)` | Registers `fn(filename, language)` callback for file opening. |
| `whenReady()` | Returns a Promise that resolves when the editor is ready. |
| `destroy()` | Cleans up the editor instance. |
| `.cm` | Direct access to the underlying CodeMirror instance. |

---

## LSP Bridge HTTP API

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Returns bridge status, LSP status, sync state and file list. |
| `/scan?folder=path` | GET | Recursively scans `/workspace/path`. Omit `folder` to scan all workspace. |
| `/workspace/path/to/file` | GET | Reads a file from `/workspace`. |
| `/workspace/path/to/file` | POST | Writes a file to `/workspace`. |
| `/workspace-patch/path/to/file` | POST | Applies a CodeMirror-style text patch to a workspace file. |
| `/sync-root` | POST | Sets `syncRoot` and `lsyncEnabled`. |
| `/notify` | POST | Sends file-change notification to the Java language server. |
| `/algator/path/to/file` | POST | Writes a file into both `/algator-root` and `/workspace`. |
| `/projects` | GET | Lists directories in `/algator-root`. |

Example `/sync-root` request:

```js
await fetch("http://localhost:3000/sync-root", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    syncRoot: "main",
    lsyncEnabled: true
  })
});
```

WebSocket endpoints:

| Path | Language server |
|---|---|
| `ws://localhost:3000/` | clangd for C/C++ |
| `ws://localhost:3000/java` | Eclipse JDT Language Server for Java |

---

## Project File Format

A project is a plain JavaScript/JSON object.

```json
{
  "id": "my-project",
  "name": "My Project",
  "files": [
    {
      "path": "Main.java",
      "content": "public class Main { }"
    },
    {
      "path": "Helper.java",
      "content": "public class Helper { }"
    }
  ],
  "activeFile": "Main.java"
}
```

Programmatic opening:

```js
await ed.openProject({
  id: "my-project",
  name: "My Project",
  files: [
    { path: "Main.java", content: "public class Main { }" },
    { path: "Helper.java", content: "public class Helper { }" }
  ],
  activeFile: "Main.java"
});
```

---

## Java Cross-File IntelliSense

For Java autocomplete between files, all related `.java` files must be visible to JDT LS.

Example structure:

```text
workspace/
  main/
    src/
      Main.java
      Helper.java
```

Recommended initialisation:

```js
var ed = smartCodeEditor.initEditor(
  "editorDiv",
  true,
  true,
  true,
  smartCodeEditor.editorMode.PROJECT,
  {
    folder: "main/src",
    syncRoot: "main",
    lsyncEnabled: true
  }
);
```

Example code:

```java
public class Main {
    public static void main(String[] args) {
        Helper helper = new Helper();
        helper.
    }
}
```

```java
public class Helper {
    public int add(int a, int b) {
        return a + b;
    }
}
```

At `helper.` the autocomplete should include `add`.

If you write `Helper.` instead of creating an object, Java will only show static methods.

---

## Configuration

Edit `js/config.js` to change server URLs and editor timings.

```js
const SmartCodeConfig = Object.freeze({
  server: {
    httpUrl: "http://localhost:3000",
    wsClangd: "ws://localhost:3000",
    wsJava: "ws://localhost:3000/java"
  },

  workspace: {
    rootUri: "file:///workspace"
  },

  editor: {
    completionDelay: 120,
    identifierDelay: 300,
    autosaveDelay: 1500,
    javaInitDelay: 1200,
    javaRetryDelay: 1500,
    memberMaxItems: 40,
    identifierMax: 20,
    javaMemberMax: 60
  }
});
```

---

## Recommended Folder Structure

```text
smartCodev3/
│
├── editor.html
│
├── js/
│   ├── config.js
│   ├── editorMain.js
│   └── smartCodeEditor.js
│
├── css/
│   └── editorStyle.css
│
├── img/
│   ├── smartCodeLogo.svg
│   └── smartCodeLogo2.svg
│
├── codemirror/
│
├── langserver/
│   ├── js/
│   │   ├── lspClient.js
│   │   └── server.js
│   ├── docker/
│   │   ├── Dockerfile
│   │   ├── start.sh
│   │   └── lsyncd.conf.lua
│   ├── package.json
│   └── package-lock.json
│
├── workspace/
│
└── algator-root/
```

`workspace/` is the LSP working directory. `algator-root/` is the synchronisation target.

---

## Requirements

| Component | Requirement |
|---|---|
| Browser | Chrome or Edge 86+ |
| Docker | 20.10+ |
| Java server | JDK 21 inside Docker |
| C/C++ server | clangd inside Docker |
| Server RAM | At least 2 GB recommended |
| Disk | Around 1 GB for the Docker image |

---

## Known Limitations

- The File System Access API is supported mainly in Chrome and Edge.
- C/C++ IntelliSense is best when `compile_commands.json` is available.
- Java cross-file autocomplete requires the related files to be in the LSP workspace and opened or scanned by the editor.
- If lsyncd is disabled, changes made outside the editor may not automatically propagate to `/algator-root`.
- Each page load starts a new browser-side editor session.

---

## License

MIT
