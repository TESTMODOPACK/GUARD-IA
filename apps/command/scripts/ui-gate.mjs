#!/usr/bin/env node
/**
 * Compuerta de la Fase 2, operada de verdad en un navegador:
 *   1. lanza el simulador en modo --external-dispatch (crea un SOS y espera el push)
 *   2. abre la central en Chromium headless, entra, selecciona la alerta, despacha una unidad
 *   3. el simulador confirma que el vecino recibió DISPATCHED → éxito
 * Guarda capturas en apps/command/screenshots/.
 *
 * Uso: node scripts/ui-gate.mjs [--central http://localhost:3001] [--api http://localhost:3000]
 *      [--chrome /usr/bin/google-chrome] [--keep]
 * Requiere la API y la central corriendo, y el seed aplicado.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const CENTRAL = arg('central', 'http://localhost:3001');
const API = arg('api', 'http://localhost:3000');
/**
 * Navegador: --chrome o CHROME_PATH apuntan a un Chrome/Chromium instalado (en CI, google-chrome).
 * Sin eso, se usa @sparticuz/chromium, que trae el binario dentro del paquete npm.
 */
async function resolveBrowser() {
  const explicit = arg('chrome', process.env.CHROME_PATH);
  if (explicit) return { executablePath: explicit, args: ['--no-sandbox', '--disable-gpu', '--lang=es-CL'] };
  const mod = await import('@sparticuz/chromium');
  const c = mod.default ?? mod;
  return { executablePath: await c.executablePath(), args: [...c.args, '--no-sandbox', '--lang=es-CL'] };
}
const EMAIL = arg('operator', 'operador@demo.guardia.cl');
const PASSWORD = arg('password', 'Demo1234!');
const SHOTS = join(here, '..', 'screenshots');
mkdirSync(SHOTS, { recursive: true });

const log = (m) => console.log(`[ui-gate] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Simulador en modo externo.
const simCwd = resolve(here, '..', '..', 'api');
const sim = spawn('pnpm', ['simulate', '--api', API, '--text', 'me están asaltando en la esquina de la plaza', '--external-dispatch', '--wait', '120'], {
  cwd: simCwd,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let simOut = '';
let alertId = null;
const simDone = new Promise((resolveSim) => {
  sim.stdout.on('data', (d) => {
    const text = d.toString();
    simOut += text;
    const m = /ALERT_ID=([0-9a-f-]{36})/.exec(text);
    if (m) alertId = m[1];
    process.stdout.write(text.replace(/^/gm, '  sim | '));
  });
  sim.stderr.on('data', (d) => process.stderr.write(d.toString().replace(/^/gm, '  sim ! ')));
  sim.on('exit', (code) => resolveSim(code ?? 1));
});

for (let i = 0; i < 100 && !alertId; i++) await sleep(300);
if (!alertId) {
  console.error('[ui-gate] el simulador no publicó ALERT_ID');
  sim.kill();
  process.exit(1);
}
log(`alerta del simulador: ${alertId}`);

// 2. Navegador.
const { executablePath, args } = await resolveBrowser();
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: [...args, '--window-size=1600,1000'],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => log(`error en página: ${e.message}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') log(`console.error: ${msg.text().slice(0, 200)}`);
});

let failed = false;
try {
  await page.goto(`${CENTRAL}/login`, { waitUntil: 'networkidle0', timeout: 60_000 });
  await page.screenshot({ path: join(SHOTS, '01-login.png') });
  await page.type('[data-testid=login-email]', EMAIL);
  await page.type('[data-testid=login-password]', PASSWORD);
  await page.click('[data-testid=login-submit]');
  await page.waitForSelector('section[aria-label="Cola de alertas"]', { timeout: 30_000 });
  log('sesión iniciada');

  // La alerta del simulador debe estar en la cola (carga inicial o alert.created).
  const rowSel = `section[aria-label="Cola de alertas"] li button`;
  await page.waitForFunction(
    (text) => Array.from(document.querySelectorAll('section[aria-label="Cola de alertas"] li button')).some((b) => b.textContent?.includes(text)),
    { timeout: 30_000 },
    'Robo o asalto',
  );
  await sleep(1500); // deja que lleguen la IA y el mapa
  await page.screenshot({ path: join(SHOTS, '02-cola.png') });

  // Seleccionar la primera fila "Robo o asalto" (la del simulador es la más nueva de esa categoría;
  // la cola ordena por prioridad y antigüedad, así que buscamos por texto y tomamos la última).
  const clicked = await page.evaluate((text) => {
    const rows = Array.from(document.querySelectorAll('section[aria-label="Cola de alertas"] li button')).filter((b) => b.textContent?.includes(text));
    const target = rows.at(-1);
    if (!target) return false;
    target.click();
    return true;
  }, 'Robo o asalto');
  if (!clicked) throw new Error('no se encontró la fila de la alerta');

  await page.waitForSelector('[data-testid=alert-actions]', { timeout: 15_000 });
  await page.waitForSelector('aside[aria-label="Detalle de la alerta"] audio', { timeout: 15_000 });
  await sleep(800);
  await page.screenshot({ path: join(SHOTS, '03-detalle.png') });
  log('detalle abierto con audio');

  // Verificar que el detalle corresponde a la alerta del simulador (coordenadas del simulador).
  const detailText = await page.$eval('aside[aria-label="Detalle de la alerta"]', (el) => el.textContent ?? '');
  if (!detailText.includes('-33.61170') || !detailText.includes('-70.57580')) {
    log('aviso: el detalle abierto no muestra las coordenadas del simulador; puede ser otra alerta de la misma categoría');
  }

  // Acusar recibo y despachar.
  await page.click('[data-testid=action-ack]');
  await page.waitForFunction(() => document.querySelector('aside[aria-label="Detalle de la alerta"]')?.textContent?.includes('En revisión'), { timeout: 15_000 });
  log('recibo acusado');
  await page.click('[data-testid=action-dispatch]');
  await page.waitForSelector('[data-testid=dispatch-unit]', { timeout: 10_000 });
  await page.screenshot({ path: join(SHOTS, '04-despachar.png') });
  await page.click('[data-testid=dispatch-confirm]');
  await page.waitForFunction(() => document.querySelector('aside[aria-label="Detalle de la alerta"]')?.textContent?.includes('Unidad despachada'), { timeout: 15_000 });
  await sleep(600);
  await page.screenshot({ path: join(SHOTS, '05-despachada.png') });
  log('unidad despachada desde la UI');
} catch (e) {
  failed = true;
  console.error(`[ui-gate] falló: ${e.message}`);
  await page.screenshot({ path: join(SHOTS, '99-error.png') }).catch(() => undefined);
}

// 3. El simulador debe haber recibido el push.
const simCode = await Promise.race([simDone, sleep(30_000).then(() => 'timeout')]);
if (simCode !== 0) {
  failed = true;
  console.error(`[ui-gate] el simulador terminó con ${simCode}`);
}
if (!process.argv.includes('--keep')) await browser.close();
sim.kill();

if (failed) {
  console.error('\n[ui-gate] RESULTADO: FALLÓ');
  process.exit(1);
}
console.log('\n[ui-gate] RESULTADO: OK — un operador despachó desde la central y el vecino recibió el aviso');
process.exit(0);
