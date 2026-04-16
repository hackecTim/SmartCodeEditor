import http from "node:http";
import { WebSocketServer } from "ws";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const WORKSPACE = "/workspace";
mkdirSync(WORKSPACE,                    { recursive: true });
mkdirSync(join(WORKSPACE, "java-data"), { recursive: true });


function createLspProcess(name, getArgs, clients) {
  let proc        = null;
  let procReady   = false;
  let initialized = false;   
  let initResult  = null;    
  let buf         = "";
  const SEP       = "\r\n\r\n";

  function broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(data);
    }
  }

  function sendRaw(obj) {
    if (!proc || !procReady) return;
    try {
      const json    = JSON.stringify(obj);
      const payload = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
      proc.stdin.write(payload);
    } catch (e) {
      if (e.code !== "EPIPE") console.error(`[${name}] send error:`, e.message);
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
      console.error(`[${name}] cannot get args:`, e.message, "— retrying in 5s");
      setTimeout(start, 5000);
      return;
    }

    const { cmd, args, opts } = spawnArgs;
    try {
      proc      = spawn(cmd, args, opts);
      procReady = true;
      buf       = "";
    } catch (e) {
      console.error(`[${name}] spawn failed:`, e.message, "— retrying in 5s");
      setTimeout(start, 5000);
      return;
    }

    console.log(`[${name}] started (pid ${proc.pid})`);

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", chunk => {
      buf += chunk;
      while (true) {
        const hEnd = buf.indexOf(SEP);
        if (hEnd === -1) break;
        const header = buf.slice(0, hEnd);
        const m      = header.match(/Content-Length: (\d+)/i);
        if (!m) { buf = buf.slice(hEnd + 4); break; }
        const len    = Number(m[1]);
        const bStart = hEnd + 4;
        const bEnd   = bStart + len;
        if (buf.length < bEnd) break;
        const body = buf.slice(bStart, bEnd);
        buf = buf.slice(bEnd);
        try {
          const parsed = JSON.parse(body);

          if (parsed.id !== undefined && !initialized) {
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

    proc.stderr.on("data", c => process.stderr.write(`[${name}] ${c}`));

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

  return { handleClientMessage, start, isReady: () => procReady };
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
  return { cmd: "clangd", args, opts: { cwd: WORKSPACE } };
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
      "-noverify",
      "-Xmx1G",
      "--add-modules=ALL-SYSTEM",
      "--add-opens", "java.base/java.util=ALL-UNNAMED",
      "--add-opens", "java.base/java.lang=ALL-UNNAMED",
      "-jar", join(pluginsDir, launcher),
      "-configuration", "/opt/jdtls/config_linux",
      "-data", join(WORKSPACE, "java-data")
    ],
    opts: { cwd: WORKSPACE }
  };
}, javaClients);


// HTTP—file save/load
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const fileMatch = req.url?.match(/^\/workspace\/([^/]+)$/);

  if (req.method === "GET" && fileMatch) {
    const fp = join(WORKSPACE, fileMatch[1]);
    if (!existsSync(fp)) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(readFileSync(fp, "utf8"));
    return;
  }

  if (req.method === "POST" && fileMatch) {
    const fp = join(WORKSPACE, fileMatch[1]);
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      try {
        writeFileSync(fp, body, "utf8");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (req.url === "/health") {
    res.writeHead(200);
    res.end(JSON.stringify({
      ok: true,
      clangd: clangd.isReady(),
      jdtls:  jdtls.isReady(),
      clangdClients: clangdClients.size,
      javaClients:   javaClients.size
    }));
    return;
  }

  res.writeHead(404); res.end("Not found");
});


// WebSocket routing
// ws://localhost:3000/ → clangd
// ws://localhost:3000/java  → jdtls

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
server.listen(3000, () => console.log("SmartCode server on http://localhost:3000"));
