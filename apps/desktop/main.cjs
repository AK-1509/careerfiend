// CareerFiend desktop app (Electron).
//
// Runs the same server as the website (the standalone Next.js build staged in
// ./server by `npm run desktop:server`) on this computer only (127.0.0.1), in
// desktop mode: an embedded database in the app's data folder, the worker
// inside the same process, and secrets created on first launch. The window
// shows that local site; links to other sites open in the default browser.
"use strict";

const { app, BrowserWindow, dialog, shell, utilityProcess } = require("electron");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { unpackServer } = require("./unpack.cjs");

const PREFERRED_PORT = 47321;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;
  let server = null;
  let quitting = false;

  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  /** A secret kept in the app's data folder, created on first launch (never leaves this computer). */
  function secret(file) {
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
    const value = randomBytes(32).toString("base64");
    fs.writeFileSync(file, value, { mode: 0o600 });
    return value;
  }

  function portFree(port) {
    return new Promise((resolve) => {
      const s = net.createServer();
      s.once("error", () => resolve(false));
      s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
    });
  }

  function anyPort() {
    return new Promise((resolve) => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => {
        const { port } = s.address();
        s.close(() => resolve(port));
      });
    });
  }

  /** The same port every launch (so you stay signed in), unless something else took it. */
  async function choosePort(file) {
    const saved = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : PREFERRED_PORT;
    for (const p of [saved, PREFERRED_PORT]) if (p > 0 && (await portFree(p))) return p;
    const p = await anyPort();
    fs.writeFileSync(file, String(p));
    return p;
  }

  async function waitForServer(url, ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (!server) return false;
      try {
        const res = await fetch(`${url}/api/health`);
        if (res.status === 200) return true;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  }

  async function start() {
    const userData = app.getPath("userData");
    fs.mkdirSync(userData, { recursive: true });
    const logDir = path.join(userData, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, "server.log");
    const log = fs.createWriteStream(logFile, { flags: "a" });
    log.write(`\n--- ${new Date().toISOString()} CareerFiend ${app.getVersion()} ---\n`);

    win = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 760,
      minHeight: 560,
      title: "CareerFiend",
      show: true,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    win.loadFile(path.join(__dirname, "loading.html"));

    const staged = app.isPackaged ? path.join(process.resourcesPath, "server") : path.join(__dirname, "server");
    if (!fs.existsSync(path.join(staged, "STAGED"))) {
      dialog.showErrorBox("CareerFiend", `The app's server is missing (${staged}). Build it with: npm run desktop:server`);
      app.quit();
      return;
    }
    // First launch after installing or updating: unpack the server into the data folder (a few seconds).
    win.webContents.executeJavaScript('document.getElementById("status").textContent = "Setting up (first launch only)…"').catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    const serverDir = unpackServer(staged, path.join(userData, "server"));
    const serverJs = path.join(serverDir, "apps", "dashboard", "server.js");
    const port = await choosePort(path.join(userData, "port"));
    const url = `http://127.0.0.1:${port}`;
    server = utilityProcess.fork(serverJs, [], {
      cwd: path.dirname(serverJs),
      serviceName: "CareerFiend server",
      stdio: "pipe",
      env: {
        ...process.env,
        NODE_ENV: "production",
        NEXT_TELEMETRY_DISABLED: "1",
        CAREERFIEND_MODE: "desktop",
        CAREERFIEND_ROOT: serverDir,
        PORT: String(port),
        HOSTNAME: "127.0.0.1",
        PUBLIC_URL: url,
        PRIVATE_DIR: path.join(userData, "data"),
        APP_ENCRYPTION_KEY_SOURCE: path.join(userData, "secret.key"),
        SESSION_SECRET: secret(path.join(userData, "session-secret")),
      },
    });
    server.stdout?.on("data", (d) => log.write(d));
    server.stderr?.on("data", (d) => log.write(d));
    server.on("exit", (code) => {
      log.write(`server exited with code ${code}\n`);
      server = null;
      if (!quitting) {
        dialog.showErrorBox("CareerFiend stopped", `The CareerFiend server stopped unexpectedly. Details are in:\n${logFile}`);
        app.quit();
      }
    });

    if (!(await waitForServer(url, 90_000))) {
      if (!quitting) dialog.showErrorBox("CareerFiend", `CareerFiend could not start. Details are in:\n${logFile}`);
      app.quit();
      return;
    }

    // Everything outside this app opens in the default browser.
    const isApp = (target) => {
      try {
        return new URL(target).origin === url;
      } catch {
        return false;
      }
    };
    win.webContents.setWindowOpenHandler(({ url: target }) => {
      if (!isApp(target) && /^https?:/.test(target)) shell.openExternal(target);
      return { action: isApp(target) ? "allow" : "deny" };
    });
    win.webContents.on("will-navigate", (event, target) => {
      if (isApp(target)) return;
      event.preventDefault();
      if (/^https?:/.test(target)) shell.openExternal(target);
    });
    win.loadURL(url);
  }

  app.on("before-quit", () => {
    quitting = true;
    server?.kill();
  });
  app.on("window-all-closed", () => app.quit());
  app.whenReady().then(() =>
    start().catch((err) => {
      dialog.showErrorBox("CareerFiend", String(err && err.stack ? err.stack : err));
      app.quit();
    }),
  );
}
