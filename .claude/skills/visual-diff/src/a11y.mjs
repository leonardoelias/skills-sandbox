// Delta de acessibilidade com axe-core: o que o head introduziu e o que resolveu em relação ao base.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
const IMPACT = { critical: 4, serious: 3, moderate: 2, minor: 1 };

/** Roda o axe na página (já carregada). Devolve [{ id, impact, help, helpUrl, target, html }], um por nó. */
export async function runAxe(page) {
  await page.addScriptTag({ path: AXE_PATH });
  const results = await page.evaluate(async (tags) => {
    // eslint-disable-next-line no-undef
    const r = await axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] });
    return r.violations.flatMap((v) =>
      v.nodes.map((n) => ({
        id: v.id,
        impact: n.impact ?? v.impact ?? 'minor',
        help: v.help,
        helpUrl: v.helpUrl,
        target: n.target.map((t) => (Array.isArray(t) ? t.join(' ') : t)).join(' >>> '),
        html: (n.html ?? '').slice(0, 160),
      })),
    );
  }, TAGS);
  return results;
}

const keyOf = (v) => `${v.id}|${v.target}`;

/**
 * Compara as violações do base e do head pela regra + seletor.
 * Devolve { added, resolved, unchanged } (added/resolved ordenados por gravidade).
 */
export function a11yDelta(before = [], after = []) {
  const b = new Map(before.map((v) => [keyOf(v), v]));
  const a = new Map(after.map((v) => [keyOf(v), v]));
  const byImpact = (x, y) => (IMPACT[y.impact] ?? 0) - (IMPACT[x.impact] ?? 0) || x.id.localeCompare(y.id);
  const added = [...a].filter(([k]) => !b.has(k)).map(([, v]) => v).sort(byImpact);
  const resolved = [...b].filter(([k]) => !a.has(k)).map(([, v]) => v).sort(byImpact);
  return { added, resolved, unchanged: [...a.keys()].filter((k) => b.has(k)).length };
}
