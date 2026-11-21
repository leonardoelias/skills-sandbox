// Abre uma página no Chromium headless, roda o probe.js, salva uma captura 2x
// da página inteira com as faixas desenhadas, as medidas em JSON, e imprime
// um resumo por região.
//
//   node audit.mjs <url> <pastaDeSaída> [largura=1440] [prep.mjs]
//
// prep.mjs (opcional) exporta por padrão async (page) => {} para abrir um
// menu, trocar de aba ou entrar na conta antes de medir.
//
// Playwright: procurado em PW_DIR, depois na pasta atual, depois na skill
// visual-diff ao lado desta. Sem ele: npm i --prefix <pasta> playwright.
//
// Ambiente opcional:
//   CHROMIUM_PATH  usar um Chromium já instalado
//   SCHEME         light | dark (padrão: sem preferência)
//   SETTLE_MS      espera depois de carregar, antes de medir (padrão 1500)
//   ROOT           seletor da parte da página a medir (padrão: body)
//   IGNORE         seletores a pular (ex.: ".prose, [data-elastic]")
//   SCALE          escala em px separada por vírgula (ex.: 4,8,12,16,24,32,48)
//   STEP           ou só o passo da grade (ex.: 4)
//   INK=1          contorna a tinta medida de cada bloco
//   TAG            sufixo nos nomes dos arquivos
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [, , url, outDir, width = "1440", prepPath] = process.argv;
if (!url || !outDir) {
  console.error("uso: node audit.mjs <url> <pastaDeSaída> [largura] [prep.mjs]");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const candidates = [process.env.PW_DIR, process.cwd(), join(here, "..", "visual-diff")].filter(Boolean);
let chromium;
for (const dir of candidates) {
  try {
    ({ chromium } = createRequire(join(resolve(dir), "noop.js"))("playwright"));
    break;
  } catch {
    /* tenta o próximo */
  }
}
if (!chromium) {
  console.error(
    "Playwright não encontrado. Instale numa pasta qualquer e aponte PW_DIR para ela:\n" +
      "  npm i --prefix /tmp/ritmo-pw playwright && npx --prefix /tmp/ritmo-pw playwright install chromium\n" +
      "  PW_DIR=/tmp/ritmo-pw node audit.mjs <url> .ritmo",
  );
  process.exit(1);
}

const list = (v) => (v ? v.split(",").map((s) => +s.trim()).filter((n) => n > 0) : undefined);
const options = {
  root: process.env.ROOT || undefined,
  ignore: process.env.IGNORE || undefined,
  scale: list(process.env.SCALE),
  step: process.env.STEP ? +process.env.STEP : undefined,
  ink: process.env.INK === "1",
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({
  viewport: { width: +width, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: process.env.SCHEME || "no-preference",
});
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 240_000 });
await page.waitForTimeout(+(process.env.SETTLE_MS || 1500));
if (prepPath) {
  const prep = (await import(pathToFileURL(resolve(prepPath)).href)).default;
  await prep(page);
}
await page.evaluate(() => document.fonts.ready);
await page.addStyleTag({
  content: "*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;caret-color:transparent!important}",
});
await page.addScriptTag({ content: readFileSync(join(here, "probe.js"), "utf8") });
const result = await page.evaluate((o) => window.__ritmo(o), options);

mkdirSync(outDir, { recursive: true });
const { protocol, pathname } = new URL(url);
const target = protocol === "file:" ? pathname.split("/").pop() : pathname;
const slug = `${target.replace(/\W+/g, "-").replace(/^-|-$/g, "") || "raiz"}-${width}${process.env.TAG ? `-${process.env.TAG}` : ""}`;
writeFileSync(join(outDir, `${slug}.json`), JSON.stringify(result, null, 1));
await page.screenshot({ path: join(outDir, `${slug}.png`), fullPage: true });
await browser.close();

const { scale } = result;
const scaleText = scale.values ? `${scale.values.join(", ")}px` : `múltiplos de ${scale.step}px`;
console.log(`escala: ${scaleText} (${scale.source})`);
const LABEL = { escala: "escala", irmaos: "irmãos", proximidade: "proximidade", titulo: "título", caixa: "caixa" };
let total = 0;
for (const r of result.regions) {
  if (!r.misses.length && !r.notes.length && !Object.keys(r.gaps).length) continue;
  const gaps = Object.entries(r.gaps)
    .sort((a, b) => +a[0] - +b[0])
    .map(([v, n]) => `${v}×${n}`)
    .join("  ");
  console.log(`\n## ${r.name}  y${r.y} h${r.h}`);
  console.log(`   espaços na tinta (px×vezes): ${gaps || "-"}`);
  // A mesma falha no mesmo componente vira uma linha: "×7 (y539, y791, …)".
  const grouped = new Map();
  const soft = new Map();
  for (const m of r.misses.sort((a, b) => a.y - b.y)) {
    if (m.soft) {
      const key = `${m.gap}px ${m.where}`;
      soft.set(key, (soft.get(key) || 0) + 1);
      continue;
    }
    total++;
    const key = `${m.kind}|${m.where}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(m);
  }
  for (const list of grouped.values()) {
    const [m] = list;
    const more =
      list.length > 1
        ? ` ×${list.length} (${list
            .slice(0, 6)
            .map((x) => `y${x.y}`)
            .join(", ")}${list.length > 6 ? ", …" : ""})`
        : "";
    console.log(`   FALHA y${m.y} ${LABEL[m.kind]}${more}: ${m.text}  ${m.where}`);
  }
  if (soft.size)
    console.log(
      `   NOTA escala presumida: fora da grade de ${scale.step}px: ${[...soft]
        .map(([k, n]) => (n > 1 ? `${k} ×${n}` : k))
        .join("; ")}`,
    );
  for (const n of r.notes) console.log(`   NOTA ${n.kind}: ${n.text}`);
}
if (scale.source === "presumida")
  console.log(
    `\nO projeto não declara tokens de espaço; a grade de ${scale.step}px é um palpite e as distâncias fora dela saem como nota. Passe SCALE ou STEP para valer como falha.`,
  );
console.log(`\n${total} falha(s). captura: ${join(outDir, `${slug}.png`)}`);
