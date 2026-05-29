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
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const TARGET_ROOT = process.env.SYNC_TARGET_ROOT || "/target-root";
const WORKSPACE = process.env.LSP_WORKSPACE || "/workspace";

function normalizePath(p) {
  return String(p || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
}


function normalizeSyncRoot(root = "") {
  const rel = normalizePath(root)
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");

  if (rel.includes("..")) return "";
  return rel;
}

function readRequestBody(req) {
  return new Promise(resolve => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => resolve(body));
  });
}

let activeSyncRoot = "";
let lsyncEnabled = false;
let lsyncdProcess = null;

function syncSourcePath() {
  return activeSyncRoot ? join(WORKSPACE, activeSyncRoot) : WORKSPACE;
}

function syncTargetPath() {
  return activeSyncRoot ? join(TARGET_ROOT, activeSyncRoot) : TARGET_ROOT;
}

function syncTargetSourcePath() {
  return activeSyncRoot ? join(TARGET_ROOT, activeSyncRoot) : TARGET_ROOT;
}

function syncWorkspaceTargetPath() {
  return activeSyncRoot ? join(WORKSPACE, activeSyncRoot) : WORKSPACE;
}

function makeLsyncdConfig(workspaceSource, targetTarget, targetSource, workspaceTarget) {
  return `settings {
  nodaemon = true,
  statusFile = "/tmp/lsyncd.status",
  statusInterval = 5,
  logfile = "/tmp/lsyncd.log",
  inotifyMode = "CloseWrite or Modify"
}

sync {
  default.rsync,
  source = ${JSON.stringify(targetSource)},
  target = ${JSON.stringify(workspaceTarget)},
  delay = 0.5,
  rsync = {
    archive = true,
    compress = false,
    whole_file = false,
    _extra = {
      "--include=*.java",
      "--include=*.jar",
      "--include=*.c",
      "--include=*.cpp",
      "--include=*.cc",
      "--include=*.cxx",
      "--include=*.h",
      "--include=*.hpp",
      "--include=*/",
      "--exclude=*",
      "--prune-empty-dirs"
    }
  }
}

sync {
  default.rsync,
  source = ${JSON.stringify(workspaceSource)},
  target = ${JSON.stringify(targetTarget)},
  delay = 0.5,
  rsync = {
    archive = true,
    compress = false,
    whole_file = false,
    _extra = {
      "--exclude=java-data/",
      "--exclude=.settings/",
      "--exclude=build/",
      "--exclude=bin/",
      "--exclude=.metadata/",
      "--exclude=*.class",
      "--include=*.java",
      "--include=*.c",
      "--include=*.cpp",
      "--include=*.cc",
      "--include=*.cxx",
      "--include=*.h",
      "--include=*.hpp",
      "--include=*/",
      "--exclude=*",
      "--prune-empty-dirs"
    }
  }
}
`;
}

function stopLsyncd() {
  if (!lsyncdProcess) return;

  try {
    lsyncdProcess.kill("SIGTERM");
  } catch {}

  lsyncdProcess = null;
}

function startLsyncdForRoot(syncRoot = activeSyncRoot) {
  activeSyncRoot = normalizeSyncRoot(syncRoot);

  stopLsyncd();

  if (!lsyncEnabled) {
    console.log(`[sync] lsyncd disabled, syncRoot=${activeSyncRoot || "/"}`);
    return false;
  }

  const workspaceSource = syncSourcePath();
  const targetTarget = syncTargetPath();
  const targetSource = syncTargetSourcePath();
  const workspaceTarget = syncWorkspaceTargetPath();

  mkdirSync(workspaceSource, { recursive: true });
  mkdirSync(targetTarget, { recursive: true });
  mkdirSync(targetSource, { recursive: true });
  mkdirSync(workspaceTarget, { recursive: true });

  const configPath = "/tmp/lsyncd-active.conf.lua";
  writeFileSync(
    configPath,
    makeLsyncdConfig(workspaceSource, targetTarget, targetSource, workspaceTarget),
    "utf8"
  );

  lsyncdProcess = spawn("lsyncd", [configPath], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  lsyncdProcess.stdout.on("data", chunk => {
    process.stdout.write(`[lsyncd] ${chunk}`);
  });

  lsyncdProcess.stderr.on("data", chunk => {
    process.stderr.write(`[lsyncd] ${chunk}`);
  });

  lsyncdProcess.on("error", error => {
    console.warn(`[sync] lsyncd error: ${error.message}`);
    lsyncdProcess = null;
  });

  lsyncdProcess.on("exit", (code, signal) => {
    console.log(`[lsyncd] exited code=${code} signal=${signal}`);
    lsyncdProcess = null;
  });

  console.log(`[sync] lsyncd workspace -> target: ${workspaceSource} -> ${targetTarget}`);
  console.log(`[sync] lsyncd target -> workspace: ${targetSource} -> ${workspaceTarget}`);
  return true;
}

function setSyncRoot(syncRoot = "", enabled = false) {
  activeSyncRoot = normalizeSyncRoot(syncRoot);
  lsyncEnabled = enabled === true;
  return startLsyncdForRoot(activeSyncRoot);
}
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

// Rekurzivno skenira workspace (ali podmapa folder) in vrne relativne poti od WORKSPACE.
function scanWorkspaceFiles(folder = "") {
  const root = folder ? join(WORKSPACE, folder) : WORKSPACE;
  const results = [];
  function walk(dir, rel) {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const abs     = join(dir, name);
      const relPath = rel ? rel + "/" + name : name;
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) walk(abs, relPath);
      else if (st.isFile()) results.push(relPath);
    }
  }
  walk(root, folder);
  return results.sort();
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
      "-Dlog.level=ERROR",          // bilo ALL — zdaj samo napake
      "-Dfile.encoding=UTF-8",
      "-Xms256m",
      "-Xmx1G",
      "-XX:+UseG1GC",               // G1GC je privzet na Java 21, eksplicitno za jasnost
      "--add-modules=ALL-SYSTEM",   // na Java 21 ne povzroča več incubator opozoril
      "--add-opens", "java.base/java.util=ALL-UNNAMED",
      "--add-opens", "java.base/java.lang=ALL-UNNAMED",
      "--add-opens", "java.base/sun.nio.ch=ALL-UNNAMED",
      "-jar", join(pluginsDir, launcher),
      "-configuration", "/opt/jdtls/config_linux",
      "-data", JAVA_DATA_DIR
    ],
    opts: { cwd: WORKSPACE }
  };
}, javaClients);

//HTTP
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "POST" && req.url === "/sync-root") {
    try {
      const body = await readRequestBody(req);
      const data = JSON.parse(body || "{}");

      const nextRoot = Object.prototype.hasOwnProperty.call(data, "syncRoot")
        ? data.syncRoot
        : (data.folder || "");

      const nextEnabled = data.lsyncEnabled === true;
      const started = setSyncRoot(nextRoot, nextEnabled);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        syncRoot: activeSyncRoot,
        lsyncEnabled,
        lsyncd: !!lsyncdProcess,
        lsyncdStarted: started,
        workspaceToTarget: {
          source: syncSourcePath(),
          target: syncTargetPath()
        },
        targetToWorkspace: {
          source: syncTargetSourcePath(),
          target: syncWorkspaceTargetPath()
        }
      }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // Podpira poti z podmapami: /workspace/sub/dir/file.java
  const fileMatch = req.url?.match(/^\/workspace\/(.+)$/);

  if (req.method === "GET" && fileMatch) {
    const relPath = decodeURIComponent(fileMatch[1]);
    const fp = join(WORKSPACE, relPath);
    // Varnostno preverjanje — pot mora ostati znotraj WORKSPACE
    if (!fp.startsWith(WORKSPACE + "/") && fp !== WORKSPACE) {
      res.writeHead(403); res.end("Forbidden"); return;
    }
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
    const relPath = decodeURIComponent(fileMatch[1]);
    const fp = join(WORKSPACE, relPath);
    if (!fp.startsWith(WORKSPACE + "/") && fp !== WORKSPACE) {
      res.writeHead(403); res.end("Forbidden"); return;
    }
    let body = "";

    req.setEncoding("utf8");
    req.on("data", c => { body += c; });
    req.on("end", () => {
      try {
        // Zapiši v workspace
        mkdirSync(dirname(fp), { recursive: true });
        writeFileSync(fp, body, "utf8");

        // lsyncd sinhroniziraj workspace → target-root samodejno

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/scan")) {
    const scanUrl    = new URL(req.url, "http://localhost");
    const folder     = scanUrl.searchParams.get("folder") || "";
    // Varnostno: folder ne sme iti ven iz WORKSPACE
    const safeFoldr  = folder.replace(/\.\./g, "").replace(/^\//, "");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ files: scanWorkspaceFiles(safeFoldr) }));
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      workspace: WORKSPACE,
      targetRoot: TARGET_ROOT,
      workspaceUri: WORKSPACE_URI,
      syncRoot: activeSyncRoot,
      lsyncEnabled,
      lsyncd: !!lsyncdProcess,
      workspaceToTarget: {
        source: syncSourcePath(),
        target: syncTargetPath()
      },
      targetToWorkspace: {
        source: syncTargetSourcePath(),
        target: syncWorkspaceTargetPath()
      },
      clangd: clangd.isReady(),
      jdtls: jdtls.isReady(),
      clangdClients: clangdClients.size,
      javaClients: javaClients.size,
      files: scanWorkspaceFiles()
    }));
    return;
  }

  // /notify — watcher obvesti LSP o spremembi datoteke
  if (req.method === "POST" && req.url === "/notify") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        const { file, type = 2 } = JSON.parse(body);
        const rel = normalizePath(file);
        if (!rel) { res.writeHead(400); res.end("Missing file"); return; }

        const uri     = pathToFileURL(join(WORKSPACE, rel)).href;
        const isJar   = rel.toLowerCase().endsWith(".jar");

        if (jdtls.isReady()) {
          for (const client of javaClients) {
            if (!client.initialized) continue;

            // didChangeWatchedFiles za vse datoteke (vključno .jar)
            client.sendNotification("workspace/didChangeWatchedFiles", {
              changes: [{ uri, type }]
            });

            // Za .jar pošljemo še didChangeConfiguration da jdtls posodobi classpath
            if (isJar) {
              client.sendNotification("workspace/didChangeConfiguration", {
                settings: { java: { project: { referencedLibraries: [join(WORKSPACE, "**", "*.jar")] } } }
              });
            }
          }
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, uri }));
      } catch (e) {
        res.writeHead(400);
        res.end(e.message);
      }
    });
    return;
  }

  // /target/:path — zapiše vsebino nazaj v target-root
  const targetMatch = req.url?.match(/^\/target\/(.+)$/);

  if (req.method === "POST" && targetMatch) {
    const rel  = decodeURIComponent(targetMatch[1]);
    const dest = join(TARGET_ROOT, normalizePath(rel));

    if (!dest.startsWith(TARGET_ROOT + "/") && dest !== TARGET_ROOT) {
      res.writeHead(403); res.end("Forbidden"); return;
    }

    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", async () => {
      try {
        // Zapiši v workspace — lsyncd samodejno sinhroniziraj v target-root
        const lspDest = join(WORKSPACE, normalizePath(rel));
        mkdirSync(dirname(lspDest), { recursive: true });
        writeFileSync(lspDest, body, "utf8");

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500); res.end(e.message);
      }
    });
    return;
  }

  // /projects — seznam ALGator projektov (podmape v /target-root)
  if (req.method === "GET" && req.url === "/projects") {
    try {
      const entries = readdirSync(TARGET_ROOT, { withFileTypes: true });
      const projects = entries
        .filter(e => e.isDirectory() && !e.name.startsWith("."))
        .map(e => e.name)
        .sort();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ projects }));
    } catch {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ projects: [] }));
    }
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
  console.log("Target root:", TARGET_ROOT);
  console.log("Lsync is controlled from editor options through /sync-root");
});