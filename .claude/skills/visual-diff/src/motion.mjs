import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import gifenc from 'gifenc';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

const { GIFEncoder, quantize, nearestColorIndex } = gifenc;

/** Máximo de quadros de saída de um GIF (mantém o arquivo pequeno). */
const MAX_GIF_FRAMES = 60;
/** Fração mínima de pixels diferentes para um tique contar como mudança visual. */
const CHANGE_RATIO = 0.001;
/** Orçamento de pixels amostrados para montar a paleta global do GIF. */
const PALETTE_SAMPLE = 400000;
/** Duração de um quadro do compositor (o Chromium headless desenha a 60 Hz). */
const FRAME_MS = 1000 / 60;

const LAYOUT = { padding: 8, gap: 8, labelHeight: 24, titleHeight: 22 };
const COLORS = {
  background: [238, 240, 243],
  pad: [229, 231, 235],
  before: [71, 85, 105],
  after: [21, 128, 61],
};

// ---------------------------------------------------------------------------------------------
// Passos de interação
// ---------------------------------------------------------------------------------------------

/** Descrição curta de um passo, usada em avisos (ex.: "click #salvar"). */
export function describeStep(step) {
  if (!step || typeof step !== 'object') return String(step);
  if ('hover' in step) return `hover ${step.hover}`;
  if ('click' in step) return `click ${step.click}`;
  if ('focus' in step) return `focus ${step.focus}`;
  if ('type' in step) return `type ${step.type?.selector}`;
  if ('press' in step) return `press ${step.press}`;
  if ('scroll' in step) return typeof step.scroll === 'number' ? `scroll ${step.scroll}px` : `scroll ${step.scroll}`;
  if ('wait' in step) return `wait ${step.wait}ms`;
  return JSON.stringify(step);
}

/** Seletor do elemento que o passo precisa (ou null para passos sem alvo, como press e wait). */
function stepSelector(step) {
  if ('hover' in step) return step.hover;
  if ('click' in step) return step.click;
  if ('focus' in step) return step.focus;
  if ('type' in step) return step.type?.selector ?? null;
  if ('scroll' in step && typeof step.scroll === 'string') return step.scroll;
  return null;
}

async function scrollStep(page, target, timeout) {
  if (typeof target === 'string') {
    await page.locator(target).first().scrollIntoViewIfNeeded({ timeout });
    return;
  }
  // behavior 'auto' respeita o scroll-behavior da própria página (suave ou não).
  await page.evaluate((top) => window.scrollTo({ top, behavior: 'auto' }), Number(target) || 0);
}

async function runStep(page, step, timeout) {
  if ('hover' in step) return page.locator(step.hover).first().hover({ timeout });
  if ('click' in step) return page.locator(step.click).first().click({ timeout });
  if ('focus' in step) return page.locator(step.focus).first().focus({ timeout });
  if ('type' in step) {
    if (!step.type?.selector) throw new Error('passo type sem selector');
    return page.locator(step.type.selector).first().pressSequentially(String(step.type.text ?? ''), { timeout });
  }
  if ('press' in step) return page.keyboard.press(String(step.press));
  if ('scroll' in step) return scrollStep(page, step.scroll, timeout);
  if ('wait' in step) return page.waitForTimeout(Math.max(0, Number(step.wait) || 0));
  throw new Error('tipo de passo desconhecido');
}

/**
 * Executa passos de interação. Devolve a lista de passos pulados (seletor ausente), como strings.
 * steps: Array de { hover: sel } | { click: sel } | { focus: sel } | { type: { selector, text } } | { press: 'Tab' } | { scroll: pxCss } | { wait: ms }
 * Um passo que existe mas falha (ex.: elemento invisível até o timeout) lança erro.
 */
export async function runSteps(page, steps, { timeoutMs = 5000, skipMissing = true } = {}) {
  const skipped = [];
  for (const step of steps ?? []) {
    try {
      const selector = stepSelector(step ?? {});
      if (selector && skipMissing && (await page.locator(selector).count()) === 0) {
        skipped.push(describeStep(step));
        continue;
      }
      await runStep(page, step ?? {}, timeoutMs);
    } catch (error) {
      throw new Error(`passo "${describeStep(step)}" falhou: ${String(error.message).split('\n')[0]}`);
    }
  }
  return skipped;
}

// ---------------------------------------------------------------------------------------------
// Gravação
// ---------------------------------------------------------------------------------------------

/**
 * Reinicia todas as animações (CSS, transições em andamento e WAAPI) e devolve o instante do reinício
 * em ms desde a época, no relógio da linha do tempo do documento. Assim base e head começam na mesma fase.
 * Roda dentro da página.
 */
function restartAnimationsInPage() {
  for (const animation of document.getAnimations()) {
    try {
      animation.currentTime = 0;
    } catch {
      // animação sem linha do tempo ativa
    }
  }
  const timeline = document.timeline ? Number(document.timeline.currentTime) : NaN;
  return performance.timeOrigin + (Number.isFinite(timeline) ? timeline : performance.now());
}

/** Instante de um quadro do screencast, em ms desde a época (usa o carimbo do compositor quando plausível). */
function frameStamp(metadata) {
  const now = Date.now();
  const stamp = typeof metadata?.timestamp === 'number' ? metadata.timestamp * 1000 : NaN;
  return Number.isFinite(stamp) && Math.abs(stamp - now) < 10000 ? stamp : now;
}

/**
 * Acumula quadros do screencast já descartando o que nunca seria escolhido: quadros repetidos,
 * quadros fora da janela e, em cada intervalo de tique, tudo menos o primeiro e o último.
 * Quadros anteriores ao reinício das animações só ficam se nada chegar depois (página parada).
 */
function createFrameSink({ fps, durationMs }) {
  const tickMs = 1000 / fps;
  const pending = [];
  const kept = [];
  let origin = null;
  let previous = null;
  let beforeOrigin = null;
  let bucket = -1;
  let inBucket = 0;

  const accept = (stamp, data) => {
    const t = stamp - origin;
    if (t < 0) {
      beforeOrigin = data;
      return;
    }
    if (t > durationMs + tickMs) return;
    const b = tickBucket(t, fps);
    const frame = { t: Math.round(t * 10) / 10, data };
    if (b === bucket && inBucket >= 2) {
      kept[kept.length - 1] = frame;
      return;
    }
    kept.push(frame);
    inBucket = b === bucket ? inBucket + 1 : 1;
    bucket = b;
  };

  return {
    push(stamp, data) {
      if (previous && previous.equals(data)) return;
      previous = data;
      if (origin === null) pending.push([stamp, data]);
      else accept(stamp, data);
    },
    setOrigin(ms) {
      origin = ms;
      for (const [stamp, data] of pending.splice(0)) accept(stamp, data);
    },
    frames() {
      if (kept.length > 0) return kept;
      return beforeOrigin ? [{ t: 0, data: beforeOrigin }] : [];
    },
  };
}

async function waitForFonts(page, timeoutMs = 3000) {
  const ready = page.evaluate(() => (document.fonts ? document.fonts.ready.then(() => true) : true)).catch(() => false);
  await Promise.race([ready, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
}

/**
 * Abre um contexto novo (SEM congelar animações e SEM reducedMotion), navega até url, grava a tela pelo
 * screencast do CDP (Page.startScreencast, format png) enquanto roda os passos, por durationMs.
 * contextOptions: opções do browser.newContext, usadas como vierem, mas com reducedMotion: 'no-preference'.
 * prepareContext: async (context) => void opcional, chamado antes de abrir a página.
 * restartAnimations: reinicia as animações da página no início da gravação, para alinhar base e head.
 * O tempo t de cada quadro conta a partir desse reinício.
 * Devolve { frames: [{ t, data: Buffer PNG }], skipped: string[], status, stepError? } — stepError só aparece
 * se um passo existente falhou (a gravação continua até o fim mesmo assim).
 */
export async function recordMotion(browser, {
  url,
  contextOptions = {},
  prepareContext,
  steps = [],
  durationMs = 2500,
  fps = 10,
  waitUntil = 'load',
  timeoutMs = 60000,
  restartAnimations = true,
} = {}) {
  const context = await browser.newContext({ ...contextOptions, reducedMotion: 'no-preference' });
  try {
    if (prepareContext) await prepareContext(context);
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil, timeout: timeoutMs });
    const status = response ? response.status() : 0;
    await waitForFonts(page);

    const sink = createFrameSink({ fps, durationMs });
    const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
    const cdp = await context.newCDPSession(page);
    let skipped = [];
    let stepError;
    try {
      cdp.on('Page.screencastFrame', (event) => {
        sink.push(frameStamp(event.metadata), Buffer.from(event.data, 'base64'));
        cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
      });
      await cdp.send('Page.startScreencast', { format: 'png', maxWidth: viewport.width, maxHeight: viewport.height, everyNthFrame: 1 });
      const origin = restartAnimations ? await page.evaluate(restartAnimationsInPage).catch(() => Date.now()) : Date.now();
      sink.setOrigin(origin);
      try {
        skipped = await runSteps(page, steps, { timeoutMs: Math.min(timeoutMs, Math.max(1000, durationMs)), skipMissing: true });
      } catch (error) {
        stepError = error.message;
      }
      const remaining = durationMs + 1000 / fps - (Date.now() - origin);
      if (remaining > 0) await page.waitForTimeout(remaining);
    } finally {
      await cdp.send('Page.stopScreencast').catch(() => {});
      await cdp.detach().catch(() => {});
    }

    let frames = sink.frames();
    if (frames.length === 0) frames = [{ t: 0, data: await page.screenshot({ type: 'png' }) }];
    return stepError ? { frames, skipped, status, stepError } : { frames, skipped, status };
  } finally {
    await context.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------
// Reamostragem
// ---------------------------------------------------------------------------------------------

const tickCount = (fps, durationMs) => Math.max(1, Math.round((durationMs / 1000) * fps));

/**
 * Instante (ms desde o início) amostrado no tique n: o meio do intervalo em que o quadro n do GIF fica
 * na tela, (n + 0,5) / fps, ajustado para o meio de um quadro de 60 Hz. Os quadros do compositor chegam
 * nas bordas desses quadros; amostrar no meio evita que um desvio de décimos de ms troque o quadro escolhido.
 */
function tickInstant(n, fps) {
  const nominal = ((n + 0.5) * 1000) / fps;
  return (Math.floor(nominal / FRAME_MS) + 0.5) * FRAME_MS;
}

/** Primeiro tique cujo instante é >= t (o quadro com tempo t aparece a partir desse tique). */
function tickBucket(t, fps) {
  let n = Math.max(0, Math.ceil((t * fps) / 1000 - 0.5));
  while (n > 0 && tickInstant(n - 1, fps) >= t) n--;
  while (tickInstant(n, fps) < t) n++;
  return n;
}

/**
 * Para cada tique, o último quadro mostrado no instante do tique (picks) e o quadro seguinte (nexts,
 * usado para tolerar um quadro de diferença de fase na comparação). Antes do primeiro quadro, usa o primeiro.
 */
function sampleTicks(frames, fps, durationMs) {
  if (!frames || frames.length === 0) return { picks: [], nexts: [] };
  const order = frames.map((frame, index) => [frame.t, index]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const picks = [];
  const nexts = [];
  let k = 0;
  for (let n = 0; n < tickCount(fps, durationMs); n++) {
    const instant = tickInstant(n, fps);
    while (k + 1 < order.length && order[k + 1][0] <= instant) k++;
    picks.push(order[k][1]);
    const hasNext = k + 1 < order.length && order[k][0] <= instant;
    nexts.push(hasNext ? order[k + 1][1] : order[k][1]);
  }
  return { picks, nexts };
}

/**
 * Para cada tique de saída (fps), escolhe o último quadro mostrado naquele instante. Devolve índices.
 * São Math.round(durationMs / 1000 * fps) tiques (no mínimo 1); o instante do tique n é cerca de
 * (n + 0,5) / fps (veja tickInstant).
 */
export function resample(frames, fps, durationMs) {
  return sampleTicks(frames, fps, durationMs).picks;
}

// ---------------------------------------------------------------------------------------------
// Imagens (RGBA cru: { width, height, data })
// ---------------------------------------------------------------------------------------------

function decodeFrame(buffer) {
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height, data: png.data };
}

/** Reduz para no máximo maxWidth px de largura (média por área) e achata a transparência sobre branco. */
function shrink(image, maxWidth) {
  const width = Math.min(image.width, Math.max(1, Math.round(maxWidth)));
  const height = Math.max(1, Math.round((image.height * width) / image.width));
  const rx = image.width / width;
  const ry = image.height / height;
  const src = image.data;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * ry);
    const y1 = Math.max(y0 + 1, Math.min(image.height, Math.floor((y + 1) * ry)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * rx);
      const x1 = Math.max(x0 + 1, Math.min(image.width, Math.floor((x + 1) * rx)));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * image.width + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) {
          const alpha = src[i + 3] / 255;
          const white = 255 * (1 - alpha);
          r += src[i] * alpha + white;
          g += src[i + 1] * alpha + white;
          b += src[i + 2] * alpha + white;
          n++;
        }
      }
      const o = (y * width + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = 255;
    }
  }
  return { width, height, data: out };
}

function solid(width, height, [r, g, b]) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

/** Copia src para dst na posição (dx, dy), recortando o que sair de dst. */
function blit(src, dst, dx, dy) {
  const width = Math.min(src.width, dst.width - dx);
  const height = Math.min(src.height, dst.height - dy);
  if (width <= 0 || height <= 0) return;
  for (let row = 0; row < height; row++) {
    const from = row * src.width * 4;
    dst.data.set(src.data.subarray(from, from + width * 4), ((dy + row) * dst.width + dx) * 4);
  }
}

/** Cor da última linha, se ela for uniforme (fundo da página); senão, um cinza neutro. */
function edgeColor(image) {
  const start = (image.height - 1) * image.width * 4;
  const ref = [image.data[start], image.data[start + 1], image.data[start + 2]];
  for (let i = start; i < start + image.width * 4; i += 4) {
    if (Math.abs(image.data[i] - ref[0]) > 3 || Math.abs(image.data[i + 1] - ref[1]) > 3 || Math.abs(image.data[i + 2] - ref[2]) > 3) {
      return COLORS.pad;
    }
  }
  return ref;
}

function padTo(image, width, height) {
  if (image.width === width && image.height === height) return image;
  const out = solid(width, height, edgeColor(image));
  blit(image, out, 0, 0);
  return out;
}

const hashOf = (image) => createHash('sha1').update(image.data).digest('base64');

/** Amostra pixels de várias imagens num único buffer RGBA novo (o gifenc exige buffer próprio). */
function samplePixels(images) {
  const total = images.reduce((sum, image) => sum + image.width * image.height, 0);
  const step = Math.max(1, Math.ceil(total / PALETTE_SAMPLE));
  const out = new Uint8Array((Math.ceil(total / step) + images.length) * 4);
  let o = 0;
  for (const image of images) {
    for (let p = 0; p < image.width * image.height; p += step) {
      const i = p * 4;
      out[o] = image.data[i];
      out[o + 1] = image.data[i + 1];
      out[o + 2] = image.data[i + 2];
      out[o + 3] = 255;
      o += 4;
    }
  }
  return out.slice(0, o);
}

/**
 * Índice de paleta de cada pixel. Faz o papel do applyPalette do gifenc, mas com cache por cor exata:
 * o do gifenc agrupa cores por RGB565 e a primeira cor vista decide o grupo todo (o branco da página
 * virava o cinza-claro do texto do cabeçalho).
 */
function indexPixels(image, palette, cache) {
  const { data } = image;
  const index = new Uint8Array(image.width * image.height);
  for (let p = 0, i = 0; p < index.length; p++, i += 4) {
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    let idx = cache.get(key);
    if (idx === undefined) {
      idx = nearestColorIndex(palette, [data[i], data[i + 1], data[i + 2]]);
      cache.set(key, idx);
    }
    index[p] = idx;
  }
  return index;
}

// ---------------------------------------------------------------------------------------------
// Cabeçalho
// ---------------------------------------------------------------------------------------------

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const rgb = (color) => `rgb(${color.join(',')})`;

function headerGeometry(panelWidth, title) {
  const { padding, gap, labelHeight, titleHeight } = LAYOUT;
  const labelTop = padding + (title ? titleHeight : 0);
  return {
    width: padding * 2 + panelWidth * 2 + gap,
    height: labelTop + labelHeight,
    labelTop,
    beforeX: padding,
    afterX: padding + panelWidth + gap,
  };
}

function headerHtml(geo, panelWidth, title) {
  const { padding, labelHeight, titleHeight } = LAYOUT;
  const titleDiv = title
    ? `<div class="t" style="left:${padding}px;top:${padding}px;width:${geo.width - padding * 2}px;height:${titleHeight}px">${escapeHtml(title)}</div>`
    : '';
  const label = (x, color, text) => `<div class="l" style="left:${x}px;background:${rgb(color)}">${text}</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;overflow:hidden;background:${rgb(COLORS.background)};width:${geo.width}px;height:${geo.height}px;
font-family:system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif}
.t{position:absolute;font-size:13px;font-weight:600;line-height:${titleHeight - 6}px;color:#1f2937;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.l{position:absolute;top:${geo.labelTop}px;width:${panelWidth}px;height:${labelHeight}px;line-height:${labelHeight}px;padding:0 8px;box-sizing:border-box;
color:#fff;font-size:12px;font-weight:600;letter-spacing:.02em}
</style></head><body>${titleDiv}${label(geo.beforeX, COLORS.before, 'Antes')}${label(geo.afterX, COLORS.after, 'Depois')}</body></html>`;
}

/** Faixa sem texto: só as barras coloridas de "Antes" (cinza-azulado) e "Depois" (verde). */
function plainHeader(geo, panelWidth) {
  const header = solid(geo.width, geo.height, COLORS.background);
  blit(solid(panelWidth, LAYOUT.labelHeight, COLORS.before), header, geo.beforeX, geo.labelTop);
  blit(solid(panelWidth, LAYOUT.labelHeight, COLORS.after), header, geo.afterX, geo.labelTop);
  return header;
}

/** Renderiza o cabeçalho com texto no navegador; sem navegador (ou se falhar), usa a faixa sem texto. */
async function renderHeader(geo, panelWidth, title, browser) {
  if (!browser) return plainHeader(geo, panelWidth);
  let page;
  try {
    page = await browser.newPage({ viewport: { width: geo.width, height: geo.height }, deviceScaleFactor: 1 });
    await page.setContent(headerHtml(geo, panelWidth, title), { waitUntil: 'load' });
    const shot = decodeFrame(await page.screenshot({ type: 'png' }));
    if (shot.width !== geo.width || shot.height !== geo.height) return plainHeader(geo, panelWidth);
    return { width: shot.width, height: shot.height, data: new Uint8Array(shot.data) };
  } catch {
    return plainHeader(geo, panelWidth);
  } finally {
    await page?.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------
// GIF
// ---------------------------------------------------------------------------------------------

/** Reamostra um lado e decodifica/reduz os quadros escolhidos (picks e nexts). */
function prepareSide(frames, fps, durationMs, maxWidth) {
  const { picks, nexts } = sampleTicks(frames, fps, durationMs);
  const panels = new Map();
  for (const index of new Set([...picks, ...nexts])) panels.set(index, shrink(decodeFrame(frames[index].data), maxWidth));
  return { picks, nexts, panels };
}

/** Lado sem quadros: um painel cinza do tamanho comum, em todos os tiques. */
function fillEmptySide(side, count) {
  side.picks = new Array(count).fill(-1);
  side.nexts = side.picks;
}

function padSide(side, width, height) {
  const padded = new Map();
  for (const [index, panel] of side.panels) padded.set(index, padTo(panel, width, height));
  padded.set(-1, solid(width, height, COLORS.pad));
  return padded;
}

/** Compara dois painéis (mesmo tamanho) com pixelmatch; diferenças abaixo de CHANGE_RATIO não contam. */
function createComparer(before, after) {
  const cache = new Map();
  return (ib, ia) => {
    if (ib === -1 || ia === -1) return ib !== ia;
    const key = `${ib}:${ia}`;
    if (!cache.has(key)) {
      const a = before.get(ib);
      const b = after.get(ia);
      const diff = pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.1 });
      cache.set(key, diff / (a.width * a.height) >= CHANGE_RATIO);
    }
    return cache.get(key);
  };
}

/**
 * Um tique só conta como mudança se nem o par de quadros do tique nem os pares com o quadro seguinte
 * de um dos lados forem iguais (tolera um quadro de diferença de fase entre as duas gravações).
 */
function sidesDiffer(before, after, differs) {
  for (let n = 0; n < before.picks.length; n++) {
    const pb = before.picks[n];
    const pa = after.picks[n];
    if (differs(pb, pa) && differs(pb, after.nexts[n]) && differs(before.nexts[n], pa)) return true;
  }
  return false;
}

function countDistinct(side) {
  if (side.picks[0] === -1) return 0;
  return new Set([...new Set(side.picks)].map((index) => hashOf(side.panels.get(index)))).size;
}

/** Agrupa tiques consecutivos com os mesmos quadros nos dois lados num só quadro de GIF, somando o atraso. */
function planGifFrames(before, after, delay) {
  const plan = [];
  for (let n = 0; n < before.picks.length; n++) {
    const last = plan[plan.length - 1];
    if (last && last.ib === before.picks[n] && last.ia === after.picks[n]) last.delay += delay;
    else plan.push({ ib: before.picks[n], ia: after.picks[n], delay });
  }
  return plan;
}

function composeFrame(header, left, right, geo, frameHeight) {
  const frame = solid(geo.width, frameHeight, COLORS.background);
  blit(header, frame, 0, 0);
  blit(left, frame, geo.beforeX, geo.height);
  blit(right, frame, geo.afterX, geo.height);
  return frame;
}

/**
 * Codifica o GIF lado a lado. before/after são os arrays `frames` de recordMotion.
 * Reduz cada lado para no máximo maxWidth px de largura, põe um cabeçalho "Antes" | "Depois" (e o título)
 * em cima, quantiza com uma paleta global de 256 cores e grava outFile. Com mais de 60 tiques, baixa o fps
 * para caber em 60 quadros cobrindo toda a duração. Tiques consecutivos idênticos viram um quadro só.
 * Devolve { file, frameCount, distinct: { before, after }, changed }.
 */
export async function encodeMotionGif({ before, after }, { fps = 10, durationMs = 2500, maxWidth = 360, title, outFile, browser } = {}) {
  if (!outFile) throw new Error('encodeMotionGif: informe outFile');
  if (!before?.length && !after?.length) throw new Error('encodeMotionGif: nenhum quadro para codificar');
  const rate = Math.min(fps, (MAX_GIF_FRAMES * 1000) / durationMs);
  const count = tickCount(rate, durationMs);

  const sides = {
    before: prepareSide(before ?? [], rate, durationMs, maxWidth),
    after: prepareSide(after ?? [], rate, durationMs, maxWidth),
  };
  const panels = [...sides.before.panels.values(), ...sides.after.panels.values()];
  const width = Math.max(...panels.map((p) => p.width));
  const height = Math.max(...panels.map((p) => p.height));
  for (const side of Object.values(sides)) if (side.picks.length === 0) fillEmptySide(side, count);

  const padded = { before: padSide(sides.before, width, height), after: padSide(sides.after, width, height) };
  const changed = sidesDiffer(sides.before, sides.after, createComparer(padded.before, padded.after));
  const distinct = { before: countDistinct(sides.before), after: countDistinct(sides.after) };

  const geo = headerGeometry(width, title);
  const header = await renderHeader(geo, width, title, browser);
  const frameHeight = geo.height + height + LAYOUT.padding;
  const plan = planGifFrames(sides.before, sides.after, 1000 / rate);
  const used = [
    ...new Set(plan.map((f) => padded.before.get(f.ib))),
    ...new Set(plan.map((f) => padded.after.get(f.ia))),
  ];
  const palette = quantize(samplePixels([header, solid(1, 1, COLORS.background), ...used]), 256);

  const gif = GIFEncoder();
  const colorCache = new Map();
  plan.forEach((step, i) => {
    const frame = composeFrame(header, padded.before.get(step.ib), padded.after.get(step.ia), geo, frameHeight);
    const index = indexPixels(frame, palette, colorCache);
    gif.writeFrame(index, frame.width, frame.height, i === 0 ? { palette, delay: step.delay, repeat: 0 } : { delay: step.delay });
  });
  gif.finish();

  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, Buffer.from(gif.bytes()));
  return { file: outFile, frameCount: plan.length, distinct, changed };
}
