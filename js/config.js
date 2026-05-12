const SmartCodeConfig = {

  server: {
    httpUrl:  "http://localhost:3000",
    wsClangd: "ws://localhost:3000/",
    wsJava:   "ws://localhost:3000/java"
  },

  workspace: {
    // LSP root URI — mora se ujemati s potjo v Dockerju
    rootUri: "file:///workspace"
  },

  editor: {
    autosaveDelay:   700,
    completionDelay: 60,
    identifierDelay: 80,
    javaInitDelay:   1200,
    javaRetryDelay:  2000,
    memberMaxItems:  40,
    javaMemberMax:   60,
    identifierMax:   50
  }
};

Object.freeze(SmartCodeConfig.server);
Object.freeze(SmartCodeConfig.workspace);
Object.freeze(SmartCodeConfig.editor);
Object.freeze(SmartCodeConfig);
