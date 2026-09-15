# SmartCode Editor

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Java](https://img.shields.io/badge/Java-JDK%2021-orange.svg)
![C/C++](https://img.shields.io/badge/C%2FC%2B%2B-clangd-blue.svg)
![CodeMirror](https://img.shields.io/badge/editor-CodeMirror%205-purple.svg)
![Docker](https://img.shields.io/badge/Docker-supported-blue.svg)

SmartCode is a browser-based code editor with **IntelliSense support** powered by the Language Server Protocol (LSP).

It supports:

- **Java** with Eclipse JDT Language Server
- **C/C++** with clangd
- Autocomplete
- Diagnostics
- Hover information
- Signature help
- Cross-file project context
- Integration into existing web applications

---

## Usage Modes

SmartCode provides three usage modes:

| Mode | Description |
|---|---|
| `SINGLE` | Embedded editor for integration into another web application |
| `PROJECT` | Full project editor with tabs, toolbar and project handling |
| `FOLDER` | Folder-based editor using the browser directory picker |

> **For integration into an existing web application, `SINGLE` mode is recommended.**

---

## SINGLE Mode – Integration

The `SINGLE` mode allows SmartCode to be embedded inside an existing web application.

The host application can keep its own navigation, project structure and interface, while SmartCode provides the code editor and IntelliSense functionality.

```text
Web Application
      │
      ▼
SmartCode Editor
      │
      │ HTTP / WebSocket
      ▼
LSP Bridge
   ┌──┴──┐
   ▼     ▼
 JDT LS  clangd
 Java    C/C++
```

### Example

```js
const editor = smartCodeEditor.initEditor(
  "editorDiv",

  false, // toolbar
  false, // tabs and status bar
  true,  // diagnostics

  smartCodeEditor.editorMode.SINGLE,

  {
    language: "java",
    folder: "main/src",
    syncRoot: "main",
    savePath: "main/src/Main.java",
    lsyncEnabled: true
  }
);
```

Wait until the editor is ready:

```js
editor.whenReady().then(() => {
  editor.setContent(
    "public class Main {\n" +
    "    public static void main(String[] args) {\n" +
    "    }\n" +
    "}",
    "java"
  );
});
```

### Important options

| Option | Description |
|---|---|
| `language` | Programming language: `java`, `c` or `cpp` |
| `folder` | Folder used as LSP project context |
| `savePath` | Exact file represented by the editor |
| `syncRoot` | Folder synchronised by lsyncd |
| `lsyncEnabled` | Enables or disables synchronisation |

Example:

```js
{
  language: "java",
  folder: "main/src",
  syncRoot: "main",
  savePath: "main/src/Main.java",
  lsyncEnabled: true
}
```

This configuration means:

```text
LSP context:
  /workspace/main/src

Current file:
  /workspace/main/src/Main.java

Synchronisation:
  /workspace/main
        ↓
  /target-root/main
```

---

## Changing Files

```js
editor.setSavePath("main/src/Input.java");
editor.setContent(inputCode, "java");
```

Then another file:

```js
editor.setSavePath("main/src/Output.java");
editor.setContent(outputCode, "java");
```

---

## Reading Editor Content

```js
const code = editor.getContent();
```

Listen for changes:

```js
editor.onChange((content, filename) => {
  console.log(filename);
  console.log(content);
});
```

---

## Java Project Context

For Java IntelliSense between multiple files, related `.java` files must be available inside the LSP workspace.

```text
workspace/
└── main/
    └── src/
        ├── Main.java
        ├── Input.java
        └── Output.java
```

Use:

```js
folder: "main/src"
```

The Java language server can then use `Input.java` and `Output.java` while the user is editing `Main.java`.

For Java, the public class name should also match the file name.

For example:

```java
public class Input {
}
```

should use:

```js
savePath: "main/src/Input.java"
```

---

## Architecture

```text
Browser
  │
  ├── CodeMirror 5
  ├── SmartCode
  │
  ▼
WebSocket / HTTP
  │
  ▼
LSP Bridge
  │
  ├── Eclipse JDT Language Server
  ├── clangd
  ├── /workspace
  │
  └── lsyncd
        │
        ▼
   /target-root
```

---

## Docker

Build the LSP server:

```bash
docker build -f langserver/docker/Dockerfile -t smartcode-lsp langserver/
```

Run it:

```bash
docker run --rm -it \
  -p 3000:3000 \
  -v "$PWD/workspace:/workspace" \
  -v "$PWD/target-root:/target-root" \
  smartcode-lsp
```

The language servers are then available at:

```text
Java:
ws://localhost:3000/java

C/C++:
ws://localhost:3000/
```

---

## License

MIT
