/**
 * Main entry: opens the store-backed service, registers the deskrag:// protocol
 * and IPC, creates the window, and wires a menu-bar tray with recording status.
 * Closing the window hides to the tray (recording keeps running); Quit exits.
 */

import { app, BrowserWindow, Tray, Menu, nativeImage } from "electron";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { DeskRagService } from "./deskrag-service.js";
import { SettingsStore, dataDir } from "./settings.js";
import { registerIpc } from "./ipc.js";
import { registerScheme, registerProtocol } from "./protocol.js";

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let service: DeskRagService;
let quitting = false;

registerScheme(); // must precede app.whenReady

// In dev the app runs from <repo>/app/out/main; point the AX sidecar env var at
// the repo's built binary (npm run build:ax) so capture + the env probe find it
// without it being on PATH. An explicit ERAG_AX_BIN always wins.
if (!process.env["ERAG_AX_BIN"]) {
  const sidecar = join(__dirname, "../../../native/ax-dump");
  if (existsSync(sidecar)) process.env["ERAG_AX_BIN"] = sidecar;
}

/**
 * Icons live in app/build/, outside the bundle. In dev the main bundle runs
 * from app/out/main; packaged, resources sit beside it. Try both.
 */
function brandAsset(...segments: string[]): string {
  const candidates = [
    join(__dirname, "../../build", ...segments),
    join(process.resourcesPath ?? "", "build", ...segments),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: "DeskRAG",
    backgroundColor: "#0f1115",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    icon: brandAsset("icon.png"),
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
    },
  });

  win.on("ready-to-show", () => win?.show());
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win?.hide();
    }
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    win.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

function trayTitle(): string {
  const s = service.status();
  if (s.state === "recording") return "⏺ REC";
  if (s.state === "indexing") return "⏳";
  return "◉";
}

function rebuildTray(): void {
  if (!tray) return;
  const s = service.status();
  tray.setTitle(trayTitle());
  tray.setToolTip(`DeskRAG — ${s.state}`);
  const menu = Menu.buildFromTemplate([
    { label: "Open DeskRAG", click: () => showWindow() },
    { type: "separator" },
    s.state === "recording"
      ? { label: "Stop Recording", click: () => void service.stopRecording() }
      : {
          label: "Start Recording",
          enabled: s.state === "idle",
          click: () => void service.startRecording(),
        },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

function showWindow(): void {
  if (!win) createWindow();
  win?.show();
  win?.focus();
}

function createTray(): void {
  // A template image is black + alpha; macOS inverts it for the menu bar, so
  // one asset covers light and dark. Falls back to an empty image rather than
  // throwing if the generated icon is missing.
  const trayIcon = nativeImage.createFromPath(brandAsset("tray", "trayTemplate.png"));
  if (!trayIcon.isEmpty()) trayIcon.setTemplateImage(true);
  tray = new Tray(trayIcon.isEmpty() ? nativeImage.createEmpty() : trayIcon);
  tray.setToolTip("DeskRAG");
  tray.on("click", () => showWindow());
  rebuildTray();
}

app.whenReady().then(async () => {
  const dir = dataDir();
  const settings = new SettingsStore(dir);
  service = new DeskRagService(dir, settings);
  await service.open();

  registerProtocol(service);
  registerIpc(service, settings, () => win);
  service.onState(() => rebuildTray());

  // An unpackaged macOS dev run shows Electron's own dock icon otherwise.
  if (process.platform === "darwin" && app.dock) {
    const dockIcon = nativeImage.createFromPath(brandAsset("icon.png"));
    if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon);
  }

  createWindow();
  createTray();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
});

app.on("window-all-closed", () => {
  // Stay alive in the tray; do not quit on macOS window close.
});

app.on("before-quit", () => {
  quitting = true;
  service?.close();
});
