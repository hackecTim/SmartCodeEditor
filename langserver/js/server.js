import http from "node:http";
import { WebSocketServer } from "ws";
import { spawn } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const WORKSPACE     = "/workspace";
const JAVA_DATA_DIR = join(WORKSPACE, "java-data");
const SETTINGS_DIR  = join(WORKSPACE, ".settings");
const WORKSPACE_URI = pathToFileURL(WORKSPACE).href;

mkdirSync(WORKSPACE, { recursive: true });
mkdirSync(JAVA_DATA_DIR, { recursive: true });
mkdirSync(SETTINGS_DIR, { recursive: true });

bootstrapJavaProject();

function bootstrapJavaProject() {
  const projectFile = join(WORKSPACE, ".project");
  const classpathFile = join(WORKSPACE, ".classpath");
  const prefsFile = join(SETTINGS_DIR, "org.eclipse.jdt.core.prefs");

  if (!existsSync(projectFile)) {
    writeFileSync(
      projectFile,
      `<?xml version="1.0" encoding="UTF-8"?>
<projectDescription>
  <name>smartcode</name>
  <comment></comment>
  <projects></projects>
  <buildSpec>
    <buildCommand>
      <name>org.eclipse.jdt.core.javabuilder</name>
      <arguments></arguments>
    </buildCommand>
  </buildSpec>
  <natures>
    <nature>org.eclipse.jdt.core.javanature</nature>
  </natures>
</projectDescription>
`,
      "utf8"
    );
  }

  if (!existsSync(classpathFile)) {
    writeFileSync(
      classpathFile,
      `<?xml version="1.0" encoding="UTF-8"?>
<classpath>
  <classpathentry kind="src" path=""/>
  <classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/>
  <classpathentry kind="output" path="bin"/>
</classpath>
`,
      "utf8"
    );
  }

  if (!existsSync(prefsFile)) {
    writeFileSync(
      prefsFile,
      `eclipse.preferences.version=1
org.eclipse.jdt.core.compiler.codegen.targetPlatform=17
org.eclipse.jdt.core.compiler.compliance=17
org.eclipse.jdt.core.compiler.source=17
`,
      "utf8"
    );
  }

  mkdirSync(join(WORKSPACE, "bin"), { recursive: true });
}

function scanWorkspaceFiles() {
  return readdirSync(WORKSPACE)
    .filter(name => {
      const fp = join(WORKSPACE, name);
      try {
        return statSync(fp).isFile();
      } catch {
        return false;
      }
    })
    .filter(name => !name.startsWith("."))
    .sort();
}

function createLspProcess(name, getArgs, clients) {
  let proc        = null;
  let procReady   = false;
  let initialized = false;
  let initResult  = null;
  let buf         = Buffer.alloc(0);

  function broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(data);
    }
  }

  function sendRaw(obj) {
    if (!proc || !procReady) return;

    try {
      const json = JSON.stringify(obj);
      const body = Buffer.from(json, "utf8");
      const header = Buffer.from(
        `Content-Length: ${body.length}\r\n\r\n`,
        "ascii"
      );
      proc.stdin.write(Buffer.concat([header, body]));
    } catch (e) {
      if (e.code !== "EPIPE") {
        console.error(`[${name}] send error:`, e.message);
      }
    }
  }

  function handleClientMessage(ws, msg) {
    const method = msg.method;
    const id     = msg.id;

    if (method === "initialize") {
      if (initialized && initResult !== null) {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, result: initResult }));
        console.log(`[${name}] replayed initialize to reconnected client`);
      } else {
        sendRaw(msg);
      }
      return;
    }

    if (method === "initialized") {
      if (!initialized) sendRaw(msg);
      return;
    }

    sendRaw(msg);
  }

  function start() {
    let spawnArgs;
    try {
      spawnArgs = getArgs();
    } catch (e) {
      console.error(`[${name}] cannot get args: ${e.message} — retrying in 5s`);
      setTimeout(start, 5000);
      return;
    }

    const { cmd, args, opts } = spawnArgs;

    try {
      proc      = spawn(cmd, args, opts);
      procReady = true;
      buf       = Buffer.alloc(0);
    } catch (e) {
      console.error(`[${name}] spawn failed: ${e.message} — retrying in 5s`);
      setTimeout(start, 5000);
      return;
    }

    console.log(`[${name}] started (pid ${proc.pid})`);

    proc.stdout.on("data", chunk => {
      buf = Buffer.concat([buf, chunk]);

      while (true) {
        const sep = buf.indexOf("\r\n\r\n");
        if (sep === -1) break;

        const headerBuf = buf.slice(0, sep);
        const headerStr = headerBuf.toString("ascii");
        const match = headerStr.match(/Content-Length:\s*(\d+)/i);

        if (!match) {
          buf = buf.slice(sep + 4);
          continue;
        }

        const len = Number(match[1]);
        const bodyStart = sep + 4;
        const bodyEnd   = bodyStart + len;

        if (buf.length < bodyEnd) break;

        const bodyBuf = buf.slice(bodyStart, bodyEnd);
        buf = buf.slice(bodyEnd);

        try {
          const parsed = JSON.parse(bodyBuf.toString("utf8"));

          if (
            parsed.id !== undefined &&
            !initialized &&
            parsed.result !== undefined
          ) {
            initialized = true;
            initResult  = parsed.result;
            console.log(`[${name}] initialized successfully`);
          }

          broadcast(parsed);
        } catch (e) {
          console.error(`[${name}] bad JSON:`, e.message);
        }
      }
    });

    proc.stderr.on("data", c => {
      process.stderr.write(`[${name}] ${c}`);
    });

    proc.on("exit", (code, signal) => {
      procReady   = false;
      initialized = false;
      initResult  = null;
      console.log(`[${name}] exited (code=${code} signal=${signal}) — restarting in 2s`);
      setTimeout(start, 2000);
    });

    proc.stdin.on("error", e => {
      if (e.code !== "EPIPE") console.error(`[${name}] stdin:`, e.message);
    });
  }

  return {
    handleClientMessage,
    start,
    isReady: () => procReady
  };
}

//clangd
const clangdClients = new Set();
const clangd = createLspProcess("clangd", () => {
  const compileDb = join(WORKSPACE, "build", "compile_commands.json");
  const args = [
    "--background-index",
    "--clang-tidy",
    "--log=error",
    "--completion-style=detailed",
    "--header-insertion=never",
    "--ranking-model=decision_forest"
  ];

  if (existsSync(compileDb)) {
    args.push(`--compile-commands-dir=${join(WORKSPACE, "build")}`);
    console.log("[clangd] using compile_commands.json");
  }

  return {
    cmd: "clangd",
    args,
    opts: { cwd: WORKSPACE }
  };
}, clangdClients);

//jdtls
const javaClients = new Set();
const jdtls = createLspProcess("jdtls", () => {
  const pluginsDir = "/opt/jdtls/plugins";

  if (!existsSync(pluginsDir)) {
    throw new Error("jdtls not installed at /opt/jdtls");
  }

  const launcher = readdirSync(pluginsDir)
    .find(f => f.startsWith("org.eclipse.equinox.launcher_") && f.endsWith(".jar"));

  if (!launcher) {
    throw new Error("jdtls launcher jar not found in " + pluginsDir);
  }

  console.log("[jdtls] launcher:", launcher);

  return {
    cmd: "java",
    args: [
      "-Declipse.application=org.eclipse.jdt.ls.core.id1",
      "-Dosgi.bundles.defaultStartLevel=4",
      "-Declipse.product=org.eclipse.jdt.ls.core.product",
      "-Dlog.level=ALL",
      "-Dfile.encoding=UTF-8",
      "-Xms256m",
      "-Xmx1G",
      "--add-modules=ALL-SYSTEM",
      "--add-opens", "java.base/java.util=ALL-UNNAMED",
      "--add-opens", "java.base/java.lang=ALL-UNNAMED",
      "-jar", join(pluginsDir, launcher),
      "-configuration", "/opt/jdtls/config_linux",
      "-data", JAVA_DATA_DIR
    ],
    opts: { cwd: WORKSPACE }
  };
}, javaClients);

//HTTP
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const fileMatch = req.url?.match(/^\/workspace\/([^/]+)$/);

  if (req.method === "GET" && fileMatch) {
    const fp = join(WORKSPACE, fileMatch[1]);
    if (!existsSync(fp)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(readFileSync(fp, "utf8"));
    return;
  }

  if (req.method === "POST" && fileMatch) {
    const fp = join(WORKSPACE, fileMatch[1]);
    let body = "";

    req.setEncoding("utf8");
    req.on("data", c => { body += c; });
    req.on("end", () => {
      try {
        writeFileSync(fp, body, "utf8");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (req.method === "GET" && req.url === "/scan") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ files: scanWorkspaceFiles() }));
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      workspace: WORKSPACE,
      workspaceUri: WORKSPACE_URI,
      clangd: clangd.isReady(),
      jdtls: jdtls.isReady(),
      clangdClients: clangdClients.size,
      javaClients: javaClients.size,
      files: scanWorkspaceFiles()
    }));
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

//WebSocket routing
const wssClangd = new WebSocketServer({ noServer: true });
const wssJava   = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/java") {
    wssJava.handleUpgrade(req, socket, head, ws => wssJava.emit("connection", ws));
  } else {
    wssClangd.handleUpgrade(req, socket, head, ws => wssClangd.emit("connection", ws));
  }
});

function setupWss(wss, lspProc, clientSet, name) {
  wss.on("connection", ws => {
    clientSet.add(ws);
    console.log(`[${name}] browser connected (${clientSet.size} active)`);

    ws.on("message", raw => {
      try {
        const msg = JSON.parse(raw.toString());
        lspProc.handleClientMessage(ws, msg);
      } catch (e) {
        console.error(`[${name}] bad WS message:`, e.message);
      }
    });

    ws.on("close", () => {
      clientSet.delete(ws);
      console.log(`[${name}] browser disconnected (${clientSet.size} active)`);
    });

    ws.on("error", err => {
      clientSet.delete(ws);
      console.error(`[${name}] WS error:`, err.message);
    });
  });
}

setupWss(wssClangd, clangd, clangdClients, "clangd");
setupWss(wssJava,   jdtls,  javaClients,   "jdtls");

clangd.start();
jdtls.start();

server.listen(3000, () => {
  console.log("SmartCode server on http://localhost:3000");
  console.log("Workspace:", WORKSPACE);
  console.log("Workspace URI:", WORKSPACE_URI);
});