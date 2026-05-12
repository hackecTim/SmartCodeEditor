// ═══════════════════════════════════════════════════════════════════════
// smartCodeEditor.js  — vrstni red: config.js → lspClient.js → smartCodeEditor.js → editorMain.js
//
// MODE 1/2  (projekt / mapa):
//   var ed = smartCodeEditor.initEditor("editorDiv", true, true, true, 1);
//
// MODE 3  (vgrajen enodatotečni urejevalnik, brez zavihkov, brez autosave):
//   var ed = smartCodeEditor.initEditor("div", false, false, true, 3, {
//     language: "java",   // "java" | "c" | "cpp"
//     folder:   "mylib"   // relativna podmapa workspace za LSP kontekst (opcijsko)
//   });
//   ed.whenReady().then(() => {
//     ed.setContent("public class X { }", "java");
//     console.log(ed.getContent());
//   });
// ═══════════════════════════════════════════════════════════════════════

window.smartCodeEditor = (() => {

  const callbacks = { onChange: null, onSave: null, onFileOpen: null };
  let editorMainPatched = false;

  function hookIntoEditorMain() {
    if (editorMainPatched) return;
    editorMainPatched = true;

    const waitForCodeMirror = () => {
      if (typeof editor === "undefined" || !editor) {
        setTimeout(waitForCodeMirror, 100);
        return;
      }

      editor.on("change", (cm, ch) => {
        if (ch.origin === "setValue") return;

        if (callbacks.onChange) {
          try {
            callbacks.onChange(
              editor.getValue(),
              typeof activeFile !== "undefined" ? activeFile : null
            );
          } catch (e) {
            console.error("[smartCodeEditor] onChange:", e);
          }
        }
      });
    };

    waitForCodeMirror();

    if (typeof saveActiveFile === "function") {
      const originalSaveActiveFile = saveActiveFile;

      window.saveActiveFile = async function(silent) {
        await originalSaveActiveFile.call(this, silent);

        if (callbacks.onSave) {
          try {
            callbacks.onSave(
              typeof editor !== "undefined" && editor ? editor.getValue() : "",
              typeof activeFile !== "undefined" ? activeFile : null
            );
          } catch (e) {
            console.error("[smartCodeEditor] onSave:", e);
          }
        }
      };
    }

    if (typeof openFile === "function") {
      const originalOpenFile = openFile;

      window.openFile = async function(filename) {
        await originalOpenFile.call(this, filename);

        if (callbacks.onFileOpen) {
          try {
            callbacks.onFileOpen(
              filename,
              typeof modeForFile === "function" ? modeForFile(filename) : ""
            );
          } catch (e) {
            console.error("[smartCodeEditor] onFileOpen:", e);
          }
        }
      };
    }
  }

  class EditorAPI {
    constructor(
      divId,
      showToolbar = true,
      showTabStatusbar = true,
      showDiagnostics = true,
      editorMode = 1,
      options = {}
    ) {
      if (typeof editorMode === "object" && editorMode !== null) {
        options = editorMode;
        editorMode = options.mode ?? 1;
      }

      this.divId = divId;
      this.showToolbar = showToolbar !== false;
      this.showTabStatusbar = showTabStatusbar !== false;
      this.showDiagnostics = showDiagnostics !== false;
      this.mode = Number(editorMode) || 1;
      this.options = options || {};
      this.readyState = false;
      this.embeddedEditorInstance = null;

      if (this.mode === 3) {
        window.smartCodeInitialMode = 3;
        window.smartCodeShowDiagnostics = this.showDiagnostics;
        this.initEmbeddedEditorMode();
        return;
      }

      window.smartCodeShowDiagnostics = this.showDiagnostics;
      window.smartCodeInitialMode = this.mode;
      window.smartCodeInitialOptions = this.options;

      this.prepareDom();

      const mountEditor = async () => {
        if (typeof editor === "undefined" || !editor) {
          setTimeout(mountEditor, 100);
          return;
        }

        this.mount();
        this.readyState = true;
        hookIntoEditorMain();

        if (this.options.project) {
          await this.openProject(this.options.project);
        } else if (this.mode === 1) {
          await this.openWorkspaceProject();
        } else if (this.mode === 2) {
          this.showDirectoryPrompt();
        }
      };

      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => mountEditor());
      } else {
        mountEditor();
      }
    }

    initEmbeddedEditorMode() {
      const initEmbeddedEditor = async () => {
        if (typeof window.createEmbeddedEditor !== "function") {
          setTimeout(initEmbeddedEditor, 50);
          return;
        }

        const root = this.root();
        if (!root) return;

        root.style.display = "flex";
        root.style.flexDirection = "column";
        root.style.overflow = "hidden";

        if (!root.style.height) {
          root.style.height = "100%";
        }

        this.embeddedEditorInstance = window.createEmbeddedEditor(root, {
          language: this.options.language || "java",
          folder: this.options.folder || null,
          showDiagnostics: this.showDiagnostics
        });

        await this.embeddedEditorInstance.whenReady();
        this.readyState = true;

        if (this.pendingContent !== undefined) {
          this.embeddedEditorInstance.setContent(
            this.pendingContent ?? "",
            this.pendingLanguage
          );

          this.pendingContent = undefined;
          this.pendingLanguage = undefined;
        }
      };

      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => initEmbeddedEditor());
      } else {
        initEmbeddedEditor();
      }
    }

    root() {
      const root = document.getElementById(this.divId);

      if (!root) {
        console.error(`[smartCodeEditor] element #${this.divId} ne obstaja`);
      }

      return root;
    }

    prepareRoot(root) {
      root.classList.add("smartcode-root");

      if (!root.style.width) {
        root.style.width = "100%";
      }

      if (!root.style.height) {
        root.style.height = "100vh";
      }

      root.style.display = "flex";
      root.style.flexDirection = "column";
      root.style.overflow = "hidden";
      root.style.minHeight = "0";
    }

    createDom(root) {
      root.innerHTML = `
        <header class="topbar">
          <div class="title">SmartCode</div>
          <div class="controls">
            <button id="newFileBtn"     class="btn-secondary" type="button">New File</button>
            <button id="openBtn"        class="btn-secondary" type="button">Open Files</button>
            <button id="openFolderBtn"  class="btn-secondary" type="button">Open Project</button>
            <button id="demoProjectBtn" class="btn-secondary" type="button">Open Demo Project</button>
            <button id="saveBtn"        class="btn-primary"   type="button">Save</button>
            <input  id="fileInput" type="file" multiple hidden />
          </div>
        </header>

        <div id="tabBar" class="tab-bar"></div>

        <main class="editor-wrapper">
          <textarea id="editor"></textarea>
        </main>

        <section id="diagnosticsPanel" class="diagnostics-panel">
          <div class="diagnostics-header">
            <span class="diagnostics-title">Problems</span>
            <span id="diagnosticsCount" class="diagnostics-count">0 errors, 0 warnings</span>
          </div>
          <div id="diagnosticsList" class="diagnostics-list">
            <div class="diagnostics-empty">Ni zaznanih napak.</div>
          </div>
        </section>

        <footer class="statusbar">
          <span id="serverInfo">LSP: —</span>
          <span id="autosaveInfo" class="autosave-idle">Autosave: —</span>
          <span id="cursorInfo">Ln 1, Col 1</span>
        </footer>
      `;
    }

    existingEditorElements() {
      return [
        document.querySelector("header.topbar, .topbar"),
        document.getElementById("tabBar"),
        document.querySelector("main.editor-wrapper, .editor-wrapper"),
        document.getElementById("diagnosticsPanel"),
        document.querySelector("footer.statusbar, .statusbar")
      ].filter(Boolean);
    }

    prepareDom() {
      const root = this.root();
      if (!root) return;

      this.prepareRoot(root);

      if (!document.getElementById("editor")) {
        this.createDom(root);
      } else {
        for (const el of this.existingEditorElements()) {
          if (el.parentElement !== root) {
            root.appendChild(el);
          }
        }
      }

      this.applyVisibility();
    }

    mount() {
      const root = this.root();
      if (!root) return;

      this.prepareRoot(root);
      this.applyVisibility();

      setTimeout(() => editor?.refresh(), 50);
      setTimeout(() => editor?.refresh(), 250);
    }

    showDirectoryPrompt() {
      const root = this.root();

      if (!root || document.getElementById("smartcodeDirectoryPrompt")) {
        return;
      }

      const box = document.createElement("div");
      box.id = "smartcodeDirectoryPrompt";
      box.style.cssText = "position:absolute;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;background:rgba(248,250,252,.86);backdrop-filter:blur(3px);";
      box.innerHTML = `
        <div style="background:#fff;border:1px solid #dbe3ef;border-radius:16px;box-shadow:0 18px 50px rgba(15,23,42,.14);padding:24px;max-width:460px;text-align:center;font-family:system-ui,-apple-system,Segoe UI,sans-serif;">
          <div style="font-size:18px;font-weight:700;margin-bottom:8px;">Open project directory</div>
          <div style="font-size:14px;color:#475569;margin-bottom:18px;line-height:1.45;">
            Način 2 odpre direktorij kot projekt. Vse .java, .c, .cpp, .h, .hpp datoteke iz izbrane mape in podmap se odprejo v zavihkih in sinhronizirajo z LSP.
          </div>
          <button id="smartcodeDirectoryPromptBtn" type="button" style="border:0;border-radius:10px;padding:10px 16px;background:#2563eb;color:white;font-weight:700;cursor:pointer;">Izberi direktorij</button>
        </div>
      `;

      const oldPosition = root.style.position;
      if (!oldPosition || oldPosition === "static") {
        root.style.position = "relative";
      }

      root.appendChild(box);

      document.getElementById("smartcodeDirectoryPromptBtn")?.addEventListener("click", async () => {
        try {
          await this.openDirectoryProject();
          box.remove();
        } catch (e) {
          console.warn("[smartCodeEditor] open directory failed:", e.message);
        }
      });
    }

    applyVisibility() {
      const toolbar = document.querySelector("header.topbar, .topbar");
      const tabbar = document.getElementById("tabBar");
      const status = document.querySelector("footer.statusbar, .statusbar");
      const diagnosticsPanel = document.getElementById("diagnosticsPanel");

      if (toolbar) {
        toolbar.style.display = this.showToolbar ? "" : "none";
      }

      if (tabbar) {
        tabbar.style.display = this.showTabStatusbar ? "" : "none";
      }

      if (status) {
        status.style.display = this.showTabStatusbar ? "" : "none";
      }

      if (diagnosticsPanel) {
        diagnosticsPanel.style.display =
          this.showDiagnostics && diagnosticsPanel.classList.contains("has-problems")
            ? ""
            : "none";
      }

      window.smartCodeShowDiagnostics = this.showDiagnostics;

      if (typeof editor !== "undefined" && editor) {
        editor.setOption(
          "gutters",
          this.showDiagnostics
            ? ["CodeMirror-linenumbers", "lsp-diagnostics-gutter"]
            : ["CodeMirror-linenumbers"]
        );

        if (!this.showDiagnostics && typeof clearDiagnostics === "function") {
          clearDiagnostics();
        }

        if (this.showDiagnostics && typeof renderDiagnostics === "function") {
          const uri =
            typeof activeFile !== "undefined" &&
            typeof fileStates !== "undefined"
              ? fileStates.get(activeFile)?.uri
              : null;

          const list =
            uri && typeof diagnosticsByFile !== "undefined"
              ? diagnosticsByFile.get(uri) || []
              : [];

          renderDiagnostics(list, uri);
        }

        editor.refresh();
      }
    }

    async openProject(project) {
      if (this.mode === 3) {
        console.warn("[smartCodeEditor] openProject ni na voljo v mode 3");
        return;
      }

      if (typeof window.openSmartCodeProject !== "function") {
        console.warn("[smartCodeEditor] openSmartCodeProject še ni pripravljen");
        return;
      }

      await window.openSmartCodeProject(project);
    }

    async openDemoProject() {
      if (this.mode !== 3) {
        document.getElementById("demoProjectBtn")?.click();
      }
    }

    async openDirectoryProject() {
      if (this.mode === 3) return;

      if (typeof window.openSmartCodeFolderProject === "function") {
        await window.openSmartCodeFolderProject();
        return;
      }

      document.getElementById("openFolderBtn")?.click();
    }

    async openWorkspaceProject() {
      if (this.mode === 3) return;

      if (typeof window.openSmartCodeWorkspaceProject === "function") {
        await window.openSmartCodeWorkspaceProject();
        return;
      }

      console.warn("[smartCodeEditor] openSmartCodeWorkspaceProject še ni pripravljen");
    }

    getProjectInfo() {
      if (this.mode === 3) return null;

      return typeof window.getSmartCodeProjectInfo === "function"
        ? window.getSmartCodeProjectInfo()
        : null;
    }

    setContent(code, language) {
      if (this.mode === 3) {
        if (!this.embeddedEditorInstance) {
          this.pendingContent = code;
          this.pendingLanguage = language;
          return;
        }

        this.embeddedEditorInstance.setContent(code, language);
        return;
      }

      if (typeof editor === "undefined" || !editor) {
        console.warn("[smartCodeEditor] editor še ni pripravljen");
        return;
      }

      if (language) {
        const project = {
          id: `external-${Date.now()}`,
          name: "External content",
          source: "api",
          persist: false,
          files: [
            {
              path: language,
              content: code ?? ""
            }
          ],
          activeFile: language
        };

        if (typeof window.openSmartCodeProject === "function") {
          window.openSmartCodeProject(project);
        }

        return;
      }

      const prev = typeof isFileSwitch !== "undefined" ? isFileSwitch : false;

      try {
        if (typeof isFileSwitch !== "undefined") {
          isFileSwitch = true;
        }
      } catch {}

      editor.setValue(code ?? "");

      try {
        if (typeof isFileSwitch !== "undefined") {
          isFileSwitch = prev;
        }
      } catch {}
    }

    getContent() {
      if (this.mode === 3) {
        return this.embeddedEditorInstance ? this.embeddedEditorInstance.getContent() : "";
      }

      if (typeof editor === "undefined" || !editor) {
        return "";
      }

      return editor.getValue();
    }

    setLanguage(lang) {
      if (this.mode === 3) {
        this.embeddedEditorInstance?.setLanguage(lang);
        return;
      }

      if (typeof editor === "undefined" || !editor) return;

      const modes = {
        java: "text/x-java",
        c: "text/x-csrc",
        cpp: "text/x-c++src",
        "c++": "text/x-c++src"
      };

      const mode = modes[lang];

      if (!mode) {
        console.warn(`[smartCodeEditor] neznan jezik: ${lang}`);
        return;
      }

      editor.setOption("mode", mode);
      editor.setOption("theme", "eclipse");

      if (typeof updateEditorLanguageClass === "function") {
        updateEditorLanguageClass(mode);
      }

      editor.refresh();
    }

    getLanguage() {
      if (this.mode === 3) {
        return this.embeddedEditorInstance ? this.embeddedEditorInstance.language : "java";
      }

      if (typeof editor === "undefined" || !editor) {
        return "plain";
      }

      return ({
        "text/x-java": "java",
        "text/x-csrc": "c",
        "text/x-c++src": "cpp"
      })[editor.getOption("mode")] || "plain";
    }

    async openFile(filename) {
      if (this.mode !== 3 && typeof openFile === "function") {
        await openFile(filename);
      }
    }

    async save() {
      if (this.mode !== 3 && typeof saveActiveFile === "function") {
        await saveActiveFile(false);
      }
    }

    setReadOnly(val) {
      if (this.mode === 3) {
        this.embeddedEditorInstance?.setReadOnly(val);
        return;
      }

      if (typeof editor !== "undefined" && editor) {
        editor.setOption("readOnly", !!val);
      }
    }

    focus() {
      if (this.mode === 3) {
        this.embeddedEditorInstance?.focus();
        return;
      }

      if (typeof editor !== "undefined" && editor) {
        editor.focus();
      }
    }

    setDiagnosticsVisible(v) {
      this.showDiagnostics = v !== false;

      if (this.mode === 3) {
        this.embeddedEditorInstance?.setDiagnosticsVisible(v);
        return;
      }

      this.applyVisibility();
    }

    setUIVisible(v) {
      if (this.mode !== 3) {
        this.showToolbar = v !== false;
        this.showTabStatusbar = v !== false;
        this.applyVisibility();
      }
    }

    setToolbarVisible(v) {
      if (this.mode !== 3) {
        this.showToolbar = v !== false;
        this.applyVisibility();
      }
    }

    setTabStatusbarVisible(v) {
      if (this.mode !== 3) {
        this.showTabStatusbar = v !== false;
        this.applyVisibility();
      }
    }

    onChange(fn) {
      callbacks.onChange = typeof fn === "function" ? fn : null;
    }

    onSave(fn) {
      callbacks.onSave = typeof fn === "function" ? fn : null;
    }

    onFileOpen(fn) {
      callbacks.onFileOpen = typeof fn === "function" ? fn : null;
    }

    get cm() {
      return this.mode === 3
        ? (this.embeddedEditorInstance?.cm ?? null)
        : (typeof editor !== "undefined" ? editor : null);
    }

    get activeFile() {
      return this.mode === 3
        ? null
        : (typeof activeFile !== "undefined" ? activeFile : null);
    }

    get ready() {
      return this.readyState;
    }

    whenReady() {
      return new Promise(resolve => {
        const check = () => {
          if (this.readyState) {
            resolve(this);
          } else {
            setTimeout(check, 50);
          }
        };

        check();
      });
    }

    destroy() {
      callbacks.onChange = null;
      callbacks.onSave = null;
      callbacks.onFileOpen = null;

      if (this.mode === 3) {
        this.embeddedEditorInstance?.destroy();
      }
    }
  }

  return {
    initEditor(
      divId,
      showToolbar = true,
      showTabStatusbar = true,
      showDiagnostics = true,
      editorMode = 1,
      options = {}
    ) {
      return new EditorAPI(
        divId,
        showToolbar,
        showTabStatusbar,
        showDiagnostics,
        editorMode,
        options
      );
    }
  };

})();
