import http from "node:http";
import { WebSocketServer } from "ws";
import { spawn, execFile } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  rmSync
} from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ALGATOR_ROOT  = process.env.ALGATOR_ROOT  || "/algator-root";
const WORKSPACE     = process.env.LSP_WORKSPACE || "/workspace";

function normalizePath(p) {
  return String(p || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function normalizeSyncRoot(folder) {
  const rel = normalizePath(folder).replace(/\/+/g, "/").replace(/\/+$/, "");
  if (!rel || rel.includes("..")) return "";
  return rel;
}

function safeJoin(base, relPath) {
  const rel = normalizePath(relPath);
  const full = join(base, rel);
  if (rel.includes("..") || (!full.startsWith(base + "/") && full !== base)) return null;
  return full;
}

function isInsideActiveSyncRoot(relPath) {
  const rel = normalizePath(relPath);
  if (!activeSyncRoot) return true;
  return rel === activeSyncRoot || rel.startsWith(activeSyncRoot + "/");
}

function readRequestBody(req) {
  return new Promise(resolve => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => resolve(body));
  });
}

let activeSyncRoot = normalizeSyncRoot(process.env.SYNC_ROOT || "");
let lsyncdProcess = null;
let lsyncEnabled = process.env.ENABLE_LSYNC !== "false";
const activeJavaSourceFolders = new Set();

function writeActiveSyncRootFile() {
  writeFileSync("/tmp/smartcode-sync-root", activeSyncRoot, "utf8");
}

function makeLsyncdConfig(source, target) {
  const exclude = [
    "--exclude=.git",
    "--exclude=node_modules",
    "--exclude=target",
    "--exclude=build",
    "--exclude=bin",
    "--exclude=java-data",
    "--exclude=java-data/**",
    "--exclude=.idea",
    "--exclude=.vscode",
    "--exclude=.metadata",
    "--exclude=.jdtls-data"
  ];

  return `settings {
  nodaemon = true,
  statusFile = "/tmp/lsyncd.status",
  statusInterval = 5,
  logfile = "/tmp/lsyncd.log"
}

sync {
  default.rsync,
  source = ${JSON.stringify(source)},
  target = ${JSON.stringify(target)},
  delay = 0.2,
  delete = false,

  rsync = {
    archive = true,
    compress = false,
    verbose = false,

    _extra = {
      "--checksum",
      "--no-whole-file",
      "--inplace",
      "--itemize-changes",
      ${exclude.map(x => JSON.stringify(x)).join(",\n      ")}
    }
  }
}
`;
}

function syncSourcePath() {
  return activeSyncRoot ? join(WORKSPACE, activeSyncRoot) : WORKSPACE;
}

function syncTargetPath() {
  return activeSyncRoot ? join(ALGATOR_ROOT, activeSyncRoot) : ALGATOR_ROOT;
}

function stopLsyncd() {
  if (lsyncdProcess && !lsyncdProcess.killed) {
    try { lsyncdProcess.kill("SIGTERM"); } catch {}
  }
  lsyncdProcess = null;
}

function startLsyncdForRoot(syncRoot) {
  const rel = normalizeSyncRoot(syncRoot);
  activeSyncRoot = rel;
  writeActiveSyncRootFile();

  stopLsyncd();

  const source = activeSyncRoot ? join(WORKSPACE, activeSyncRoot) : WORKSPACE;
  const target = activeSyncRoot ? join(ALGATOR_ROOT, activeSyncRoot) : ALGATOR_ROOT;

  mkdirSync(source, { recursive: true });
  mkdirSync(target, { recursive: true });

  const configPath = "/tmp/lsyncd-active.conf.lua";
  writeFileSync(configPath, makeLsyncdConfig(source, target), "utf8");

  lsyncdProcess = spawn("lsyncd", [configPath], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  lsyncdProcess.stdout.on("data", chunk => process.stdout.write(`[lsyncd] ${chunk}`));
  lsyncdProcess.stderr.on("data", chunk => process.stderr.write(`[lsyncd] ${chunk}`));
  lsyncdProcess.on("exit", (code, signal) => {
    console.log(`[lsyncd] exited code=${code} signal=${signal}`);
    if (lsyncdProcess) lsyncdProcess = null;
  });

  console.log(`[sync] lsyncd root: ${activeSyncRoot ? `/workspace/${activeSyncRoot}` : "/workspace"} -> ${activeSyncRoot ? `/algator-root/${activeSyncRoot}` : "/algator-root"}`);
}

async function syncSavedFileToAlgator(relPath) {
  const rel = normalizePath(relPath);
  if (!rel || rel.includes("..")) return false;
  if (!isInsideActiveSyncRoot(rel)) {
    console.log(`[sync] skipped outside syncRoot (${activeSyncRoot || "/"}): ${rel}`);
    return false;
  }

  const source = safeJoin(WORKSPACE, rel);
  const target = safeJoin(ALGATOR_ROOT, rel);
  if (!source || !target || !existsSync(source)) return false;

  mkdirSync(dirname(target), { recursive: true });

  try {
    const { stdout, stderr } = await execFileAsync("rsync", [
      "-a",
      "--checksum",
      "--no-whole-file",
      "--inplace",
      "--itemize-changes",
      source,
      dirname(target) + "/"
    ]);

    const output = `${stdout || ""}${stderr || ""}`.trim();
    if (output) console.log(`[sync] workspace -> algator-root: ${rel}\n${output}`);
    else console.log(`[sync] workspace -> algator-root: ${rel} (no content change)`);
    return true;
  } catch (e) {
    console.warn(`[sync] failed for ${rel}: ${e.message}`);
    return false;
  }
}

function applyTextPatch(content, patch) {
  const lines = String(content || "").split("\n");
  const fromLine = patch?.from?.line ?? 0;
  const fromCh = patch?.from?.ch ?? 0;
  const toLine = patch?.to?.line ?? fromLine;
  const toCh = patch?.to?.ch ?? fromCh;
  const insertLines = Array.isArray(patch?.text) ? patch.text : [String(patch?.text ?? "")];

  while (lines.length <= toLine) lines.push("");

  const before = (lines[fromLine] || "").slice(0, fromCh);
  const after = (lines[toLine] || "").slice(toCh);
  const replacement = [...insertLines];

  if (replacement.length === 1) {
    replacement[0] = before + replacement[0] + after;
  } else {
    replacement[0] = before + replacement[0];
    replacement[replacement.length - 1] = replacement[replacement.length - 1] + after;
  }

  lines.splice(fromLine, toLine - fromLine + 1, ...replacement);
  return lines.join("\n");
}


function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function parentDir(relPath = "") {
  const rel = normalizePath(relPath).replace(/\/+$/, "");
  const idx = rel.lastIndexOf("/");
  return idx >= 0 ? rel.slice(0, idx) : "";
}

function detectPackageName(text = "") {
  const withoutBlockComments = String(text).replace(/\/\*[\s\S]*?\*\//g, "");
  const withoutLineComments = withoutBlockComments.replace(/^\s*\/\/.*$/gm, "");
  const match = withoutLineComments.match(/^\s*package\s+([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\s*;/m);
  return match ? match[1] : "";
}

function javaSourceRootForFile(relPath, content = null) {
  const rel = normalizePath(relPath);
  if (!rel.toLowerCase().endsWith(".java")) return "";

  const dir = parentDir(rel);

  let text = content;
  if (text === null || text === undefined) {
    try {
      const fp = safeJoin(WORKSPACE, rel);
      if (fp && existsSync(fp)) text = readFileSync(fp, "utf8");
    } catch {
      text = "";
    }
  }

  const pkg = detectPackageName(text || "");
  if (!pkg) return dir;

  const pkgPath = pkg.replace(/\./g, "/");
  if (dir === pkgPath) return "";
  if (dir.endsWith("/" + pkgPath)) {
    return dir.slice(0, dir.length - pkgPath.length - 1);
  }

  return dir;
}

function addJavaSourceFolder(folder = "") {
  const rel = normalizeSyncRoot(folder);
  if (!rel) return;

  activeJavaSourceFolders.add(rel);
}

function addJavaSourceFolderForFile(relPath, content = null) {
  const sourceRoot = javaSourceRootForFile(relPath, content);
  if (sourceRoot) activeJavaSourceFolders.add(sourceRoot);
  return sourceRoot;
}

function autoDetectJavaSourceFolders() {
  const detected = new Set();

  function walk(dir, rel = "") {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }

    for (const name of entries) {
      if (
        name === ".git" ||
        name === ".metadata" ||
        name === ".settings" ||
        name === "java-data" ||
        name === "bin" ||
        name === "build" ||
        name === "node_modules"
      ) continue;

      const abs = join(dir, name);
      const relPath = rel ? rel + "/" + name : name;

      let st;
      try { st = statSync(abs); } catch { continue; }

      if (st.isDirectory()) {
        walk(abs, relPath);
      } else if (st.isFile() && name.toLowerCase().endsWith(".java")) {
        const sourceRoot = javaSourceRootForFile(relPath);
        
        detected.add(sourceRoot);
      }
    }
  }

  walk(WORKSPACE, "");
  return [...detected].sort();
}

function getJavaSourceFolders() {
  const folders = new Set();

  for (const folder of autoDetectJavaSourceFolders()) folders.add(folder);

  for (const folder of activeJavaSourceFolders) folders.add(folder);

  const all = [...folders].sort();

  if (!all.length) return [""];

  return all.filter(folder =>
    folder === "" ||
    !all.some(other => other !== folder && other !== "" && other.startsWith(folder + "/"))
  );
}

function classpathEntryForSourceFolder(folder, allFolders) {
  if (folder !== "") {
    return `  <classpathentry kind="src" path="${escapeXml(folder)}"/>`;
  }

  const excludes = allFolders
    .filter(f => f)
    .map(f => `${f}/**`);

  if (!excludes.length) {
    return `  <classpathentry kind="src" path=""/>`;
  }

  return `  <classpathentry kind="src" path="" excluding="${escapeXml(excludes.join("|"))}"/>`;
}

const JAVA_DATA_DIR = process.env.JDTLS_DATA_DIR || "/tmp/jdtls-data";
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

  const sourceFolders = getJavaSourceFolders();

  for (const folder of sourceFolders) {
    if (folder) mkdirSync(join(WORKSPACE, folder), { recursive: true });
  }

  const sourceEntries = sourceFolders
    .map(folder => classpathEntryForSourceFolder(folder, sourceFolders))
    .join("\n");

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

  writeFileSync(
    classpathFile,
    `<?xml version="1.0" encoding="UTF-8"?>
<classpath>
${sourceEntries}
  <classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/>
  <classpathentry kind="output" path="bin"/>
</classpath>
`,
    "utf8"
  );

  writeFileSync(
    prefsFile,
    `eclipse.preferences.version=1
org.eclipse.jdt.core.compiler.codegen.targetPlatform=17
org.eclipse.jdt.core.compiler.compliance=17
org.eclipse.jdt.core.compiler.source=17
`,
    "utf8"
  );

  mkdirSync(join(WORKSPACE, "bin"), { recursive: true });
  console.log(`[java] source folders: ${sourceFolders.map(f => f || "/").join(", ")}`);
}


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
      "-Dlog.level=ERROR",         
      "-Dfile.encoding=UTF-8",
      "-Xms256m",
      "-Xmx1G",
      "-XX:+UseG1GC",               
      "--add-modules=ALL-SYSTEM",   
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
      const nextRoot = normalizeSyncRoot(data.syncRoot || data.folder || "");
      const javaSourceFolder = normalizeSyncRoot(data.folder || "");

      if (javaSourceFolder) addJavaSourceFolder(javaSourceFolder);
      bootstrapJavaProject();
      startLsyncdForRoot(nextRoot);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        syncRoot: activeSyncRoot,
        source: activeSyncRoot ? `/workspace/${activeSyncRoot}` : "/workspace",
        target: activeSyncRoot ? `/algator-root/${activeSyncRoot}` : "/algator-root"
      }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/rebuild-java-classpath") {
    try {
      bootstrapJavaProject();

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        javaSourceFolders: getJavaSourceFolders(),
        classpath: join(WORKSPACE, ".classpath")
      }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/java-project") {
    try {
      const body = await readRequestBody(req);
      const data = JSON.parse(body || "{}");
      const folder = normalizeSyncRoot(data.folder || "");

      if (folder) addJavaSourceFolder(folder);
      bootstrapJavaProject();

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        javaSourceFolders: getJavaSourceFolders(),
        classpath: join(WORKSPACE, ".classpath")
      }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  const fileMatch = req.url?.match(/^\/workspace\/(.+)$/);

  if (req.method === "GET" && fileMatch) {
    const relPath = decodeURIComponent(fileMatch[1]);
    const fp = safeJoin(WORKSPACE, relPath);

    if (!fp) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
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
    const relPath = normalizePath(decodeURIComponent(fileMatch[1]));
    const fp = safeJoin(WORKSPACE, relPath);

    if (!fp) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    try {
      const body = await readRequestBody(req);
      mkdirSync(dirname(fp), { recursive: true });
      writeFileSync(fp, body, "utf8");
      console.log(`[server] saved workspace: ${relPath}`);

      if (relPath.toLowerCase().endsWith(".java")) {
        addJavaSourceFolderForFile(relPath, body);
        bootstrapJavaProject();
      }

      await syncSavedFileToAlgator(relPath);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  const patchMatch = req.url?.match(/^\/workspace-patch\/(.+)$/);

  if (req.method === "POST" && patchMatch) {
    const relPath = normalizePath(decodeURIComponent(patchMatch[1]));
    const fp = safeJoin(WORKSPACE, relPath);

    if (!fp) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    try {
      const body = await readRequestBody(req);
      const patch = JSON.parse(body || "{}");
      let current = "";
      if (existsSync(fp)) current = readFileSync(fp, "utf8");

      const updated = applyTextPatch(current, patch);

      mkdirSync(dirname(fp), { recursive: true });
      writeFileSync(fp, updated, "utf8");
      console.log(`[server] patched workspace: ${relPath}`);

      if (relPath.toLowerCase().endsWith(".java")) {
        addJavaSourceFolderForFile(relPath, updated);
        bootstrapJavaProject();
      }

      await syncSavedFileToAlgator(relPath);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/scan")) {
    const scanUrl = new URL(req.url, "http://localhost");
    const folder = normalizeSyncRoot(scanUrl.searchParams.get("folder") || "");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ files: scanWorkspaceFiles(folder) }));
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      workspace: WORKSPACE,
      algatorRoot: ALGATOR_ROOT,
      syncRoot: activeSyncRoot,
      lsyncd: !!lsyncdProcess,
      workspaceUri: WORKSPACE_URI,
      jdtlsDataDir: JAVA_DATA_DIR,
      clangd: clangd.isReady(),
      jdtls: jdtls.isReady(),
      clangdClients: clangdClients.size,
      javaClients: javaClients.size,
      files: scanWorkspaceFiles(activeSyncRoot)
    }));
    return;
  }

  if (req.method === "POST" && req.url === "/notify") {
    try {
      const body = await readRequestBody(req);
      const { file, type = 2 } = JSON.parse(body || "{}");
      const rel = normalizePath(file);
      if (!rel) {
        res.writeHead(400);
        res.end("Missing file");
        return;
      }

      const uri = pathToFileURL(join(WORKSPACE, rel)).href;
      const isJar = rel.toLowerCase().endsWith(".jar");

      if (jdtls.isReady()) {
        for (const client of javaClients) {
          if (!client.initialized) continue;

          client.sendNotification("workspace/didChangeWatchedFiles", {
            changes: [{ uri, type }]
          });

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
    return;
  }

  const algatorMatch = req.url?.match(/^\/algator\/(.+)$/);

  if (req.method === "POST" && algatorMatch) {
    const rel = normalizePath(decodeURIComponent(algatorMatch[1]));
    const algatorDest = safeJoin(ALGATOR_ROOT, rel);
    const workspaceDest = safeJoin(WORKSPACE, rel);

    if (!algatorDest || !workspaceDest) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    try {
      const body = await readRequestBody(req);
      mkdirSync(dirname(algatorDest), { recursive: true });
      mkdirSync(dirname(workspaceDest), { recursive: true });
      writeFileSync(algatorDest, body, "utf8");
      writeFileSync(workspaceDest, body, "utf8");

      if (rel.toLowerCase().endsWith(".java")) {
        addJavaSourceFolderForFile(rel, body);
        bootstrapJavaProject();
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500);
      res.end(e.message);
    }
    return;
  }

  if (req.method === "GET" && req.url === "/projects") {
    try {
      const entries = readdirSync(ALGATOR_ROOT, { withFileTypes: true });
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

const JAVA_CLASSPATH_REFRESH_MS = Number(process.env.JAVA_CLASSPATH_REFRESH_MS || 2000);

if (JAVA_CLASSPATH_REFRESH_MS > 0) {
  setInterval(() => {
    try {
      bootstrapJavaProject();
    } catch (e) {
      console.warn(`[java] classpath refresh failed: ${e.message}`);
    }
  }, JAVA_CLASSPATH_REFRESH_MS);
}

setupWss(wssClangd, clangd, clangdClients, "clangd");
setupWss(wssJava,   jdtls,  javaClients,   "jdtls");

clangd.start();
jdtls.start();

startLsyncdForRoot(process.env.SYNC_ROOT || "");

server.listen(3000, () => {
  console.log("SmartCode server on http://localhost:3000");
  console.log("Workspace:", WORKSPACE);
  console.log("Workspace URI:", WORKSPACE_URI);
});