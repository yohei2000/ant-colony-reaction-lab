import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { chromium } from '@playwright/test';

const PORT = Number(process.env.VERIFY_PORT || (await findFreePort(4177)));
const BASE_URL = `http://127.0.0.1:${PORT}/ant-colony-reaction-lab/`;
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const serverCommand = process.platform === 'win32' ? 'cmd.exe' : npmCommand;
const serverArgs =
  process.platform === 'win32'
    ? [
        '/d',
        '/s',
        '/c',
        `npm.cmd run dev -- --host 127.0.0.1 --port ${PORT} --strictPort`
      ]
    : ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'];
const checks = [];

const server = spawn(
  serverCommand,
  serverArgs,
  {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BROWSER: 'none' }
  }
);

server.stdout.on('data', (chunk) => process.stdout.write(`[vite] ${chunk}`));
server.stderr.on('data', (chunk) => process.stderr.write(`[vite] ${chunk}`));

try {
  await waitForServer(BASE_URL);
  const browser = await launchBrowser();
  try {
    await runViewportChecks(browser, {
      name: 'mobile 390x844',
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true
    });
    await runViewportChecks(browser, {
      name: 'desktop 1366x768',
      viewport: { width: 1366, height: 768 },
      isMobile: false,
      hasTouch: false
    });
    await runWebGL1FallbackCheck(browser);
    await runCanvas2DFallbackCheck(browser);
  } finally {
    await browser.close();
  }

  console.log('\nVerification passed.');
  for (const check of checks) {
    console.log(`- ${check}`);
  }
} finally {
  stopServer(server);
  await Promise.race([once(server, 'exit'), sleep(1200)]).catch(() => undefined);
}

async function runCanvas2DFallbackCheck(browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2
  });
  await context.addInitScript(() => {
    window.localStorage.removeItem('ant3d.colonyState');
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function patchedGetContext(type, attributes) {
      if (type === 'webgl2' || type === 'webgl' || type === 'experimental-webgl') {
        return null;
      }
      return originalGetContext.call(this, type, attributes);
    };
  });
  const page = await context.newPage();
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.__ANT3D_DEBUG__));
  await page.waitForTimeout(600);

  const rendererInfo = await page.evaluate(() => window.__ANT3D_DEBUG__.getRendererInfo());
  assert(rendererInfo.rendererMode === 'canvas2d', 'canvas2d fallback: renderer starts without WebGL');
  const sample = await page.evaluate(() => window.__ANT3D_DEBUG__.sampleCanvas());
  assert(sample.brightPixels > 20, 'canvas2d fallback: canvas has visible pixels');
  assert(sample.colorVariance > 1, 'canvas2d fallback: canvas is not a flat color');
  checks.push(
    `canvas2d fallback: drawCalls=${rendererInfo.drawCalls}, pixelRatio=${rendererInfo.pixelRatio}`
  );
  await context.close();
}

async function runWebGL1FallbackCheck(browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2
  });
  await context.addInitScript(() => {
    window.localStorage.removeItem('ant3d.colonyState');
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function patchedGetContext(type, attributes) {
      if (type === 'webgl2') {
        return null;
      }
      return originalGetContext.call(this, type, attributes);
    };
  });
  const page = await context.newPage();
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.__ANT3D_DEBUG__));
  await page.waitForTimeout(600);

  const rendererInfo = await page.evaluate(() => window.__ANT3D_DEBUG__.getRendererInfo());
  assert(rendererInfo.isWebGL2 === false, 'webgl1 fallback: renderer runs without WebGL2');
  const sample = await page.evaluate(() => window.__ANT3D_DEBUG__.sampleCanvas());
  assert(sample.brightPixels > 20, 'webgl1 fallback: canvas has visible pixels');
  assert(sample.colorVariance > 1, 'webgl1 fallback: canvas is not a flat color');
  checks.push(
    `webgl1 fallback: drawCalls=${rendererInfo.drawCalls}, triangles=${rendererInfo.triangles}, pixelRatio=${rendererInfo.pixelRatio}`
  );
  await context.close();
}

async function runViewportChecks(browser, config) {
  const context = await browser.newContext({
    viewport: config.viewport,
    isMobile: config.isMobile,
    hasTouch: config.hasTouch,
    deviceScaleFactor: config.isMobile ? 2 : 1
  });
  await context.addInitScript(() => {
    window.localStorage.removeItem('ant3d.colonyState');
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => {
    throw error;
  });
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });

  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.__ANT3D_DEBUG__));
  await page.waitForTimeout(600);

  const snapshot = await page.evaluate(() => window.__ANT3D_DEBUG__.getSnapshot());
  assertEqual(snapshot.antPopulation, 12, `${config.name}: initial colony starts with 12 ants`);
  assert(snapshot.renderedAnts <= 20, `${config.name}: initial rendered ant count is small`);
  assert(
    Array.isArray(snapshot.unlockedEnemyColonies) &&
      snapshot.unlockedEnemyColonies.includes('weak'),
    `${config.name}: first enemy colony is unlocked`
  );

  const rendererInfo = await page.evaluate(() => window.__ANT3D_DEBUG__.getRendererInfo());
  assert(
    typeof rendererInfo.isWebGL2 === 'boolean',
    `${config.name}: renderer reports WebGL capability mode`
  );
  assert(rendererInfo.pixelRatio <= 1.6, `${config.name}: pixelRatio is capped`);
  assert(rendererInfo.drawCalls > 0, `${config.name}: draw calls are reported`);
  assert(rendererInfo.triangles > 0, `${config.name}: triangles are reported`);
  assert(rendererInfo.textures === 0, `${config.name}: no textures are allocated`);
  checks.push(
    `${config.name}: renderer.info drawCalls=${rendererInfo.drawCalls}, triangles=${rendererInfo.triangles}, textures=${rendererInfo.textures}, pixelRatio=${rendererInfo.pixelRatio}`
  );

  const sample = await page.evaluate(() => window.__ANT3D_DEBUG__.sampleCanvas());
  assert(sample.brightPixels > 20, `${config.name}: canvas has visible pixels`);
  assert(sample.colorVariance > 1, `${config.name}: canvas is not a flat color`);

  const beforeCamera = await page.evaluate(() => window.__ANT3D_DEBUG__.getCameraOrbit());
  await page.mouse.move(40, 40);
  await page.mouse.move(config.viewport.width - 40, config.viewport.height - 40);
  const afterCamera = await page.evaluate(() => window.__ANT3D_DEBUG__.getCameraOrbit());
  assert(
    Math.abs(beforeCamera.yaw - afterCamera.yaw) < 0.000001 &&
      Math.abs(beforeCamera.pitch - afterCamera.pitch) < 0.000001,
    `${config.name}: hover-only pointer movement does not rotate the camera`
  );

  const debugChecks = await page.evaluate(() => ({
    pheromone: window.__ANT3D_DEBUG__.testPheromoneDecay(),
    idle: window.__ANT3D_DEBUG__.testIdleGrowth(),
    upgrades: window.__ANT3D_DEBUG__.testUpgradeEffects(),
    battle: window.__ANT3D_DEBUG__.testBattleOutcomes(),
    save: window.__ANT3D_DEBUG__.testSaveRestore(),
    migration: window.__ANT3D_DEBUG__.testMigration()
  }));
  assert(debugChecks.pheromone.weakened, `${config.name}: food pheromone weakens after food depletion`);
  assert(debugChecks.idle.grew, `${config.name}: offline idle progress increases food and ants`);
  assert(debugChecks.upgrades.improved, `${config.name}: upgrades improve forage, growth, and capacity`);
  assert(debugChecks.battle.ok, `${config.name}: battle victory/defeat/cooldown/clamping rules pass`);
  assert(debugChecks.save.ok, `${config.name}: localStorage save and restore preserves colony state`);
  assert(debugChecks.migration.ok, `${config.name}: old large saves migrate to a small colony`);

  const noHorizontalOverflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    const toolbar = document.querySelector('.tool-bar');
    const toolbarRect = toolbar?.getBoundingClientRect();
    return (
      doc.scrollWidth <= window.innerWidth + 1 &&
      body.scrollWidth <= window.innerWidth + 1 &&
      (!toolbarRect || toolbarRect.right <= window.innerWidth + 1)
    );
  });
  assert(noHorizontalOverflow, `${config.name}: UI does not overflow horizontally`);
  assert(
    consoleErrors.length === 0,
    `${config.name}: browser console has no errors: ${consoleErrors.slice(0, 3).join(' | ')}`
  );
  checks.push(`${config.name}: game behavior checks passed`);
  await context.close();
}

async function launchBrowser() {
  const attempts = [
    { channel: 'chrome', headless: true },
    { channel: 'msedge', headless: true },
    { headless: true }
  ];
  let lastError;
  for (const options of attempts) {
    try {
      return await chromium.launch(options);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function waitForServer(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Vite server exited early with code ${server.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      await sleep(350);
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findFreePort(startPort) {
  for (let port = startPort; port < startPort + 40; port += 1) {
    if (await canListen(port)) {
      return port;
    }
  }
  throw new Error(`No free verification port found from ${startPort}`);
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

function stopServer(child) {
  if (!child.pid || child.exitCode !== null) {
    return;
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill('SIGTERM');
}
