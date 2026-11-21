import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export const readPng = (file) => PNG.sync.read(readFileSync(file));
export const writePng = (file, png, deflateLevel = 6) => writeFileSync(file, PNG.sync.write(png, { deflateLevel }));

const DIFF = [255, 0, 80]; // mais claro/novo no depois
const DIFF_ALT = [0, 140, 255]; // mais escuro no depois
const INSERT_TINT = [0, 190, 120];
const SHIFT_GUTTER = [255, 170, 0];
const REMOVED_LINE = [200, 0, 200];

// ---- linhas ---------------------------------------------------------------------------------------

/** Hash FNV-1a de cada linha (RGB, ignora alfa). */
export function rowHashes(img) {
  const { width, height, data } = img;
  const out = new Uint32Array(height);
  for (let y = 0; y < height; y++) {
    let h = 0x811c9dc5;
    const start = y * width * 4;
    const end = start + width * 4;
    for (let i = start; i < end; i += 4) {
      h = Math.imul(h ^ data[i], 16777619);
      h = Math.imul(h ^ data[i + 1], 16777619);
      h = Math.imul(h ^ data[i + 2], 16777619);
    }
    out[y] = h >>> 0;
  }
  return out;
}

function rowUniform(img, y) {
  const { width, data } = img;
  const s = y * width * 4;
  for (let i = s + 4; i < s + width * 4; i += 4) {
    if (Math.abs(data[i] - data[s]) > 8 || Math.abs(data[i + 1] - data[s + 1]) > 8 || Math.abs(data[i + 2] - data[s + 2]) > 8) return false;
  }
  return true;
}

/**
 * Duas linhas são "quase iguais" quando no máximo `tolerance` (fração da largura) dos pixels têm
 * diferença acima de 48 em algum canal. Absorve a rasterização um pouco diferente de páginas altas.
 */
function makeNearEq(A, B, hashA, hashB, tolerance) {
  const width = A.width;
  const maxBad = Math.floor(width * tolerance);
  return (ya, yb) => {
    if (hashA[ya] === hashB[yb]) return true;
    const a = A.data;
    const b = B.data;
    let bad = 0;
    const sa = ya * width * 4;
    const sb = yb * width * 4;
    for (let x = 0; x < width * 4; x += 4) {
      if (Math.abs(a[sa + x] - b[sb + x]) > 48 || Math.abs(a[sa + x + 1] - b[sb + x + 1]) > 48 || Math.abs(a[sa + x + 2] - b[sb + x + 2]) > 48) {
        if (++bad > maxBad) return false;
      }
    }
    return true;
  };
}

/** Maior subsequência crescente (patience sorting) de pares [a, b] já ordenados por b. Devolve os pares. */
function lis(pairs) {
  const tails = [];
  const prev = new Int32Array(pairs.length).fill(-1);
  for (let i = 0; i < pairs.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]][0] < pairs[i][0]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const out = [];
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) out.push(pairs[i]);
  return out.reverse();
}

/**
 * Alinha as linhas do depois (B) às do antes (A): âncoras únicas por hash (patience), blocos crescidos
 * com tolerância e recursão nos intervalos. Devolve matchB (linha de A para cada linha de B, ou -1).
 */
export function alignRows(A, B, { tolerance = 0.003 } = {}) {
  const hashA = rowHashes(A);
  const hashB = rowHashes(B);
  const uniformA = new Uint8Array(A.height);
  for (let y = 0; y < A.height; y++) uniformA[y] = rowUniform(A, y) ? 1 : 0;
  const nearEq = makeNearEq(A, B, hashA, hashB, tolerance);
  const matchB = new Int32Array(B.height).fill(-1);
  // Distância aproximada entre duas linhas (amostra 1 a cada 4 pixels).
  const rowDistance = (ya, yb) => {
    const w4 = A.width * 4;
    const sa = ya * w4;
    const sb = yb * w4;
    let d = 0;
    for (let x = 0; x < w4; x += 16) {
      if (Math.abs(A.data[sa + x] - B.data[sb + x]) > 48 || Math.abs(A.data[sa + x + 1] - B.data[sb + x + 1]) > 48 || Math.abs(A.data[sa + x + 2] - B.data[sb + x + 2]) > 48) d++;
    }
    return d;
  };

  const stack = [[0, A.height, 0, B.height, 0]];
  while (stack.length) {
    let [a0, a1, b0, b1, depth] = stack.pop();
    // prefixo e sufixo comuns
    while (a0 < a1 && b0 < b1 && nearEq(a0, b0)) matchB[b0++] = a0++;
    while (a0 < a1 && b0 < b1 && nearEq(a1 - 1, b1 - 1)) matchB[--b1] = --a1;
    if (a0 >= a1 || b0 >= b1) continue;

    // âncoras: hashes não lisos que aparecem exatamente uma vez em cada lado do intervalo
    const countA = new Map();
    for (let y = a0; y < a1; y++) if (!uniformA[y]) countA.set(hashA[y], countA.has(hashA[y]) ? -1 : y);
    const countB = new Map();
    for (let y = b0; y < b1; y++) {
      const h = hashB[y];
      if (countA.has(h)) countB.set(h, countB.has(h) ? -1 : y);
    }
    const pairs = [];
    for (const [h, yb] of countB) {
      const ya = countA.get(h);
      if (yb >= 0 && ya >= 0) pairs.push([ya, yb]);
    }
    if (pairs.length === 0 || depth > 64) {
      // Sem âncoras: o bloco mudou no lugar (ex.: um botão que cresceu). Pareia as linhas com o
      // deslocamento que mais se parece; o que sobra de um lado é inserção ou remoção.
      const n = a1 - a0;
      const m = b1 - b0;
      const short = Math.min(n, m);
      const slack = Math.abs(n - m);
      let best = 0;
      if (slack && short && slack <= 400 && short <= 4000) {
        let bestCost = Infinity;
        const step = Math.max(1, Math.floor(short / 64));
        for (let o = 0; o <= slack; o++) {
          let cost = 0;
          for (let i = 0; i < short && cost < bestCost; i += step) cost += rowDistance(n > m ? a0 + o + i : a0 + i, n > m ? b0 + i : b0 + o + i);
          if (cost < bestCost) [bestCost, best] = [cost, o];
        }
      } else if (slack) best = 0;
      for (let i = 0; i < short; i++) {
        if (n > m) matchB[b0 + i] = a0 + best + i;
        else matchB[b0 + best + i] = a0 + i;
      }
      continue;
    }
    pairs.sort((p, q) => p[1] - q[1]);
    const anchors = lis(pairs);
    // Intervalos entre âncoras viram novos problemas; cada âncora entra como prefixo do intervalo seguinte.
    let pa = a0;
    let pb = b0;
    const subs = [];
    for (const [ya, yb] of anchors) {
      if (ya < pa || yb < pb) continue;
      subs.push([pa, ya, pb, yb, depth + 1]);
      matchB[yb] = ya;
      pa = ya + 1;
      pb = yb + 1;
    }
    subs.push([pa, a1, pb, b1, depth + 1]);
    for (let i = subs.length - 1; i >= 0; i--) stack.push(subs[i]);
  }
  return { matchB, hashA, hashB };
}

// ---- diff ----------------------------------------------------------------------------------------

function widen(img, width) {
  if (img.width === width) return img;
  const out = new PNG({ width, height: img.height });
  for (let y = 0; y < img.height; y++) {
    const last = (y * img.width + img.width - 1) * 4;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = x < img.width ? (y * img.width + x) * 4 : last;
      out.data[o] = img.data[s];
      out.data[o + 1] = img.data[s + 1];
      out.data[o + 2] = img.data[s + 2];
      out.data[o + 3] = 255;
    }
  }
  return out;
}

const runs = (len, pred) => {
  const out = [];
  let start = -1;
  for (let i = 0; i <= len; i++) {
    const on = i < len && pred(i);
    if (on && start < 0) start = i;
    else if (!on && start >= 0) {
      out.push([start, i]);
      start = -1;
    }
  }
  return out;
};

/**
 * Compara antes × depois com alinhamento vertical. Linhas que só se deslocaram não contam como
 * alteração, mas o deslocamento conta: kind = 'content' (pixels mudaram), 'layout-shift' (só
 * espaçamento/altura) ou 'none'. Coordenadas em pixels da imagem (scale = deviceScaleFactor).
 * workDir + key: grava `${key}.diff.png` e `${key}.aligned.png` para a composição.
 */
export function diffImages(beforeFile, afterFile, { threshold = 0.1, scale = 1, maxRegions = 3, rowTolerance = 0.003, maxFocusArea = 0.4, workDir, key, truncated = false } = {}) {
  const A0 = readPng(beforeFile);
  const B0 = readPng(afterFile);
  const width = Math.max(A0.width, B0.width);
  const A = widen(A0, width);
  const B = widen(B0, width);
  const H = B.height;

  const { matchB } = alignRows(A, B, { tolerance: rowTolerance });
  // Captura cortada (capture.maxHeight): o que entra pelo pé da imagem só estava abaixo do corte.
  const cutTail = new Uint8Array(H);
  if (truncated) for (let y = H - 1; y >= 0 && matchB[y] < 0; y--) cutTail[y] = 1;

  // "Antes alinhado": a linha de A que corresponde a cada linha de B; linhas inseridas recebem a cor
  // da borda da própria linha de B (fundo), para só o conteúdo novo aparecer como diferença.
  const aligned = new PNG({ width, height: H });
  const rowBytes = width * 4;
  for (let y = 0; y < H; y++) {
    const ya = matchB[y];
    if (ya >= 0) A.data.copy(aligned.data, y * rowBytes, ya * rowBytes, (ya + 1) * rowBytes);
    else if (cutTail[y]) B.data.copy(aligned.data, y * rowBytes, y * rowBytes, (y + 1) * rowBytes);
    else {
      const s = y * rowBytes;
      for (let x = 0; x < rowBytes; x += 4) {
        aligned.data[s + x] = B.data[s];
        aligned.data[s + x + 1] = B.data[s + 1];
        aligned.data[s + x + 2] = B.data[s + 2];
        aligned.data[s + x + 3] = 255;
      }
    }
  }

  // diffMask: só os pixels diferentes são pintados (sem o amarelo de anti-aliasing).
  const mask = new PNG({ width, height: H });
  let changed = pixelmatch(aligned.data, B.data, mask.data, width, H, { threshold, diffMask: true, diffColor: DIFF, diffColorAlt: DIFF_ALT });

  // Deslocamentos (blocos casados com offset ≠ 0), inserções e remoções.
  const offsetAt = (y) => (matchB[y] >= 0 ? y - matchB[y] : null);
  const rowHasDiff = new Uint8Array(H);
  for (let y = 0; y < H; y++) {
    for (let x = 0, i = y * rowBytes; x < width; x++, i += 4) {
      if (mask.data[i + 3]) {
        rowHasDiff[y] = 1;
        break;
      }
    }
  }
  // Linhas em branco até o fim da página: inserções/remoções aí só compensam um deslocamento.
  const trailingBlank = new Uint8Array(H + 1);
  trailingBlank[H] = 1;
  for (let y = H - 1; y >= 0; y--) trailingBlank[y] = trailingBlank[y + 1] && rowUniform(B, y) ? 1 : 0;
  const shifts = [];
  for (const [s, e] of runs(H, (y) => matchB[y] >= 0 && offsetAt(y) !== 0)) {
    // separa por offset
    let start = s;
    for (let y = s + 1; y <= e; y++) {
      if (y === e || offsetAt(y) !== offsetAt(start)) {
        // Um bloco cujas linhas também mudaram é alteração, não deslocamento.
        let withDiff = 0;
        for (let k = start; k < y; k++) withDiff += rowHasDiff[k];
        if (y - start >= 2 && withDiff / (y - start) < 0.3) shifts.push({ fromY: start, toY: y, by: offsetAt(start), rows: y - start });
        start = y;
      }
    }
  }
  // junta blocos vizinhos com o mesmo deslocamento
  const merged = [];
  for (const sh of shifts) {
    const last = merged[merged.length - 1];
    if (last && last.by === sh.by && sh.fromY - last.toY <= 8 * scale) {
      last.toY = sh.toY;
      last.rows += sh.rows;
    } else merged.push({ ...sh });
  }
  const inserted = runs(H, (y) => matchB[y] < 0 && !cutTail[y])
    .map(([s, e]) => {
      let blank = true;
      for (let y = s; y < e && blank; y++) if (!rowUniform(B, y)) blank = false;
      return { y: s, h: e - s, blank };
    })
    .filter((r) => !(r.blank && trailingBlank[r.y]));
  const usedA = new Uint8Array(A.height);
  for (let y = 0; y < H; y++) if (matchB[y] >= 0) usedA[matchB[y]] = 1;
  const removed = [];
  for (const [s, e] of runs(A.height, (y) => !usedA[y])) {
    // posição no depois: logo antes da próxima linha de A que foi casada
    let atY = H;
    for (let y = 0; y < H; y++) {
      if (matchB[y] >= e) {
        atY = y;
        break;
      }
    }
    // Pixels de conteúdo (diferentes do fundo da linha) e a extensão horizontal deles.
    let content = 0;
    let minX = width;
    let maxX = -1;
    for (let y = s; y < e; y++) {
      const r0 = y * width * 4;
      for (let x = 0; x < width; x++) {
        const i = r0 + x * 4;
        if (Math.abs(A.data[i] - A.data[r0]) > 24 || Math.abs(A.data[i + 1] - A.data[r0 + 1]) > 24 || Math.abs(A.data[i + 2] - A.data[r0 + 2]) > 24) {
          content++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    }
    if (content === 0 && (atY <= 0 || trailingBlank[Math.min(atY, H)])) continue; // só compensa um deslocamento
    if (truncated && e === A.height && atY >= H) continue; // saiu pelo corte da captura
    changed += content; // conteúdo removido conta como alterado
    removed.push({ atY, h: e - s, blank: content === 0, minX: content ? minX : 0, maxX: content ? maxX : width - 1 });
  }

  // Imagem de diff: depois desbotado, pixels alterados em vermelho/azul, inserções tingidas, faixa
  // âmbar à esquerda nas linhas deslocadas e linha magenta onde algo foi removido.
  const diff = new PNG({ width, height: H });
  const region = new Uint8Array(width * H); // máscara para as regiões de foco
  const d = diff.data;
  const isInserted = new Uint8Array(H);
  for (const r of inserted) for (let y = r.y; y < r.y + r.h; y++) isInserted[y] = 1;
  // Espaço em branco inserido no meio da página vira região (é a mudança de layout); nas bordas
  // (a página só ficou mais alta) e com conteúdo (o pixelmatch já marca o conteúdo) não.
  const markRow = new Uint8Array(H);
  for (const r of inserted) if (r.blank && r.y > 0 && r.y + r.h < H) for (let y = r.y; y < r.y + r.h; y++) markRow[y] = 1;
  const gutter = Math.max(3, Math.round(3 * scale));
  for (let y = 0; y < H; y++) {
    const shifted = matchB[y] >= 0 && offsetAt(y) !== 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const p = y * width + x;
      if (mask.data[i + 3]) {
        d[i] = mask.data[i];
        d[i + 1] = mask.data[i + 1];
        d[i + 2] = mask.data[i + 2];
        region[p] = 1;
      } else {
        const g = 255 + (0.299 * B.data[i] + 0.587 * B.data[i + 1] + 0.114 * B.data[i + 2] - 255) * 0.15;
        if (isInserted[y]) {
          d[i] = g * 0.75 + INSERT_TINT[0] * 0.25;
          d[i + 1] = g * 0.75 + INSERT_TINT[1] * 0.25;
          d[i + 2] = g * 0.75 + INSERT_TINT[2] * 0.25;
          if (markRow[y]) region[p] = 1;
        } else if (shifted && x < gutter) {
          [d[i], d[i + 1], d[i + 2]] = SHIFT_GUTTER;
        } else d[i] = d[i + 1] = d[i + 2] = g;
      }
      d[i + 3] = 255;
    }
  }
  const lineH = Math.max(2, Math.round(2 * scale));
  for (const r of removed) {
    // Espaço em branco removido no fim/início da página não merece marca.
    if (r.blank && (r.atY <= 0 || r.atY >= H)) continue;
    for (let y = Math.max(0, r.atY - lineH); y < Math.min(H, r.atY + lineH); y++) {
      for (let x = r.minX; x <= r.maxX; x++) {
        const i = (y * width + x) * 4;
        [d[i], d[i + 1], d[i + 2]] = REMOVED_LINE;
        region[y * width + x] = 1;
      }
    }
  }

  const heightDelta = B0.height - A0.height;
  const layoutChanged = merged.length > 0 || inserted.length > 0 || removed.length > 0 || heightDelta !== 0 || A0.width !== B0.width;
  const kind = changed > 0 ? 'content' : layoutChanged ? 'layout-shift' : 'none';

  const all = kind === 'none' ? [] : findRegions(region, width, H, Math.round(24 * scale));
  const area = width * H;
  const focus = all.filter((r) => (r.w * r.h) / area <= maxFocusArea).slice(0, maxRegions);

  let files = null;
  if (workDir && key) {
    files = { diff: path.join(workDir, `${key}.diff.png`), aligned: path.join(workDir, `${key}.aligned.png`) };
    writePng(files.diff, diff, 3);
    writePng(files.aligned, aligned, 3);
  }
  return {
    width,
    height: H,
    sizeBefore: { width: A0.width, height: A0.height },
    sizeAfter: { width: B0.width, height: B0.height },
    kind,
    changedPixels: changed,
    changedPercent: +(100 * (changed / area)).toFixed(3),
    shifts: merged,
    inserted,
    removed,
    regions: focus,
    regionsTotal: all.length,
    regionsSkipped: all.filter((r) => (r.w * r.h) / area > maxFocusArea).length,
    files,
    images: workDir ? undefined : { aligned, after: B, diff },
  };
}

/** diffImages numa worker thread. opts precisa de workDir (as imagens voltam como arquivos). */
export async function diffInWorker(before, after, opts) {
  const { Worker } = await import('node:worker_threads');
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./diff-worker.mjs', import.meta.url), { workerData: { before, after, opts } });
    w.once('message', (m) => (m.ok ? resolve(m.result) : reject(new Error(m.error))));
    w.once('error', reject);
    w.once('exit', (code) => code !== 0 && reject(new Error(`worker do diff saiu com código ${code}`)));
  });
}

/** Agrupa a máscara numa grade e devolve as regiões conectadas (com folga), da maior para a menor. */
export function findRegions(mask, width, height, cell) {
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const count = new Uint32Array(cols * rows);
  for (let y = 0; y < height; y++) {
    const rowOff = Math.floor(y / cell) * cols;
    for (let x = 0; x < width; x++) if (mask[y * width + x]) count[rowOff + Math.floor(x / cell)]++;
  }
  const seen = new Uint8Array(cols * rows);
  const boxes = [];
  for (let start = 0; start < count.length; start++) {
    if (!count[start] || seen[start]) continue;
    let minC = cols, minR = rows, maxC = 0, maxR = 0, px = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const idx = stack.pop();
      const r = Math.floor(idx / cols);
      const c = idx % cols;
      px += count[idx];
      minC = Math.min(minC, c); maxC = Math.max(maxC, c);
      minR = Math.min(minR, r); maxR = Math.max(maxR, r);
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const nr = r + dr, nc = c + dc;
          if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
          const n = nr * cols + nc;
          if (count[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
        }
      }
    }
    boxes.push({ x: minC * cell, y: minR * cell, w: (maxC - minC + 1) * cell, h: (maxR - minR + 1) * cell, pixels: px });
  }
  boxes.sort((p, q) => q.pixels - p.pixels);
  return boxes.map((b) => {
    const m = cell * 2;
    const x = Math.max(0, b.x - m);
    const y = Math.max(0, b.y - m);
    return { x, y, w: Math.min(width - x, b.w + 2 * m), h: Math.min(height - y, b.h + 2 * m), pixels: b.pixels };
  });
}

// ---- composição ----------------------------------------------------------------------------------

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const CSS = `
body{margin:0;background:#fff;font:600 14px/1.3 -apple-system,system-ui,Segoe UI,Roboto,sans-serif;color:#111}
#c{display:inline-block;padding:16px}
h1{font-size:13px;font-weight:500;color:#555;margin:0 0 10px}
.row{display:flex;gap:16px;align-items:flex-start}
figure{margin:0} figcaption{margin-bottom:6px}
figcaption small{font-weight:400;color:#666}
.img{position:relative;border:1px solid #ddd;line-height:0;overflow:hidden;background:#f4f4f4}
.img img{display:block}
.box{position:absolute;outline:2px solid #ff0050;outline-offset:3px;border-radius:2px}
.legend{margin-top:8px;font-weight:400;font-size:12px;color:#555;display:flex;gap:14px}
.legend i{display:inline-block;width:10px;height:10px;margin-right:4px;vertical-align:-1px}
`;

/**
 * Compositor: uma página do Chromium para todas as imagens. As imagens são servidas do disco por
 * page.route (sem data URIs). Métodos devolvem o caminho do arquivo gravado.
 */
export async function createComposer(browser) {
  const page = await browser.newPage();
  const files = new Map();
  let html = '';
  await page.route('http://vd.local/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    const f = files.get(u.pathname);
    return f ? route.fulfill({ path: f }) : route.fulfill({ status: 404, body: '' });
  });
  let counter = 0;
  const src = (file) => {
    const id = `/f/${++counter}${path.extname(file)}`;
    files.set(id, file);
    return `http://vd.local${id}`;
  };

  const render = async (body, { outFile, dpr, format }) => {
    html = `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body><div id="c">${body}</div></body></html>`;
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.emulateMedia({ colorScheme: 'light' });
    // deviceScaleFactor só existe por contexto; aproximamos com zoom CSS.
    await page.goto('http://vd.local/', { waitUntil: 'load' });
    await page.evaluate((z) => (document.body.style.zoom = String(z)), dpr);
    const type = format === 'png' ? 'png' : 'jpeg';
    await page.locator('#c').screenshot({ path: outFile, type, ...(type === 'jpeg' ? { quality: 82 } : {}) });
    files.clear();
    return outFile;
  };

  /** Coluna com uma imagem inteira (ou uma janela dela, via crop) reduzida para colW px CSS. */
  const column = (label, file, { imgW, imgH, colW, crop, boxes = [], note } = {}) => {
    const c = crop ?? { x: 0, y: 0, w: imgW, h: imgH };
    const k = colW / c.w;
    const boxHtml = boxes.map((b) => `<div class="box" style="left:${(b.x - c.x) * k}px;top:${(b.y - c.y) * k}px;width:${b.w * k}px;height:${b.h * k}px"></div>`).join('');
    return `<figure><figcaption>${escapeHtml(label)}${note ? ` <small>${escapeHtml(note)}</small>` : ''}</figcaption>
      <div class="img" style="width:${colW}px;height:${c.h * k}px"><img src="${src(file)}" style="width:${imgW * k}px;height:${imgH * k}px;margin-left:${-c.x * k}px;margin-top:${-c.y * k}px">${boxHtml}</div></figure>`;
  };

  const legend = `<div class="legend"><span><i style="background:rgb(${DIFF})"></i>alterado</span><span><i style="background:rgb(${DIFF_ALT})"></i>mais escuro no depois</span><span><i style="background:rgb(${INSERT_TINT})"></i>inserido</span><span><i style="background:rgb(${SHIFT_GUTTER})"></i>só deslocado</span><span><i style="background:rgb(${REMOVED_LINE})"></i>removido aqui</span></div>`;

  // Página alta: DPR 1 para a imagem não passar de dezenas de MB.
  const dprFor = (imgW, colW, colH) => (colH > 2500 ? 1 : Math.min(2, Math.max(1, imgW / colW)));

  return {
    /** Antes | Depois | Diff da página inteira. */
    async compare({ before, after, diff, sizeBefore, sizeAfter, regions = [], title, outFile, format = 'jpeg', maxColumnWidth = 560, scale = 1, note }) {
      const colW = Math.min(sizeAfter.width / scale, maxColumnWidth);
      const k = colW / sizeAfter.width;
      const body = `${title ? `<h1>${escapeHtml(title)}</h1>` : ''}<div class="row">
        ${column('Antes', before, { imgW: sizeBefore.width, imgH: sizeBefore.height, colW: colW * (sizeBefore.width / sizeAfter.width) })}
        ${column('Depois', after, { imgW: sizeAfter.width, imgH: sizeAfter.height, colW })}
        ${column('Diff', diff, { imgW: sizeAfter.width, imgH: sizeAfter.height, colW, boxes: regions, note })}
      </div>${legend}`;
      return render(body, { outFile, dpr: dprFor(sizeAfter.width, colW, Math.max(sizeAfter.height, sizeBefore.height) * k), format });
    },
    /** Recorte de uma região: antes alinhado | depois | diff, ampliado. */
    async focus({ aligned, after, diff, size, region, title, outFile, scale = 1, maxColumnWidth = 420 }) {
      const colW = Math.min(region.w / scale, maxColumnWidth);
      const body = `${title ? `<h1>${escapeHtml(title)}</h1>` : ''}<div class="row">
        ${column('Antes', aligned, { imgW: size.width, imgH: size.height, colW, crop: region })}
        ${column('Depois', after, { imgW: size.width, imgH: size.height, colW, crop: region })}
        ${column('Diff', diff, { imgW: size.width, imgH: size.height, colW, crop: region })}
      </div>`;
      return render(body, { outFile, dpr: dprFor(region.w, colW, region.h * (colW / region.w)), format: 'png' });
    },
    /** Uma coluna só (página nova ou removida). */
    async single({ file, size, label, title, outFile, format = 'jpeg', scale = 1, maxColumnWidth = 560 }) {
      const colW = Math.min(size.width / scale, maxColumnWidth);
      const body = `${title ? `<h1>${escapeHtml(title)}</h1>` : ''}<div class="row">${column(label, file, { imgW: size.width, imgH: size.height, colW })}</div>`;
      return render(body, { outFile, dpr: dprFor(size.width, colW, size.height * (colW / size.width)), format });
    },
    /** Faixa de variantes lado a lado, cada uma rotulada. */
    async strip({ items, title, outFile, format = 'jpeg', scale = 1, maxColumnWidth = 320 }) {
      const colW = Math.min(items[0].size.width / scale, maxColumnWidth);
      const maxH = Math.max(...items.map((i) => i.size.height * (colW / i.size.width)));
      const body = `${title ? `<h1>${escapeHtml(title)}</h1>` : ''}<div class="row">${items.map((i) => column(i.label, i.file, { imgW: i.size.width, imgH: i.size.height, colW })).join('')}</div>`;
      return render(body, { outFile, dpr: dprFor(items[0].size.width, colW, maxH), format });
    },
    close: () => page.close().catch(() => {}),
  };
}
