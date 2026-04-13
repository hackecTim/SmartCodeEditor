const SmartCodeConfig = {

  server: {
    host:      "localhost",
    port:      3000,

    // HTTP base URL za save/load datotek
    get httpUrl() {
      return `http://${this.host}:${this.port}`;
    },

    // WebSocket za clangd (C / C++)
    get wsClangd() {
      return `ws://${this.host}:${this.port}/`;
    },

    // WebSocket za jdtls (Java)
    get wsJava() {
      return `ws://${this.host}:${this.port}/java`;
    }
  },

  workspace: {
    rootUri: "file:///workspace",
    // Datoteke po jeziku
    files: {
      "text/x-java":   "Main.java",
      "text/x-csrc":   "main.c",
      "text/x-c++src": "main.cpp"
    }
  },

  editor: {
    autosaveDelay:    800,    // ms po zadnjem keystroke
    completionDelay:  80,     // ms za . -> ::
    identifierDelay:  150,    // ms za navadno tipkanje
    javaMinPrefix:    2,      // min znaki za Java identifier completion
    clangdMinPrefix:  1,      // min znaki za C/C++ identifier completion
    memberMaxItems:   20,     // max zadetkov za member access (clangd)
    javaMemberMax:    15,     // max zadetkov za member access (jdtls)
    identifierMax:    12,     // max zadetkov za identifier typing
    javaRetryDelay:   3000,   // ms med jdtls retry poskusi
    javaInitDelay:    1500    // ms čakanja pred jdtls initialize
  }
};

//Preprečitev naključne spremembe
Object.freeze(SmartCodeConfig.server);
Object.freeze(SmartCodeConfig.workspace.files);
Object.freeze(SmartCodeConfig.workspace);
Object.freeze(SmartCodeConfig.editor);
Object.freeze(SmartCodeConfig);
