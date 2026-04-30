window.smartCodeEditor = (() => {

  const _cbs = {
    onChange: null,
    onSave: null,
    onFileOpen: null
  };

  let _patched = false;

  function _hookIntoEditorMain() {
    if (_patched) return;
    _patched = true;

    const waitCM = () => {
      if (typeof editor === "undefined" || !editor) {
        setTimeout(waitCM, 100);
        return;
      }

      editor.on("change", (_cm, ch) => {
        if (ch.origin === "setValue") return;

        if (_cbs.onChange) {
          try {
            _cbs.onChange(
              editor.getValue(),
              typeof activeFile !== "undefined" ? activeFile : null
            );
          } catch (e) {
            console.error("[smartCodeEditor] onChange:", e);
          }
        }
      });
    };

    waitCM();

    if (typeof saveActiveFile === "function") {
      const _origSave = saveActiveFile;

      window.saveActiveFile = async function(silent) {
        await _origSave.call(this, silent);

        if (_cbs.onSave) {
          try {
            _cbs.onSave(
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
      const _origOpen = openFile;

      window.openFile = async function(filename) {
        await _origOpen.call(this, filename);

        if (_cbs.onFileOpen) {
          try {
            _cbs.onFileOpen(
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
      showDiagnostics = true
    ) {
      this._divId = divId;
      this._showToolbar = showToolbar !== false;
      this._showTabStatusbar = showTabStatusbar !== false;
      this._showDiagnostics = showDiagnostics !== false;
      this._ready = false;

      window.smartCodeShowDiagnostics = this._showDiagnostics;

      this._prepareDom();

      const doMount = () => {
        if (typeof editor === "undefined" || !editor) {
          setTimeout(doMount, 100);
          return;
        }

        this._mount();
        this._ready = true;
        _hookIntoEditorMain();
      };

      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => doMount());
      } else {
        doMount();
      }
    }

    _root() {
      const root = document.getElementById(this._divId);

      if (!root) {
        console.error(`[smartCodeEditor] element #${this._divId} ne obstaja`);
      }

      return root;
    }

    _prepareRoot(root) {
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

    _createDom(root) {
      root.innerHTML = `
        <header class="topbar">
          <div class="title">SmartCode</div>

          <div class="controls">
            <button id="newFileBtn" class="btn-secondary" type="button">New File</button>
            <button id="openBtn" class="btn-secondary" type="button">Open Files</button>
            <button id="openFolderBtn" class="btn-secondary" type="button">Open Folder</button>
            <button id="saveBtn" class="btn-primary" type="button">Save</button>
            <input id="fileInput" type="file" multiple hidden />
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

    _existingEditorElements() {
      return [
        document.querySelector("header.topbar, .topbar"),
        document.getElementById("tabBar"),
        document.querySelector("main.editor-wrapper, .editor-wrapper"),
        document.getElementById("diagnosticsPanel"),
        document.querySelector("footer.statusbar, .statusbar")
      ].filter(Boolean);
    }

    _prepareDom() {
      const root = this._root();
      if (!root) return;

      this._prepareRoot(root);

      if (!document.getElementById("editor")) {
        this._createDom(root);
      } else {
        for (const el of this._existingEditorElements()) {
          if (el.parentElement !== root) {
            root.appendChild(el);
          }
        }
      }

      this._applyVisibility();
    }

    _mount() {
      const root = this._root();
      if (!root) return;

      this._prepareRoot(root);
      this._applyVisibility();

      setTimeout(() => {
        if (typeof editor !== "undefined" && editor) {
          editor.refresh();
        }
      }, 50);

      setTimeout(() => {
        if (typeof editor !== "undefined" && editor) {
          editor.refresh();
        }
      }, 250);
    }

    _applyVisibility() {
      const toolbar = document.querySelector("header.topbar, .topbar");
      const tabbar = document.getElementById("tabBar");
      const status = document.querySelector("footer.statusbar, .statusbar");
      const diag = document.getElementById("diagnosticsPanel");

      // Toolbar 
      if (toolbar) {
        toolbar.style.display = this._showToolbar ? "" : "none";
      }

      // Tabbar + statusbar 
      if (tabbar) {
        tabbar.style.display = this._showTabStatusbar ? "" : "none";
      }

      if (status) {
        status.style.display = this._showTabStatusbar ? "" : "none";
      }

      //Diagnostika 
      if (diag) {
        diag.style.display = this._showDiagnostics ? "" : "none";
      }

      window.smartCodeShowDiagnostics = this._showDiagnostics;

      if (typeof editor !== "undefined" && editor) {
        editor.setOption(
          "gutters",
          this._showDiagnostics
            ? ["CodeMirror-linenumbers", "lsp-diagnostics-gutter"]
            : ["CodeMirror-linenumbers"]
        );

        if (!this._showDiagnostics && typeof clearDiagnostics === "function") {
          clearDiagnostics();
        }

        if (this._showDiagnostics && typeof renderDiagnostics === "function") {
          const uri =
            typeof activeFile !== "undefined" &&
            typeof fileStates !== "undefined"
              ? fileStates.get(activeFile)?.uri
              : null;

          const list =
            uri &&
            typeof diagnosticsByFile !== "undefined"
              ? diagnosticsByFile.get(uri) || []
              : [];

          renderDiagnostics(list, uri);
        }

        editor.refresh();
      }
    }

    setContent(code, filename) {
      if (typeof editor === "undefined" || !editor) {
        console.warn("[smartCodeEditor] editor še ni pripravljen");
        return;
      }

      if (filename) {
        if (typeof fileStates !== "undefined") {
          if (!fileStates.has(filename)) {
            if (typeof ensureFileState === "function") {
              ensureFileState(filename);
            } else {
              fileStates.set(filename, {
                uri:
                  typeof uriForFile === "function"
                    ? uriForFile(filename)
                    : `file:///workspace/${filename}`,
                languageId: _langId(filename),
                version: 1,
                content: null,
                dirty: false
              });
            }
          }

          fileStates.get(filename).content = code ?? "";
        }

        if (typeof openFile === "function") {
          openFile(filename);
        }
      } else {
        const prev =
          typeof isFileSwitch !== "undefined"
            ? isFileSwitch
            : false;

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
    }

    getContent() {
      if (typeof editor === "undefined" || !editor) {
        return "";
      }

      return editor.getValue();
    }

    setLanguage(lang) {
      if (typeof editor === "undefined" || !editor) return;

      const modes = {
        java: "text/x-java",
        c: "text/x-csrc",
        cpp: "text/x-c++src",
        "c++": "text/x-c++src"
      };

      const themes = {
        "text/x-java": "eclipse",
        "text/x-csrc": "eclipse",
        "text/x-c++src": "eclipse"
      };

      const mode = modes[lang];

      if (!mode) {
        console.warn(`[smartCodeEditor] neznan jezik: ${lang}`);
        return;
      }

      editor.setOption("mode", mode);
      editor.setOption("theme", themes[mode] || "eclipse");

      if (typeof updateEditorLanguageClass === "function") {
        updateEditorLanguageClass(mode);
      }

      editor.refresh();
    }

    getLanguage() {
      if (typeof editor === "undefined" || !editor) {
        return "plain";
      }

      const rev = {
        "text/x-java": "java",
        "text/x-csrc": "c",
        "text/x-c++src": "cpp"
      };

      return rev[editor.getOption("mode")] || "plain";
    }

    async openFile(filename) {
      if (typeof openFile === "function") {
        await openFile(filename);
      }
    }

    async save() {
      if (typeof saveActiveFile === "function") {
        await saveActiveFile(false);
      }
    }

    setReadOnly(val) {
      if (typeof editor !== "undefined" && editor) {
        editor.setOption("readOnly", !!val);
      }
    }

    focus() {
      if (typeof editor !== "undefined" && editor) {
        editor.focus();
      }
    }

    setUIVisible(val) {
      const visible = val !== false;
      this._showToolbar = visible;
      this._showTabStatusbar = visible;
      this._applyVisibility();
    }

    setToolbarVisible(val) {
      this._showToolbar = val !== false;
      this._applyVisibility();
    }

    setTabStatusbarVisible(val) {
      this._showTabStatusbar = val !== false;
      this._applyVisibility();
    }

    setDiagnosticsVisible(val) {
      this._showDiagnostics = val !== false;
      this._applyVisibility();
    }

    onChange(fn) {
      _cbs.onChange = typeof fn === "function" ? fn : null;
    }

    onSave(fn) {
      _cbs.onSave = typeof fn === "function" ? fn : null;
    }

    onFileOpen(fn) {
      _cbs.onFileOpen = typeof fn === "function" ? fn : null;
    }

    get cm() {
      return typeof editor !== "undefined" ? editor : null;
    }

    get activeFile() {
      return typeof activeFile !== "undefined" ? activeFile : null;
    }

    get ready() {
      return this._ready;
    }

    whenReady() {
      return new Promise(resolve => {
        const check = () => {
          if (this._ready) {
            resolve(this);
          } else {
            setTimeout(check, 50);
          }
        };

        check();
      });
    }

    destroy() {
      _cbs.onChange = null;
      _cbs.onSave = null;
      _cbs.onFileOpen = null;
    }
  }

  function _langId(filename) {
    const f = (filename || "").toLowerCase();

    if (f.endsWith(".java")) {
      return "java";
    }

    if (f.endsWith(".c")) {
      return "c";
    }

    if (
      f.endsWith(".cpp") ||
      f.endsWith(".cc") ||
      f.endsWith(".cxx") ||
      f.endsWith(".h") ||
      f.endsWith(".hpp") ||
      f.endsWith(".hxx")
    ) {
      return "cpp";
    }

    return "plaintext";
  }

  return {
    initEditor(
      divId,
      showToolbar = true,
      showTabStatusbar = true,
      showDiagnostics = true
    ) {
      return new EditorAPI(
        divId,
        showToolbar,
        showTabStatusbar,
        showDiagnostics
      );
    }
  };

})();