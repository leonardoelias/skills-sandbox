// ritmo: injetado na página. Mede o espaço vertical entre blocos empilhados
// de tinta a tinta (do pé da tinta de um bloco ao topo da tinta do próximo),
// compara com a distância entre as caixas, desenha uma faixa colorida por
// valor em cada espaço e lista as falhas.
//
//   window.__ritmo({ draw: true, root: 'main', scale: [4, 8, 12, 16, 24, 32], ignore: '.prose' })
//
// Tinta de texto: da altura das maiúsculas até a linha de base, a mesma
// convenção de `text-box: trim-both cap alphabetic`. Tinta de caixa (fundo
// diferente do pai, borda nos quatro lados ou sombra), imagem, ícone ou campo:
// a própria caixa. Borda só em cima ou só embaixo é uma divisória e conta
// como tinta.
//
// Devolve a escala usada, os espaços medidos e, por região, as falhas:
//   escala       distância entre caixas fora da escala de espaçamento
//   irmaos       pares equivalentes (mesmo componente) com espaços diferentes
//   proximidade  espaço dentro de um grupo igual ou maior que entre grupos
//   titulo       título com espaço acima menor ou igual ao de baixo
//   caixa        caixa com espaço de cima diferente do de baixo
// e notas de entrelinha: o mesmo espaço no código aparecendo com valores
// diferentes na tela por causa do line-height.
window.__ritmo = function (opts = {}) {
  const draw = opts.draw !== false;
  const TOL = 1; // até 1px é igual (side bearing, arredondamento)
  const MISS = 2; // 2px ou mais é falha
  document.querySelectorAll("[data-ritmo]").forEach((n) => n.remove());

  const root =
    (typeof opts.root === "string" ? document.querySelector(opts.root) : opts.root) || document.body;
  const ignoreSel = opts.ignore || "";
  const sx = window.scrollX;
  const sy = window.scrollY;

  const SKIP_TAG = /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT|LINK|META|HEAD|TITLE|BR|WBR|OPTION|DATALIST)$/;
  const GRAPHIC = /^(IMG|SVG|VIDEO|CANVAS|PICTURE|IFRAME|INPUT|TEXTAREA|SELECT|PROGRESS|METER|HR|OBJECT|EMBED|AUDIO)$/i;
  const TABLEISH = /^(TABLE|THEAD|TBODY|TFOOT|TR|TD|TH|COLGROUP|CAPTION)$/;
  const REGION =
    'main, section, aside, nav, header, footer, form, dialog, [role="dialog"], [role="menu"], [role="listbox"], [data-slot="sheet-content"], [data-slot="popover-content"], [data-slot="dropdown-menu-content"]';
  const HEADING = 'h1, h2, h3, h4, h5, h6, [role="heading"]';

  const styles = new Map();
  const cs = (el) => {
    let s = styles.get(el);
    if (!s) styles.set(el, (s = getComputedStyle(el)));
    return s;
  };
  const clear = (c) => !c || c === "transparent" || /rgba\([^)]*,\s*0\)$/.test(c);
  const ignored = (el) => ignoreSel && el.closest(ignoreSel);
  const tag = (el) => el.tagName.toUpperCase();

  // ---------- caixas e divisórias ----------
  const backdrop = (el) => {
    for (let a = el; a; a = a.parentElement) {
      const c = cs(a).backgroundColor;
      if (!clear(c)) return c;
    }
    return "rgb(255, 255, 255)";
  };
  const SIDES = ["Top", "Right", "Bottom", "Left"];
  const borderVisible = (s, side) =>
    parseFloat(s[`border${side}Width`]) > 0 && s[`border${side}Style`] !== "none" && !clear(s[`border${side}Color`]);

  // Sombras: uma sombra de 1-2px só num eixo, sem blur nem spread, é uma linha
  // (divisória feita com box-shadow). Qualquer outra sombra visível desenha uma forma.
  const shadowCache = new Map();
  const shadows = (s) => {
    const v = s.boxShadow;
    if (!v || v === "none") return { shape: false, top: false, bottom: false };
    if (shadowCache.has(v)) return shadowCache.get(v);
    const res = { shape: false, top: false, bottom: false };
    for (const part of v.split(/,(?![^(]*\))/)) {
      const color = part.match(/rgba?\([^)]*\)|#[0-9a-f]+|[a-z]+(?=\s|$)/i)?.[0];
      if (color && clear(color)) continue;
      const [x = 0, y = 0, blur = 0, spread = 0] = (part.replace(/rgba?\([^)]*\)/g, "").match(/-?[\d.]+px/g) || []).map(parseFloat);
      const inset = /\binset\b/.test(part);
      if (blur === 0 && spread === 0 && x === 0 && y !== 0 && Math.abs(y) <= 2) {
        if ((y < 0) !== inset) res.top = true;
        else res.bottom = true;
      } else if (blur === 0 && spread === 0 && y === 0 && x !== 0 && Math.abs(x) <= 2) {
        /* linha lateral: não afeta o ritmo vertical */
      } else res.shape = true;
    }
    shadowCache.set(v, res);
    return res;
  };
  const sideVisible = (s, side) =>
    borderVisible(s, side) || (side === "Top" && shadows(s).top) || (side === "Bottom" && shadows(s).bottom);

  // Texto vertical ou elemento girado: a pilha dele não é vertical na tela.
  const orientCache = new Map();
  const oriented = (el) => {
    if (orientCache.has(el)) return orientCache.get(el);
    const s = cs(el);
    let v = /^(vertical|sideways)/.test(s.writingMode) || (s.rotate && s.rotate !== "none" && parseFloat(s.rotate) !== 0);
    if (!v && s.transform && s.transform !== "none") {
      const m = s.transform.match(/matrix(3d)?\(([^)]+)\)/);
      if (m) {
        const n = m[2].split(",").map(parseFloat);
        v = m[1] ? Math.abs(n[1]) > 1e-3 || Math.abs(n[4]) > 1e-3 || Math.abs(n[2]) > 1e-3 : Math.abs(n[1]) > 1e-3 || Math.abs(n[2]) > 1e-3;
      }
    }
    orientCache.set(el, v);
    return v;
  };
  const insideOriented = (el) => {
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) if (oriented(a)) return true;
    return false;
  };
  // Esconde também o que o Chrome deixa no layout sem pintar (conteúdo de <details> fechado).
  const visible = (el) =>
    typeof el.checkVisibility === "function" ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : true;
  const boxCache = new Map();
  const isBox = (el) => {
    if (boxCache.has(el)) return boxCache.get(el);
    let v = false;
    if (!TABLEISH.test(tag(el)) && el !== document.body && el !== document.documentElement) {
      const s = cs(el);
      if (s.display !== "contents" && s.display !== "inline") {
        const fill =
          (!clear(s.backgroundColor) && s.backgroundColor !== backdrop(el.parentElement)) ||
          (s.backgroundImage && s.backgroundImage !== "none");
        const border = SIDES.every((side) => borderVisible(s, side));
        v = Boolean(fill || border || shadows(s).shape);
      }
    }
    boxCache.set(el, v);
    return v;
  };
  const dividerBelow = (el) => tag(el) === "HR" || (!isBox(el) && sideVisible(cs(el), "Bottom"));
  const dividerAbove = (el) => tag(el) === "HR" || (!isBox(el) && sideVisible(cs(el), "Top"));

  // ---------- métricas de fonte ----------
  const ctx = document.createElement("canvas").getContext("2d");
  const metricCache = new Map();
  const metrics = (s) => {
    const font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
    let m = metricCache.get(font);
    if (!m) {
      ctx.font = font;
      const H = ctx.measureText("H");
      m = { ascent: H.fontBoundingBoxAscent, cap: H.actualBoundingBoxAscent };
      metricCache.set(font, m);
    }
    return m;
  };

  // ---------- tinta ----------
  const union = (a, b) =>
    !a
      ? b
      : !b
        ? a
        : {
            top: Math.min(a.top, b.top),
            bottom: Math.max(a.bottom, b.bottom),
            left: Math.min(a.left, b.left),
            right: Math.max(a.right, b.right),
          };
  const rectOf = (r) => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
  const tiny = (r) => r.bottom - r.top <= 1 && r.right - r.left <= 1;

  const textInk = (node, s) => {
    if (!node.textContent.trim()) return null;
    const m = metrics(s);
    const range = document.createRange();
    range.selectNodeContents(node);
    let res = null;
    for (const r of range.getClientRects()) {
      if (r.width < 1) continue;
      const base = r.top + m.ascent;
      res = union(res, { top: base - m.cap, bottom: base, left: r.left, right: r.right });
    }
    return res;
  };

  const inkCache = new Map();
  const ink = (el) => {
    if (inkCache.has(el)) return inkCache.get(el);
    let res = null;
    const s = cs(el);
    const hidden =
      SKIP_TAG.test(tag(el)) ||
      el.hasAttribute("data-ritmo") ||
      s.display === "none" ||
      s.visibility === "hidden" ||
      parseFloat(s.opacity) === 0 ||
      s.position === "fixed" ||
      (s.display !== "contents" && !visible(el));
    if (!hidden) {
      const r = el.getBoundingClientRect();
      if (GRAPHIC.test(el.tagName) || isBox(el) || oriented(el)) {
        res = r.width > 0 && r.height > 0 ? rectOf(r) : null;
      } else {
        if (s.display !== "contents") {
          const bt = Math.max(1, parseFloat(s.borderTopWidth));
          const bb = Math.max(1, parseFloat(s.borderBottomWidth));
          if (sideVisible(s, "Top")) res = union(res, { top: r.top, bottom: r.top + bt, left: r.left, right: r.right });
          if (sideVisible(s, "Bottom"))
            res = union(res, { top: r.bottom - bb, bottom: r.bottom, left: r.left, right: r.right });
        }
        for (const n of el.childNodes) {
          if (n.nodeType === 3) res = union(res, textInk(n, s));
          else if (n.nodeType === 1) {
            const ci = ink(n);
            if (!ci) continue;
            // Um filho absoluto fora do pai (menu aberto, tooltip) não é tinta do pai.
            if (
              cs(n).position === "absolute" &&
              s.display !== "contents" &&
              (ci.top < r.top - TOL || ci.bottom > r.bottom + TOL)
            )
              continue;
            res = union(res, ci);
          }
        }
        if (res && s.display !== "contents" && (s.overflowY !== "visible" || s.overflowX !== "visible")) {
          res = {
            top: Math.max(res.top, r.top),
            bottom: Math.min(res.bottom, r.bottom),
            left: Math.max(res.left, r.left),
            right: Math.min(res.right, r.right),
          };
          if (res.bottom <= res.top || res.right <= res.left) res = null;
        }
      }
      if (res && tiny(res)) res = null; // .sr-only e afins
    }
    inkCache.set(el, res);
    return res;
  };

  // ---------- pilhas ----------
  const flowChildren = (el, blockified) => {
    const out = [];
    for (const c of el.children) {
      if (SKIP_TAG.test(tag(c)) || c.hasAttribute("data-ritmo")) continue;
      const s = cs(c);
      if (s.display === "none") continue;
      if (s.display === "contents") {
        out.push(...flowChildren(c, blockified));
        continue;
      }
      if (s.position === "absolute" || s.position === "fixed" || s.float !== "none") continue;
      if (!blockified && /^inline|^ruby/.test(s.display)) continue;
      out.push(c);
    }
    return out;
  };

  const desc = (el) => {
    const t = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    const slot = el.dataset.slot ? `[${el.dataset.slot}]` : "";
    const cls = (el.getAttribute("class") || "")
      .trim()
      .split(/\s+/)
      .filter((c) => c && !/[:[\]/]/.test(c))[0];
    const name = id || slot || (cls ? `.${cls}` : "");
    const h = el.matches(HEADING) ? el : null;
    const text = h ? ` "${h.textContent.trim().replace(/\s+/g, " ").slice(0, 28)}"` : "";
    return `${t}${name}${text}`;
  };
  const sig = (el) =>
    [
      el.tagName,
      el.getAttribute("role") || "",
      el.dataset.slot || "",
      (el.getAttribute("class") || "").trim().split(/\s+/).sort().join(" "),
    ].join("|");

  const headingBlock = (el) => {
    if (el.matches(HEADING)) return el;
    const h = el.querySelector(HEADING);
    return h && h.textContent.trim() === el.textContent.trim() ? h : null;
  };

  const elastic = (parent, kids) => {
    const s = cs(parent);
    return /space-|stretch/.test(s.justifyContent) || /space-/.test(s.alignContent) || kids.some((k) => parseFloat(cs(k).flexGrow) > 0);
  };

  const parents = [root, ...root.querySelectorAll("*")].filter(
    (el) =>
      el.children.length >= 2 &&
      !SKIP_TAG.test(tag(el)) &&
      !TABLEISH.test(tag(el)) &&
      !el.closest("svg, [data-ritmo]") &&
      !ignored(el) &&
      cs(el).display !== "none" &&
      cs(el).display !== "contents" &&
      visible(el) &&
      !insideOriented(el),
  );

  const pairs = [];
  for (const parent of parents) {
    const blockified = /flex|grid/.test(cs(parent).display);
    const kids = flowChildren(parent, blockified)
      .filter((el) => !ignored(el))
      .map((el) => ({ el, ink: ink(el), box: el.getBoundingClientRect() }))
      .filter((k) => k.ink);
    if (kids.length < 2) continue;
    const isElastic = elastic(parent, kids.map((k) => k.el));
    for (const a of kids) {
      let best = null;
      for (const b of kids) {
        if (b === a || b.ink.top < a.ink.bottom - TOL) continue;
        const overlap = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
        const narrow = Math.min(a.box.width, b.box.width);
        if (narrow <= 0 || overlap < narrow * 0.5) continue;
        if (!best || b.ink.top < best.ink.top) best = b;
      }
      if (!best) continue;
      const b = best;
      pairs.push({
        parent,
        a: a.el,
        b: b.el,
        aInk: a.ink,
        bInk: b.ink,
        ink: +(b.ink.top - a.ink.bottom).toFixed(1),
        box: +(b.box.top - a.box.bottom).toFixed(1),
        left: Math.max(a.box.left, b.box.left),
        right: Math.min(a.box.right, b.box.right),
        elastic: isElastic,
        divided: dividerBelow(a.el) || dividerAbove(b.el),
      });
    }
  }

  // ---------- escala ----------
  const toPx = (v) => {
    const d = document.createElement("div");
    d.setAttribute("data-ritmo", "");
    d.style.cssText = `position:absolute;visibility:hidden;width:0;height:${v}`;
    document.body.appendChild(d);
    const h = d.getBoundingClientRect().height;
    d.remove();
    return h;
  };
  const readScale = () => {
    if (Array.isArray(opts.scale) && opts.scale.length)
      return { source: "opções", values: [...new Set(opts.scale.map(Number))].sort((a, b) => a - b) };
    if (opts.step) return { source: "opções", step: +opts.step };
    if (getComputedStyle(document.documentElement).getPropertyValue("--spacing").trim()) {
      const px = toPx("var(--spacing)");
      if (px > 0) return { source: "--spacing", step: px };
    }
    const names = new Set();
    const collect = (rules) => {
      for (const r of rules) {
        if (r.selectorText && /(^|,)\s*(:root|html|:host)\b/.test(r.selectorText))
          for (const p of r.style) if (/^--(space|spacing|gap|gutter|stack|inset)[-_]/.test(p)) names.add(p);
        if (r.cssRules) collect(r.cssRules);
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        collect(sheet.cssRules);
      } catch {
        /* folha de outra origem */
      }
    }
    const values = [...new Set([...names].map((n) => +toPx(`var(${n})`).toFixed(2)).filter((v) => v > 0))].sort(
      (a, b) => a - b,
    );
    if (values.length >= 3) return { source: `${names.size} tokens --space-*`, values };
    return { source: "presumida", step: 4 };
  };
  const scale = readScale();
  const onScale = (v) => {
    if (v <= TOL) return true;
    if (scale.values) return scale.values.some((s) => Math.abs(v - s) < 0.5);
    const rem = v % scale.step;
    return rem < 0.5 || scale.step - rem < 0.5;
  };

  // ---------- regiões ----------
  const regionOf = (el) => el.closest(REGION) || root;
  const regionName = (el) => {
    if (el === root && el === document.body) return "página";
    // Só um título da própria região: o h1 do header não dá nome ao main.
    const own = [...el.querySelectorAll(HEADING)].find((h) => h.closest(REGION) === el);
    return (
      el.getAttribute("aria-label") ||
      own?.textContent.trim().replace(/\s+/g, " ").slice(0, 30) ||
      desc(el)
    );
  };

  const misses = [];
  const notes = [];
  const where = (p) => `${desc(p.a)} → ${desc(p.b)}`;
  const yOf = (p) => Math.round(p.aInk.bottom + sy);

  // escala: o que o código controla. Sem tokens no projeto a grade de 4px é só
  // um palpite, então a falha vira nota (soft) até alguém definir a escala.
  const presumed = scale.source === "presumida";
  for (const p of pairs) {
    if (p.box > TOL && !onScale(p.box) && !p.elastic)
      misses.push({
        kind: "escala",
        soft: presumed || undefined,
        pair: p,
        y: yOf(p),
        gap: Math.round(p.box * 10) / 10,
        where: where(p),
        text: `caixa ${p.box}px fora da escala`,
      });
  }

  // irmãos: o mesmo par de componentes, o mesmo espaço visível. Um pai sem
  // classe, papel nem data-slot (um <ul> qualquer) só compara os próprios filhos:
  // dois <ul> genéricos da mesma página não são o mesmo componente.
  const uid = new Map();
  const parentKey = (el) => {
    const weak = !el.getAttribute("class") && !el.getAttribute("role") && !el.dataset.slot && !el.id;
    if (!weak) return sig(el);
    if (!uid.has(el)) uid.set(el, `#${uid.size}`);
    return uid.get(el);
  };
  const groups = new Map();
  for (const p of pairs) {
    if (p.elastic) continue;
    const key = `${parentKey(p.parent)}>${sig(p.a)}→${sig(p.b)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const h = new Map();
    for (const p of list) h.set(Math.round(p.ink), (h.get(Math.round(p.ink)) || 0) + 1);
    const ranked = [...h.entries()].sort((x, y) => y[1] - x[1]);
    const [mode, count] = ranked[0];
    const tie = ranked.length > 1 && ranked[1][1] === count;
    for (const p of list) {
      if (Math.abs(p.ink - mode) < MISS) continue;
      misses.push({
        kind: "irmaos",
        pair: p,
        y: yOf(p),
        where: where(p),
        expected: tie ? null : mode,
        text: tie
          ? `${Math.round(p.ink)}px, e outro par igual tem ${mode}px: decida qual vale`
          : `${Math.round(p.ink)}px vs ${mode}px (${count} de ${list.length} pares)`,
      });
    }
  }

  // proximidade: dentro de um grupo menos espaço que entre grupos
  const internalMax = new Map();
  const inner = (el) => {
    if (internalMax.has(el)) return internalMax.get(el);
    let max = 0;
    for (const p of pairs) {
      if (p.divided || p.elastic) continue;
      if (p.parent !== el && !el.contains(p.parent)) continue;
      // O espaço acima de um título separa seções dentro do bloco (prosa com
      // h2 soltos): quem cuida dele é a regra de título, não a de proximidade.
      if (headingBlock(p.b)) continue;
      // Pares dentro de uma caixa aninhada já estão agrupados pela caixa.
      let boxed = false;
      for (let a = p.parent; a && a !== el; a = a.parentElement) if (isBox(a)) boxed = true;
      if (boxed) continue;
      if (p.ink > max) max = p.ink;
    }
    internalMax.set(el, max);
    return max;
  };
  for (const p of pairs) {
    if (p.divided || p.elastic || isBox(p.a) || isBox(p.b)) continue;
    const insideA = isBox(p.a) ? 0 : inner(p.a);
    const insideB = isBox(p.b) ? 0 : inner(p.b);
    const inside = Math.max(insideA, insideB);
    if (inside > 0 && p.ink - inside < MISS)
      misses.push({
        kind: "proximidade",
        pair: p,
        y: yOf(p),
        where: where(p),
        text: `${Math.round(p.ink)}px entre os blocos, ${Math.round(inside)}px dentro de ${insideA >= insideB ? desc(p.a) : desc(p.b)}`,
      });
  }

  // título: mais espaço acima que abaixo. Um sobretítulo (kicker, eyebrow) logo
  // acima é parte do título: uma linha de texto menor que abre a pilha.
  const lines = (el) => {
    const r = ink(el);
    const fs = parseFloat(cs(el).fontSize);
    return r ? (r.bottom - r.top) / (fs * 1.6) : 0;
  };
  const eyebrow = (above, h) =>
    !isBox(above.a) &&
    lines(above.a) <= 1 &&
    parseFloat(cs(above.a).fontSize) < parseFloat(cs(h).fontSize) &&
    !pairs.some((p) => p.b === above.a && p.parent === above.parent);
  for (const below of pairs) {
    const h = headingBlock(below.a);
    if (!h) continue;
    const above = pairs.find((p) => p.b === below.a);
    if (!above || above.elastic || below.elastic || eyebrow(above, h)) continue;
    if (above.ink - below.ink < MISS)
      misses.push({
        kind: "titulo",
        pair: above,
        also: below,
        y: yOf(above),
        where: desc(h),
        text: `${Math.round(above.ink)}px acima vs ${Math.round(below.ink)}px abaixo`,
      });
  }

  // caixa: o mesmo espaço em cima e embaixo, medido na tinta
  const boxes = [];
  for (const el of [root, ...root.querySelectorAll("*")]) {
    if (!isBox(el) || GRAPHIC.test(el.tagName) || ignored(el) || el.closest("svg, [data-ritmo]")) continue;
    const s = cs(el);
    if (s.display === "none" || s.position === "fixed" || !visible(el) || insideOriented(el)) continue;
    if (/auto|scroll/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1) continue;
    let content = null;
    for (const n of el.childNodes) {
      if (n.nodeType === 3) content = union(content, textInk(n, s));
      else if (n.nodeType === 1 && cs(n).position !== "absolute") content = union(content, ink(n));
    }
    if (!content) continue;
    const r = el.getBoundingClientRect();
    const top = +(content.top - r.top).toFixed(1);
    const bottom = +(r.bottom - content.bottom).toFixed(1);
    if (top <= 0.5 || bottom <= 0.5) continue; // mídia sangrando na borda
    boxes.push({ el, r, top, bottom });
    if (Math.abs(top - bottom) >= MISS)
      misses.push({
        kind: "caixa",
        box: { el, r, top, bottom },
        y: Math.round(r.top + sy),
        where: desc(el),
        text: `${Math.round(top)}px em cima vs ${Math.round(bottom)}px embaixo`,
      });
  }

  // ---------- relatório por região ----------
  const regions = new Map();
  const usedNames = new Set();
  const regionEntry = (el) => {
    const reg = regionOf(el);
    if (!regions.has(reg)) {
      const r = reg.getBoundingClientRect();
      let name = regionName(reg);
      if (usedNames.has(name)) name = `${name} (${desc(reg)})`;
      usedNames.add(name);
      regions.set(reg, { name, y: Math.round(r.top + sy), h: Math.round(r.height), gaps: {}, misses: [], notes: [] });
    }
    return regions.get(reg);
  };
  for (const p of pairs) {
    const e = regionEntry(p.parent);
    const k = Math.round(p.ink);
    if (p.ink > TOL) e.gaps[k] = (e.gaps[k] || 0) + 1;
  }
  for (const m of misses) {
    const anchor = m.pair ? m.pair.parent : m.box.el;
    const { pair, also, box, ...rest } = m;
    regionEntry(anchor).misses.push(rest);
  }

  // entrelinha: o mesmo espaço de código aparecendo com valores diferentes na tela
  for (const [reg, e] of regions) {
    const byBox = new Map();
    for (const p of pairs) {
      if (regionOf(p.parent) !== reg || p.box <= TOL || p.elastic) continue;
      const k = Math.round(p.box);
      if (!byBox.has(k)) byBox.set(k, []);
      byBox.get(k).push(p.ink);
    }
    let worst = null;
    for (const [boxGap, inks] of byBox) {
      if (inks.length < 2) continue;
      const spread = Math.max(...inks) - Math.min(...inks);
      if (spread >= 4 && (!worst || spread > worst.spread))
        worst = { boxGap, spread, min: Math.round(Math.min(...inks)), max: Math.round(Math.max(...inks)), n: inks.length };
    }
    if (worst) {
      const note = {
        kind: "entrelinha",
        text: `o mesmo espaço de código, ${worst.boxGap}px, aparece na tela entre ${worst.min} e ${worst.max}px (${worst.n} pares)`,
      };
      e.notes.push(note);
      notes.push({ region: e.name, ...note });
    }
  }

  // ---------- desenho ----------
  if (draw) {
    const layer = document.createElement("div");
    layer.setAttribute("data-ritmo", "");
    Object.assign(layer.style, {
      position: "absolute",
      left: "0",
      top: "0",
      width: `${document.documentElement.scrollWidth}px`,
      height: `${document.documentElement.scrollHeight}px`,
      pointerEvents: "none",
      zIndex: 2147483646,
    });
    document.body.appendChild(layer);

    const PALETTE = ["59,130,246", "16,185,129", "245,158,11", "168,85,247", "236,72,153", "20,184,166", "249,115,22", "99,102,241", "132,204,22", "6,182,212"];
    const values = [...new Set(pairs.filter((p) => p.ink > TOL).map((p) => Math.round(p.ink)))].sort((a, b) => a - b);
    const colour = (v) => PALETTE[values.indexOf(Math.round(v)) % PALETTE.length];
    const missed = new Set(misses.flatMap((m) => [m.pair, m.also].filter(Boolean)));

    const label = (text, x, y, bg) => {
      const d = document.createElement("div");
      d.textContent = text;
      Object.assign(d.style, {
        position: "absolute",
        left: `${x}px`,
        top: `${y}px`,
        transform: "translateY(-50%)",
        font: "600 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace",
        color: "#fff",
        background: bg,
        padding: "2px 4px",
        borderRadius: "3px",
        whiteSpace: "nowrap",
      });
      layer.appendChild(d);
    };
    const band = (top, bottom, left, right, rgb, alpha, outline) => {
      const d = document.createElement("div");
      Object.assign(d.style, {
        position: "absolute",
        left: `${left + sx}px`,
        top: `${top + sy}px`,
        width: `${Math.max(1, right - left)}px`,
        height: `${Math.max(1, bottom - top)}px`,
        background: `rgba(${rgb},${alpha})`,
        outline: outline ? "1.5px solid rgba(239,68,68,0.95)" : "none",
        outlineOffset: "-1px",
      });
      layer.appendChild(d);
    };

    if (opts.ink)
      for (const p of pairs)
        for (const r of [p.aInk, p.bInk]) {
          const d = document.createElement("div");
          Object.assign(d.style, {
            position: "absolute",
            left: `${r.left + sx}px`,
            top: `${r.top + sy}px`,
            width: `${r.right - r.left}px`,
            height: `${r.bottom - r.top}px`,
            outline: "1px dotted rgba(239,68,68,0.6)",
          });
          layer.appendChild(d);
        }

    for (const p of pairs) {
      if (p.ink <= TOL) continue;
      const rgb = colour(p.ink);
      const bad = missed.has(p);
      band(p.aInk.bottom, p.bInk.top, p.left, p.right, rgb, bad ? 0.35 : 0.22, bad);
      label(`${Math.round(p.ink)}`, p.right + sx + 2, (p.aInk.bottom + p.bInk.top) / 2 + sy, `rgba(${rgb},0.95)`);
    }
    for (const m of misses) {
      if (m.kind !== "caixa") continue;
      const { r, top, bottom } = m.box;
      band(r.top, r.top + top, r.left, r.right, "239,68,68", 0.25, false);
      band(r.bottom - bottom, r.bottom, r.left, r.right, "239,68,68", 0.25, false);
      label(`${Math.round(top)}/${Math.round(bottom)}`, r.right + sx + 2, r.top + r.height / 2 + sy, "rgba(239,68,68,0.95)");
    }
  }

  return {
    scale,
    viewport: { w: innerWidth, h: innerHeight },
    regions: [...regions.values()].sort((a, b) => a.y - b.y),
    notes,
    pairs: pairs.map((p) => ({
      y: yOf(p),
      x: Math.round(p.left + sx),
      w: Math.round(p.right - p.left),
      ink: p.ink,
      box: p.box,
      from: desc(p.a),
      to: desc(p.b),
      parent: desc(p.parent),
      elastic: p.elastic || undefined,
      divided: p.divided || undefined,
    })),
  };
};
