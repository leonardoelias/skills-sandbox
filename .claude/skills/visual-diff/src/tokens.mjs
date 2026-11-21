/**
 * Auditoria mínima de design tokens: lê as custom properties de :root/html, coleta estilos computados
 * dos elementos nas regiões alteradas e aponta cores e espaçamentos que não batem com nenhum token.
 */

/** Nomes que, mesmo resolvendo para um comprimento, não são tokens de espaçamento (fonte, raio, sombra...). */
const NON_SPACING_NAME = /(?:^|-)(?:font|text|leading|line-height|lh|tracking|letter-spacing|radius|radii|rounded|shadow|blur|duration|delay|ease|easing|z|z-index|zindex|opacity|breakpoint|bp|screen|border-width|stroke|outline)(?:-|$)/i;

// ---------------------------------------------------------------------------------------------
// Cores
// ---------------------------------------------------------------------------------------------

const clampByte = (n) => Math.max(0, Math.min(255, Math.round(n)));
const round = (n, digits) => Math.round(n * 10 ** digits) / 10 ** digits;

function parseHex(hex) {
  let h = hex;
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
  if (h.length !== 6 && h.length !== 8) return null;
  const byte = (i) => parseInt(h.slice(i, i + 2), 16);
  return [byte(0), byte(2), byte(4), h.length === 8 ? round(byte(6) / 255, 3) : 1];
}

function parseRgbFunction(body) {
  const parts = body.split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;
  const channel = (p) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p));
  const [r, g, b] = parts.slice(0, 3).map(channel);
  const alpha = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
  if (![r, g, b, alpha].every(Number.isFinite)) return null;
  return [clampByte(r), clampByte(g), clampByte(b), round(Math.max(0, Math.min(1, alpha)), 3)];
}

/** 'rgb(1, 2, 3)' | 'rgba(1,2,3,0.5)' | 'rgb(1 2 3 / 50%)' | '#abc' | '#abcd' | '#aabbcc' | '#aabbccdd' | 'transparent' -> [r,g,b,a] ou null */
export function parseRgb(str) {
  if (typeof str !== 'string') return null;
  const v = str.trim().toLowerCase();
  if (v === 'transparent') return [0, 0, 0, 0];
  const hex = /^#([0-9a-f]+)$/.exec(v);
  if (hex) return parseHex(hex[1]);
  const fn = /^rgba?\(([^()]+)\)$/.exec(v);
  return fn ? parseRgbFunction(fn[1]) : null;
}

/** Formata [r,g,b,a] como o navegador serializa cores computadas: 'rgb(r, g, b)' ou 'rgba(r, g, b, a)'. */
function formatRgb([r, g, b, a = 1]) {
  return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${round(a, 3)})`;
}

function srgbToOklab([r, g, b]) {
  const linear = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const lr = linear(r);
  const lg = linear(g);
  const lb = linear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Distância euclidiana em OKLab (0..~1; preto × branco ≈ 1). Ignora o alfa. */
export function oklabDistance(rgbA, rgbB) {
  const [l1, a1, b1] = srgbToOklab(rgbA);
  const [l2, a2, b2] = srgbToOklab(rgbB);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** Distância usada na auditoria: OKLab mais a diferença de opacidade. */
function colorDistance(a, b) {
  return Math.hypot(oklabDistance(a, b), (a[3] ?? 1) - (b[3] ?? 1));
}

// ---------------------------------------------------------------------------------------------
// Leitura dos tokens (roda na página)
// ---------------------------------------------------------------------------------------------

/** Converte um padrão tipo glob ('--color-*') em fonte de RegExp. Sem '*', vale como prefixo. */
function patternSource(pattern) {
  const p = String(pattern).trim();
  const body = p.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return p.includes('*') ? `^${body}$` : `^${body}`;
}

/** Lê nomes e valores das custom properties de :root/html e classifica em cor ou espaçamento. Roda na página. */
function readTokensInPage({ include, nonSpacing }) {
  const root = document.documentElement;
  const computed = getComputedStyle(root);
  const names = new Set();
  const addFrom = (style) => {
    for (let i = 0; i < style.length; i++) if (style[i].startsWith('--')) names.add(style[i]);
  };
  const isRootRule = (selector) => selector.split(',').some((s) => /^\s*(?::root|html)(?![\w-])/i.test(s));
  const walk = (rules) => {
    for (const rule of rules) {
      try {
        if (rule.styleSheet) walk(rule.styleSheet.cssRules);
        if (rule.selectorText && isRootRule(rule.selectorText)) addFrom(rule.style);
        if (rule.cssRules) walk(rule.cssRules);
      } catch {
        // folha de outra origem: não dá para ler as regras
      }
    }
  };
  addFrom(computed);
  addFrom(root.style);
  for (const sheet of [...document.styleSheets, ...(document.adoptedStyleSheets ?? [])]) {
    try {
      walk(sheet.cssRules);
    } catch {
      // folha de outra origem
    }
  }

  const includeRe = include ? include.map((src) => new RegExp(src)) : null;
  const nonSpacingRe = new RegExp(nonSpacing, 'i');
  const keyword = /^(?:inherit|initial|unset|revert|revert-layer|currentcolor)$/i;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const toRgba = (value) => {
    const m = /^rgba?\(([^()]+)\)$/i.exec(value.trim());
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
      if (p.length >= 3 && p.every(Number.isFinite)) return [Math.round(p[0]), Math.round(p[1]), Math.round(p[2]), p[3] ?? 1];
    }
    // oklch(), lab(), color(...): o navegador mantém o espaço de cor; o canvas converte para sRGB.
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], Math.round((d[3] / 255) * 1000) / 1000];
  };

  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:0;height:0;visibility:hidden;pointer-events:none';
  root.appendChild(probe);
  const colors = [];
  const spacing = [];
  try {
    for (const name of names) {
      if (includeRe && !includeRe.some((re) => re.test(name))) continue;
      const raw = computed.getPropertyValue(name).trim();
      if (!raw || keyword.test(raw)) continue;
      probe.style.color = '';
      probe.style.color = raw;
      if (probe.style.color) {
        colors.push({ name, rgb: toRgba(getComputedStyle(probe).color) });
        continue;
      }
      if (!includeRe && nonSpacingRe.test(name)) continue;
      if (raw.includes('%') || !/[a-z]/i.test(raw)) continue;
      probe.style.paddingLeft = '';
      probe.style.paddingLeft = raw;
      if (!probe.style.paddingLeft) continue;
      const px = parseFloat(getComputedStyle(probe).paddingLeft);
      if (Number.isFinite(px)) spacing.push({ name, px });
    }
  } finally {
    probe.remove();
  }
  return { colors, spacing };
}

/**
 * Lê os tokens do documento: custom properties de :root/html (estilo computado do documentElement e
 * regras :root/html das folhas legíveis). include: padrões opcionais como ['--color-*', '--space-*'].
 * Sem include, nomes de fonte, raio, sombra etc. não contam como espaçamento.
 * Devolve { colors: [{ name, value: 'rgb(r, g, b)' | 'rgba(...)', rgb: [r,g,b,a] }], spacing: [{ name, px }] }
 */
export async function readTokens(page, { include } = {}) {
  const patterns = include && include.length ? include.map(patternSource) : null;
  const { colors, spacing } = await page.evaluate(readTokensInPage, { include: patterns, nonSpacing: NON_SPACING_NAME.source });
  return {
    colors: colors.map((t) => ({ name: t.name, value: formatRgb(t.rgb), rgb: t.rgb })),
    spacing,
  };
}

// ---------------------------------------------------------------------------------------------
// Coleta de estilos (roda na página)
// ---------------------------------------------------------------------------------------------

/** Coleta cores e espaçamentos computados dos elementos visíveis que cruzam as regiões. Roda na página. */
function collectStylesInPage({ regions, maxElements }) {
  const SKIP = new Set(['HEAD', 'SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'NOSCRIPT', 'TEMPLATE', 'BR', 'WBR', 'BASE', 'SOURCE', 'TRACK', 'PARAM', 'DEFS', 'DESC', 'CLIPPATH', 'MASK']);
  const SHAPES = new Set(['path', 'circle', 'rect', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'use']);
  const SIDES = ['top', 'right', 'bottom', 'left'];
  const CLEAN_CLASS = /^[A-Za-z_-][\w-]*$/;
  const GENERATED_CLASS = /^(?:css|sc|jsx|svelte|emotion)-/;
  const GENERATED_ID = /^(?:radix|headlessui|react-aria|mui|ember)\b|\d{4,}/i;

  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const toRgba = (value) => {
    const m = /^rgba?\(([^()]+)\)$/i.exec(value.trim());
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
      if (p.length >= 3 && p.every(Number.isFinite)) return [Math.round(p[0]), Math.round(p[1]), Math.round(p[2]), p[3] ?? 1];
      return null;
    }
    if (!value || value === 'none' || value.startsWith('url(')) return null;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], Math.round((d[3] / 255) * 1000) / 1000];
  };
  const format = ([r, g, b, a]) => (a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`);

  const partCache = new Map();
  const partOf = (el) => {
    if (partCache.has(el)) return partCache.get(el);
    let part;
    const id = el.id;
    if (id && /^[A-Za-z][\w-]*$/.test(id) && !GENERATED_ID.test(id) && document.querySelectorAll(`#${CSS.escape(id)}`).length === 1) {
      part = { text: `#${id}`, anchor: true };
    } else {
      const tag = el.localName;
      const classes = [...el.classList].filter((c) => CLEAN_CLASS.test(c) && !GENERATED_CLASS.test(c)).slice(0, 2);
      let text = tag + classes.map((c) => `.${c}`).join('');
      const parent = el.parentElement;
      if (parent) {
        const sameType = [...parent.children].filter((c) => c.localName === tag);
        const alike = sameType.filter((c) => classes.every((cls) => c.classList.contains(cls)));
        if (alike.length > 1) text += `:nth-of-type(${sameType.indexOf(el) + 1})`;
      }
      part = { text, anchor: tag === 'html' || tag === 'body' };
    }
    partCache.set(el, part);
    return part;
  };
  const selectorOf = (el) => {
    const parts = [partOf(el)];
    let node = el.parentElement;
    while (node && parts.length < 3 && !parts[0].anchor) {
      const part = partOf(node);
      if (part.text === 'html' || part.text === 'body') break;
      parts.unshift(part);
      node = node.parentElement;
    }
    while (parts.length > 1 && parts.map((p) => p.text).join(' > ').length > 80) parts.shift();
    const selector = parts.map((p) => p.text).join(' > ');
    return selector.length > 80 ? el.localName : selector;
  };

  /** Agrupa valores por lado: os 4 iguais → base; topo+base → -block; esquerda+direita → -inline. */
  const groupSides = (values) => {
    const groups = new Map();
    for (const [side, value] of Object.entries(values)) groups.set(value, [...(groups.get(value) ?? []), side]);
    const out = [];
    for (const [value, sides] of groups) {
      if (sides.length === 4) {
        out.push(['', value]);
        continue;
      }
      const rest = new Set(sides);
      if (rest.has('top') && rest.has('bottom')) {
        out.push(['-block', value]);
        rest.delete('top');
        rest.delete('bottom');
      }
      if (rest.has('left') && rest.has('right')) {
        out.push(['-inline', value]);
        rest.delete('left');
        rest.delete('right');
      }
      for (const side of rest) out.push([`-${side}`, value]);
    }
    return out;
  };

  const intersects = (box) =>
    !regions || regions.some((r) => box.x < r.x + r.w && r.x < box.x + box.w && box.y < r.y + r.h && r.y < box.y + box.h);
  const visible = (el, cs) => {
    if (el.checkVisibility) return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    return cs.visibility === 'visible' && cs.opacity !== '0';
  };

  const out = [];
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  let count = 0;
  for (const el of document.querySelectorAll('*')) {
    if (count >= maxElements) break;
    if (SKIP.has(el.tagName.toUpperCase()) || el.closest('head, defs, clipPath, mask')) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) continue;
    if (!intersects({ x: rect.left + scrollX, y: rect.top + scrollY, w: rect.width, h: rect.height })) continue;
    const cs = getComputedStyle(el);
    if (!visible(el, cs)) continue;
    count++;

    const selector = selectorOf(el);
    const parentCs = el.parentElement ? getComputedStyle(el.parentElement) : null;
    const typed = el.computedStyleMap ? el.computedStyleMap() : null;
    const color = (prop, value) => {
      const rgb = toRgba(value);
      if (rgb && rgb[3] > 0) out.push({ selector, prop, value: format(rgb), kind: 'color', rgb });
    };
    const spacing = (prop, value) => out.push({ selector, prop, value, kind: 'spacing', px: parseFloat(value) });
    const usable = (prop, value) => {
      const px = parseFloat(value);
      if (!Number.isFinite(px) || px === 0) return false;
      const spec = typed ? String(typed.get(prop) ?? '') : '';
      return spec !== 'auto' && !spec.includes('%');
    };

    // Cores
    if (cs.color !== (parentCs ? parentCs.color : 'rgb(0, 0, 0)')) color('color', cs.color);
    color('background-color', cs.backgroundColor);
    const borders = {};
    for (const side of SIDES) {
      const style = cs.getPropertyValue(`border-${side}-style`);
      if (parseFloat(cs.getPropertyValue(`border-${side}-width`)) > 0 && style !== 'none' && style !== 'hidden') {
        borders[side] = cs.getPropertyValue(`border-${side}-color`);
      }
    }
    for (const [suffix, value] of groupSides(borders)) color(`border${suffix}-color`, value);
    if (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) color('outline-color', cs.outlineColor);
    if (el instanceof SVGElement && SHAPES.has(el.localName)) {
      color('fill', cs.fill);
      if (parseFloat(cs.strokeWidth) > 0) color('stroke', cs.stroke);
    }

    // Espaçamentos
    for (const box of ['margin', 'padding']) {
      const values = {};
      for (const side of SIDES) {
        if (box === 'margin' && cs.display === 'inline' && (side === 'top' || side === 'bottom')) continue;
        const value = cs.getPropertyValue(`${box}-${side}`);
        if (usable(`${box}-${side}`, value)) values[side] = value;
      }
      for (const [suffix, value] of groupSides(values)) spacing(`${box}${suffix}`, value);
    }
    if (/flex|grid/.test(cs.display)) {
      const row = usable('row-gap', cs.rowGap) ? cs.rowGap : null;
      const column = usable('column-gap', cs.columnGap) ? cs.columnGap : null;
      if (row && row === column) spacing('gap', row);
      else {
        if (row) spacing('row-gap', row);
        if (column) spacing('column-gap', column);
      }
    }
  }
  return out;
}

/**
 * Coleta estilos computados dos elementos visíveis cujo retângulo (coordenadas da página, px CSS) cruza
 * alguma das regions ({ x, y, w, h }). Sem regions, olha a página toda; com [], não olha nada.
 * Cores: color (só quando difere do pai), background-color, border-*-color (bordas com largura > 0),
 * outline-color, fill/stroke de formas SVG. Espaçamentos: margin-*, padding-*, gap/row-gap/column-gap
 * (lados iguais são agrupados: padding, padding-block, padding-inline). Ignora transparente, 0px, auto,
 * normal e porcentagens. Devolve [{ selector, prop, value, kind: 'color'|'spacing', rgb?, px? }]
 */
export async function collectStyles(page, { regions, maxElements = 2500 } = {}) {
  if (Array.isArray(regions) && regions.length === 0) return [];
  const boxes = regions ? regions.map((r) => ({ x: r.x, y: r.y, w: r.w ?? r.width, h: r.h ?? r.height })) : null;
  return page.evaluate(collectStylesInPage, { regions: boxes, maxElements });
}

// ---------------------------------------------------------------------------------------------
// Auditoria
// ---------------------------------------------------------------------------------------------

const findingKey = (f) => `${f.kind}|${f.selector}|${f.prop}|${f.value}`;
const looseKey = (f) => `${f.kind}|${f.prop}|${f.value}`;

function toPx(value) {
  if (typeof value === 'number') return value;
  const m = /^\s*(-?\d*\.?\d+)px\s*$/i.exec(String(value));
  return m ? parseFloat(m[1]) : null;
}

function nearestBy(list, distanceOf) {
  let best = null;
  for (const item of list) {
    const distance = distanceOf(item);
    if (!best || distance < best.distance) best = { item, distance };
  }
  return best;
}

function checkColor(style, palette, allowed, tolerance) {
  const rgb = style.rgb ?? parseRgb(style.value);
  if (!rgb) return null;
  if (allowed.some((c) => colorDistance(c, rgb) <= tolerance)) return null;
  const best = nearestBy(palette, (t) => colorDistance(t.rgb, rgb));
  if (best.distance <= tolerance) return null;
  return { name: best.item.name, value: best.item.value ?? formatRgb(best.item.rgb), distance: round(best.distance, 4) };
}

function checkSpacing(style, scale, allowed, tolerance) {
  const px = Math.abs(style.px ?? parseFloat(style.value));
  if (!Number.isFinite(px) || px === 0) return null;
  if (allowed.some((a) => Math.abs(Math.abs(a) - px) <= tolerance)) return null;
  const best = nearestBy(scale, (t) => Math.abs(t.px - px));
  if (best.distance <= tolerance) return null;
  return { name: best.item.name, value: `${best.item.px}px`, distance: round(best.distance, 2) };
}

/**
 * Compara estilos com tokens. Cor: fora do conjunto se a distância OKLab (mais a diferença de alfa) até
 * o token mais próximo for > colorTolerance; espaçamento: fora se |px| não bater com nenhum token de
 * espaçamento (± spacingTolerance px). Cada tipo só é auditado se houver tokens daquele tipo.
 * allow: valores sempre aceitos, como 'rgb(0, 0, 0)', '#fff', '1px' ou 1.
 * Devolve [{ kind, selector, prop, value, nearest: { name, value, distance } | null, key }], sem repetir key.
 */
export function auditTokens(styles, tokens, { colorTolerance = 0.02, spacingTolerance = 0.5, allow = [] } = {}) {
  const palette = (tokens?.colors ?? []).filter((t) => Array.isArray(t.rgb));
  const scale = (tokens?.spacing ?? []).filter((t) => Number.isFinite(t.px));
  const allowedColors = allow.map((a) => (typeof a === 'string' ? parseRgb(a) : null)).filter(Boolean);
  const allowedPx = allow.map(toPx).filter((n) => n !== null);
  const findings = [];
  const seen = new Set();
  for (const style of styles ?? []) {
    let nearest = null;
    if (style.kind === 'color' && palette.length > 0) nearest = checkColor(style, palette, allowedColors, colorTolerance);
    else if (style.kind === 'spacing' && scale.length > 0) nearest = checkSpacing(style, scale, allowedPx, spacingTolerance);
    if (!nearest) continue;
    const finding = { kind: style.kind, selector: style.selector, prop: style.prop, value: style.value, nearest };
    finding.key = findingKey(finding);
    if (seen.has(finding.key)) continue;
    seen.add(finding.key);
    findings.push(finding);
  }
  return findings;
}

/**
 * Achados do head que não existem no base. Um achado é antigo se o base tiver a mesma key ou, caso o
 * seletor tenha mudado, o mesmo kind + prop + value.
 */
export function newFindings(baseFindings, headFindings) {
  const exact = new Set((baseFindings ?? []).map((f) => f.key ?? findingKey(f)));
  const loose = new Set((baseFindings ?? []).map(looseKey));
  return (headFindings ?? []).filter((f) => !exact.has(f.key ?? findingKey(f)) && !loose.has(looseKey(f)));
}
