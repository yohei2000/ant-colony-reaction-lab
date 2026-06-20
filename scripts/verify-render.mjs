import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createStaticServer } from "./serve.mjs";

const BROWSER_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

const browserPath = BROWSER_CANDIDATES.find((candidate) => existsSync(candidate));
if (!browserPath) {
  throw new Error("Chrome or Edge was not found in the standard install locations.");
}

class CdpSession {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolveCommand, rejectCommand } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) rejectCommand(new Error(message.error.message));
      else resolveCommand(message.result);
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveCommand, rejectCommand) => {
      this.pending.set(id, { resolveCommand, rejectCommand });
    });
  }

  close() {
    this.socket.close();
  }
}

async function waitForJson(url, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {
      await delay(250);
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function verifyViewport({ label, width, height }, targetUrl, outputDir, index) {
  const debuggingPort = 9340 + index;
  const userDataDir = join(tmpdir(), `ant-3d-verify-${label}-${Date.now()}`);
  const browser = spawn(browserPath, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${userDataDir}`,
    `--window-size=${width},${height}`,
    targetUrl,
  ], { stdio: "ignore" });

  try {
    const targets = await waitForJson(`http://127.0.0.1:${debuggingPort}/json/list`);
    const page = targets.find((target) => target.type === "page") ?? targets[0];
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolveSocket, rejectSocket) => {
      socket.addEventListener("open", resolveSocket, { once: true });
      socket.addEventListener("error", rejectSocket, { once: true });
    });

    const cdp = new CdpSession(socket);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 600,
    });
    await cdp.send("Page.navigate", { url: targetUrl });

    const readyExpression = `
      new Promise((resolve) => {
        const started = Date.now();
        const tick = () => {
          if (window.__ANT_SIM_READY && document.querySelector("#world3d canvas")) resolve(true);
          else if (Date.now() - started > 15000) resolve(false);
          else setTimeout(tick, 120);
        };
        tick();
      })
    `;
    const ready = await cdp.send("Runtime.evaluate", {
      expression: readyExpression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (!ready.result.value) throw new Error(`${label}: Three.js scene did not become ready.`);
    await delay(900);

    const probe = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const canvas = document.querySelector("#world3d canvas");
        const sample = document.createElement("canvas");
        sample.width = 72;
        sample.height = 72;
        const context = sample.getContext("2d", { willReadFrequently: true });
        context.drawImage(canvas, 0, 0, 72, 72);
        const data = context.getImageData(0, 0, 72, 72).data;
        let min = 255;
        let max = 0;
        let nonDark = 0;
        let alpha = 0;
        for (let i = 0; i < data.length; i += 4) {
          const luminance = data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
          min = Math.min(min, luminance);
          max = Math.max(max, luminance);
          if (luminance > 24) nonDark += 1;
          if (data[i + 3] > 0) alpha += 1;
        }
        return {
          width: canvas.width,
          height: canvas.height,
          nonDark,
          alpha,
          contrast: max - min,
        };
      })()`,
      returnByValue: true,
    });
    const metrics = probe.result.value;
    if (metrics.width < width || metrics.height < height || metrics.nonDark < 1800 || metrics.contrast < 18) {
      throw new Error(`${label}: canvas pixel check failed: ${JSON.stringify(metrics)}`);
    }

    const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const screenshotPath = join(outputDir, `${label}.png`);
    writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
    cdp.close();
    return { label, screenshotPath, metrics };
  } finally {
    browser.kill();
    await delay(300);
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

const outputDir = resolve("verification");
mkdirSync(outputDir, { recursive: true });

const server = await createStaticServer({ port: 0 });
try {
  const address = server.address();
  const targetUrl = `http://127.0.0.1:${address.port}/`;
  const results = [];
  results.push(await verifyViewport({ label: "mobile-390x844", width: 390, height: 844 }, targetUrl, outputDir, 0));
  results.push(await verifyViewport({ label: "desktop-1366x768", width: 1366, height: 768 }, targetUrl, outputDir, 1));
  console.log(JSON.stringify({ targetUrl, results }, null, 2));
} finally {
  server.close();
}
