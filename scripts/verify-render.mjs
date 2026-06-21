import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { inflateSync } from "node:zlib";
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

function decodePng(buffer) {
  const signature = "89504e470d0a1a0a";
  if (buffer.subarray(0, 8).toString("hex") !== signature) throw new Error("Invalid PNG signature.");
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(`Unsupported PNG format: bitDepth=${bitDepth}, colorType=${colorType}`);
      }
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const stride = width * bytesPerPixel;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = new Uint8Array(width * height * 4);
  const previous = new Uint8Array(stride);
  const current = new Uint8Array(stride);
  let rawOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[rawOffset];
    rawOffset += 1;
    current.set(raw.subarray(rawOffset, rawOffset + stride));
    rawOffset += stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bytesPerPixel ? current[x - bytesPerPixel] : 0;
      const up = previous[x] ?? 0;
      const upperLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
      if (filter === 1) current[x] = (current[x] + left) & 255;
      else if (filter === 2) current[x] = (current[x] + up) & 255;
      else if (filter === 3) current[x] = (current[x] + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) {
        const p = left + up - upperLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upperLeft);
        const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upperLeft;
        current[x] = (current[x] + predictor) & 255;
      } else if (filter !== 0) {
        throw new Error(`Unsupported PNG filter: ${filter}`);
      }
    }
    for (let x = 0; x < width; x += 1) {
      const source = x * bytesPerPixel;
      const target = (y * width + x) * 4;
      pixels[target] = current[source];
      pixels[target + 1] = current[source + 1];
      pixels[target + 2] = current[source + 2];
      pixels[target + 3] = colorType === 6 ? current[source + 3] : 255;
    }
    previous.set(current);
  }

  return { width, height, pixels };
}

function measurePngRegion(png, region) {
  let min = 255;
  let max = 0;
  let nonDark = 0;
  let alpha = 0;
  for (let y = region.y; y < region.y + region.height; y += 1) {
    for (let x = region.x; x < region.x + region.width; x += 1) {
      const index = (y * png.width + x) * 4;
      const luminance = png.pixels[index] * 0.2126 + png.pixels[index + 1] * 0.7152 + png.pixels[index + 2] * 0.0722;
      min = Math.min(min, luminance);
      max = Math.max(max, luminance);
      if (luminance > 24) nonDark += 1;
      if (png.pixels[index + 3] > 0) alpha += 1;
    }
  }
  return { nonDark, alpha, contrast: max - min };
}

async function waitForProcessExit(processHandle, timeoutMs = 1200) {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) return;
  await Promise.race([
    new Promise((resolveExit) => processHandle.once("exit", resolveExit)),
    delay(timeoutMs),
  ]);
}

function removeTempDirectory(path) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  } catch (error) {
    console.warn(`Warning: could not remove temporary browser profile: ${error.message}`);
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

    const hoverProbe = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const sim = window.__ANT_SIM;
        const canvas = document.querySelector("#world3d canvas");
        const before = sim.targetCameraYaw;
        const first = new PointerEvent("pointermove", {
          pointerId: 9981,
          pointerType: "mouse",
          clientX: 80,
          clientY: 80,
          bubbles: true,
          cancelable: true,
        });
        const second = new PointerEvent("pointermove", {
          pointerId: 9981,
          pointerType: "mouse",
          clientX: 220,
          clientY: 150,
          bubbles: true,
          cancelable: true,
        });
        canvas.dispatchEvent(first);
        canvas.dispatchEvent(second);
        const after = sim.targetCameraYaw;
        sim.pointerMap.delete(9981);
        return { before, after, delta: Math.abs(after - before) };
      })()`,
      returnByValue: true,
    });
    if (hoverProbe.result.value.delta > 0.000001) {
      throw new Error(`${label}: camera yaw changed on hover without pointerdown: ${JSON.stringify(hoverProbe.result.value)}`);
    }

    const canvasProbe = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const canvas = document.querySelector("#world3d canvas");
        const rect = canvas.getBoundingClientRect();
        const sim = window.__ANT_SIM;
        const info = sim?.renderer?.info;
        return {
          width: canvas.width,
          height: canvas.height,
          cssWidth: Math.round(rect.width),
          cssHeight: Math.round(rect.height),
          pixelRatio: sim?.currentPixelRatio ?? null,
          quality: sim?.quality?.label ?? null,
          calls: info?.render?.calls ?? null,
          triangles: info?.render?.triangles ?? null,
          geometries: info?.memory?.geometries ?? null,
          textures: info?.memory?.textures ?? null,
          hoverYawDelta: ${hoverProbe.result.value.delta},
        };
      })()`,
      returnByValue: true,
    });

    const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const screenshotPath = join(outputDir, `${label}.png`);
    const screenshotBuffer = Buffer.from(screenshot.data, "base64");
    writeFileSync(screenshotPath, screenshotBuffer);
    const png = decodePng(screenshotBuffer);
    const regionSize = Math.min(120, Math.floor(Math.min(png.width, png.height) * 0.28));
    const metrics = {
      ...canvasProbe.result.value,
      ...measurePngRegion(png, {
        x: Math.floor((png.width - regionSize) / 2),
        y: Math.floor((png.height - regionSize) / 2),
        width: regionSize,
        height: regionSize,
      }),
    };
    if (
      metrics.cssWidth < width ||
      metrics.cssHeight < height ||
      metrics.width < width * 0.5 ||
      metrics.height < height * 0.5 ||
      metrics.nonDark < regionSize * regionSize * 0.25 ||
      metrics.contrast < 14
    ) {
      throw new Error(`${label}: screenshot pixel check failed: ${JSON.stringify(metrics)}`);
    }

    const expeditionUiProbe = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        document.querySelector('[data-colony-tab="expedition"]')?.click();
        const viewportWidth = document.documentElement.clientWidth;
        const selectors = [
          "#expeditionEnemy",
          "#expeditionSoldiers",
          "#expeditionSoldiersValue",
          "#expeditionTactic",
          "#battleWinChance",
          "#battlePower",
          "#battleEnemyPower",
          "#battleReward",
          "#battleLoss",
          "#battleCooldown",
          "#expeditionStartBtn",
        ];
        const elements = selectors.map((selector) => {
          const element = document.querySelector(selector);
          const rect = element?.getBoundingClientRect();
          return {
            selector,
            exists: Boolean(element),
            left: rect ? Math.round(rect.left) : null,
            right: rect ? Math.round(rect.right) : null,
            width: rect ? Math.round(rect.width) : 0,
          };
        });
        const overflowingText = [...document.querySelectorAll("#colonyTab-expedition span, #colonyTab-expedition strong, #colonyTab-expedition button")]
          .filter((element) => element.scrollWidth > element.clientWidth + 1)
          .map((element) => element.textContent.trim().slice(0, 28));
        return {
          viewportWidth,
          documentOverflowX: document.documentElement.scrollWidth > viewportWidth + 1,
          elements,
          horizontalFit: elements.every((item) => item.exists && item.width > 0 && item.left >= -1 && item.right <= viewportWidth + 1),
          overflowingText,
        };
      })()`,
      returnByValue: true,
    });
    const expeditionUi = expeditionUiProbe.result.value;
    if (width < 600 && (!expeditionUi.horizontalFit || expeditionUi.documentOverflowX || expeditionUi.overflowingText.length > 0)) {
      throw new Error(`${label}: expedition UI mobile fit check failed: ${JSON.stringify(expeditionUi)}`);
    }

    const pheromoneProbe = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const sim = window.__ANT_SIM;
        sim.addFood(6, 6);
        const food = sim.food[sim.food.length - 1];
        sim.addTrail(food.x, food.z, "food", 0.8, {
          sourceId: food.id,
          sourceRatio: 1,
        });
        const trail = sim.trails[sim.trails.length - 1];
        const activeBefore = Boolean(sim.getFoodSource(trail.sourceId)) && trail.followStrength > 0;
        food.amount = 0;
        sim.refreshFoodMesh(food);
        sim.updateTrailPheromone(trail, 0.2);
        return {
          activeBefore,
          sourceAfter: Boolean(sim.getFoodSource(trail.sourceId)),
          followAfter: trail.followStrength,
          lifeAfter: trail.life,
        };
      })()`,
      returnByValue: true,
    });
    const pheromone = pheromoneProbe.result.value;
    if (!pheromone.activeBefore || pheromone.sourceAfter || pheromone.followAfter !== 0 || pheromone.lifeAfter > 0.18) {
      throw new Error(`${label}: depleted food pheromone check failed: ${JSON.stringify(pheromone)}`);
    }

    const battleProbe = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const sim = window.__ANT_SIM;
        sim.colony = sim.normalizeColonyState(null);
        sim.colony.food = 260;
        sim.colony.antPopulation = 180;
        sim.colony.woundedAnts = 0;
        sim.colony.enemyThreat = 2;
        sim.colony.battleCooldownUntil = 0;
        sim.colony.unlockedEnemyColonies = ["weak"];
        const unlockedInitial = sim.colony.unlockedEnemyColonies.length === 1 && sim.colony.unlockedEnemyColonies[0] === "weak";
        const available = sim.getAvailableSoldiers();
        const tooMany = sim.runExpedition("weak", available + 1, "standard", { forcedRoll: 0, ignoreCooldown: true });
        const foodBeforeWin = sim.colony.food;
        const territoryBeforeWin = sim.colony.territory;
        const win = sim.runExpedition("weak", Math.min(12, available), "standard", { forcedRoll: 0, enemyVariance: 1, ignoreCooldown: true });
        const winOk = win.ok && win.won && sim.colony.food > foodBeforeWin && sim.colony.territory > territoryBeforeWin;
        const cooldownBlocked = sim.runExpedition("weak", 1, "standard", { forcedRoll: 0 });
        sim.colony.battleCooldownUntil = 0;
        const woundedBeforeLoss = sim.colony.woundedAnts;
        const threatBeforeLoss = sim.colony.enemyThreat;
        const loss = sim.runExpedition("weak", Math.min(12, sim.getAvailableSoldiers()), "assault", { forcedRoll: 1, enemyVariance: 1, ignoreCooldown: true });
        const lossOk = loss.ok && !loss.won && sim.colony.woundedAnts > woundedBeforeLoss && sim.colony.enemyThreat > threatBeforeLoss;
        sim.colony.woundedAnts = 10;
        const woundedBeforeRecovery = sim.colony.woundedAnts;
        sim.updateColonyProgress(60);
        const woundedAfterRecovery = sim.colony.woundedAnts;
        sim.saveColonyState();
        const loaded = sim.loadColonyState();
        return {
          unlockedInitial,
          tooManyRejected: !tooMany.ok,
          winOk,
          cooldownRejected: !cooldownBlocked.ok,
          lossOk,
          recovered: woundedAfterRecovery < woundedBeforeRecovery,
          persisted: loaded.unlockedEnemyColonies.includes("weak") && loaded.territory === sim.colony.territory && loaded.battleLog.length > 0,
        };
      })()`,
      returnByValue: true,
    });
    const battle = battleProbe.result.value;
    if (!Object.values(battle).every(Boolean)) {
      throw new Error(`${label}: expedition battle check failed: ${JSON.stringify(battle)}`);
    }

    cdp.close();
    return { label, screenshotPath, metrics };
  } finally {
    browser.kill();
    await waitForProcessExit(browser);
    removeTempDirectory(userDataDir);
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
