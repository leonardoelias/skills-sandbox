export const markerFor = (id = 'default') => `<!-- visual-diff:sticky id=${id} -->`;

export const COMMENT_LIMIT = 65_536; // limite do GitHub para o corpo de um comentário

const groupBy = (arr, fn) => arr.reduce((m, x) => m.set(fn(x), [...(m.get(fn(x)) ?? []), x]), new Map());
const signed = (n) => (n > 0 ? `+${n}` : String(n));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const where = (i) => `${i.viewport}/${i.theme}`;

/** Frase sobre deslocamentos: "o conteúdo abaixo de y≈420px desceu 24px". */
export function shiftPhrase(i) {
  const parts = [];
  for (const s of (i.shifts ?? []).slice(0, 3)) parts.push(`o conteúdo abaixo de y≈${s.fromYCss}px ${s.byCss > 0 ? 'desceu' : 'subiu'} ${Math.abs(s.byCss)}px`);
  if ((i.shifts ?? []).length > 3) parts.push(`e mais ${i.shifts.length - 3} deslocamento(s)`);
  if (!parts.length && i.heightDeltaCss) parts.push(`a altura da página mudou ${signed(i.heightDeltaCss)}px`);
  return parts.join('; ');
}

const describeItem = (i) => {
  if (i.status === 'added') return `${where(i)}: página nova`;
  if (i.status === 'removed') return `${where(i)}: página removida`;
  if (i.kind === 'layout-shift') return `${where(i)}: só espaçamento (${shiftPhrase(i) || 'layout'})`;
  return `${where(i)} ${i.changedPercent}%`;
};

/** Resumo automático, baseado só em números (usado no CI e como ponto de partida para o agente). */
export function autoSummary(report) {
  const lines = ['**O que mudou**'];
  const changed = report.items.filter((i) => i.changed);
  if (changed.length === 0) lines.push('- Nenhuma diferença visual nas capturas.');
  for (const [route, items] of groupBy(changed, (i) => i.route)) {
    const content = items.find((i) => i.kind === 'content' && i.shifts?.length);
    const extra = content ? `; além disso, ${shiftPhrase(content)} (${where(content)}) e isso não conta como alteração` : '';
    lines.push(`- \`${route}\`: ${items.map(describeItem).join(', ')}${extra}.`);
  }
  for (const v of report.variants ?? []) lines.push(`- \`${v.route}\`: ${v.values.length} variante(s) de \`${v.param}\` capturadas (${v.viewport}/${v.theme}).`);

  const look = [];
  for (const i of report.items) {
    if (!i.changed || i.status !== 'changed') continue;
    const others = report.items.filter((o) => o.route === i.route && o.theme === i.theme && o.viewport !== i.viewport);
    if (others.length && others.every((o) => !o.changed)) look.push(`\`${i.route}\` só mudou em ${i.viewport} (${i.theme}).`);
  }
  for (const i of report.items) {
    if (i.a11y?.added?.length) look.push(`\`${i.route}\` (${where(i)}): ${i.a11y.added.length} problema(s) de acessibilidade novo(s) (${[...new Set(i.a11y.added.map((v) => v.id))].slice(0, 4).join(', ')}).`);
    if (i.tokens?.length) look.push(`\`${i.route}\` (${where(i)}): ${i.tokens.length} valor(es) fora dos design tokens nas regiões alteradas.`);
  }
  for (const m of report.motion ?? []) if (m.changed) look.push(`\`${m.route}\`: o movimento mudou (veja o GIF).`);
  for (const w of report.warnings) look.push(w);
  for (const f of report.failed) look.push(`Falha ao capturar \`${f.key}\` (base: ${f.base}; head: ${f.head}).`);
  if (look.length) lines.push('', '**Vale olhar**', ...look.map((l) => `- ${l}`));

  const nc = [
    ...report.notCaptured.map((n) => `\`${n.route}\` (${n.reason})`),
    ...report.unmatchedFiles.map((f) => `\`${f}\` (sem rota)`),
    ...(report.unmatchedMaybe ?? []).map((f) => `\`${f}\` (talvez UI, sem rota)`),
  ];
  if (nc.length) lines.push('', `**Não verificado:** ${nc.join(', ')}.`);
  return lines.join('\n') + '\n';
}

/**
 * Corpo do comentário. link(relPath) devolve a URL (ou caminho local) de cada imagem; null = sem imagens.
 * tier: 0 completo; 1 sem recortes; 2 sem imagens (só links); 3 truncado.
 */
export function renderComment(report, summary, { link, markerId = 'default', stale = false, tier = 0 } = {}) {
  const s = report.stats;
  const out = [markerFor(markerId), '## 🖼️ visual-diff', ''];
  const sides = report.sides;
  out.push(`**Base:** \`${sides.base.label}\` → **Head:** \`${sides.head.label}\``);
  const counts = [`**${s.changed} com diferença**`, `${s.unchanged} sem diferença`];
  if (s.added) counts.push(`${s.added} página(s) nova(s)`);
  if (s.removed) counts.push(`${s.removed} removida(s)`);
  if (s.failed) counts.push(`${s.failed} com falha`);
  out.push(`${s.captures} captura(s): ${counts.join(', ')}.`);
  if (stale) out.push('', '> ⚠️ Este relatório é de uma execução anterior ao último commit do PR.');
  out.push('', summary.trim(), '');

  const img = (p, alt) => (tier >= 2 ? `[${esc(alt)}](${link(p)})` : `<img src="${link(p)}" alt="${esc(alt)}">`);
  const changed = report.items.filter((i) => i.changed && i.status === 'changed').sort((a, b) => b.changedPercent - a.changedPercent || (b.shifts?.length ?? 0) - (a.shifts?.length ?? 0));
  const added = report.items.filter((i) => i.status === 'added');
  const removed = report.items.filter((i) => i.status === 'removed');

  if (link && tier < 3) {
    for (const i of changed) {
      const head = i.kind === 'layout-shift' ? `só espaçamento — ${esc(shiftPhrase(i))}` : `${i.changedPercent}% dos pixels`;
      out.push(`<details${i === changed[0] ? ' open' : ''}><summary><b>${esc(i.route)}</b> · ${i.viewport} · ${i.theme} — ${head}</summary>`, '');
      if (i.regionsTotal > (i.focus?.length ?? 0)) out.push(`<sub>${i.focus?.length ?? 0} de ${i.regionsTotal} regiões alteradas em destaque${i.regionsSkipped ? ` (${i.regionsSkipped} grande(s) demais para recorte; veja a página inteira)` : ''}.</sub>`, '');
      if (tier === 0) for (const f of i.focus ?? []) out.push(img(f, `Região alterada em ${i.route} (${where(i)}): antes, depois e diff`), '');
      if (i.truncated) out.push(`<sub>A página passa de capture.maxHeight; a captura foi cortada.</sub>`, '');
      out.push(`<details${tier > 0 || !(i.focus?.length) ? ' open' : ''}><summary>Página inteira</summary>`, '', img(i.compare, `Página inteira ${i.route} (${where(i)}): antes, depois e diff`), '', '</details>', '');
      if (i.a11y && (i.a11y.added.length || i.a11y.resolved.length)) out.push(a11yBlock(i.a11y), '');
      if (i.tokens?.length) out.push(tokensBlock(i.tokens), '');
      out.push('</details>', '');
    }
    if (added.length) {
      out.push('### Páginas novas', '');
      for (const i of added) out.push(`<details><summary><b>${esc(i.route)}</b> · ${where(i)}</summary>`, '', img(i.compare, `Página nova ${i.route} (${where(i)})`), '', '</details>', '');
    }
    if (removed.length) {
      out.push('### Páginas removidas', '');
      for (const i of removed) out.push(`<details><summary><b>${esc(i.route)}</b> · ${where(i)}</summary>`, '', img(i.compare, `Página removida ${i.route} (${where(i)}), como era antes`), '', '</details>', '');
    }
    const motion = (report.motion ?? []).filter((m) => m.file);
    if (motion.length && tier < 2) {
      out.push('### Movimento', '');
      for (const m of motion) out.push(`<details${m.changed ? ' open' : ''}><summary><b>${esc(m.route)}</b> · ${m.viewport}${m.changed ? ' — mudou' : ' — igual'}</summary>`, '', img(m.file, `Movimento em ${m.route}: antes e depois`), '', '</details>', '');
    }
    for (const v of report.variants ?? []) {
      out.push(`### Variantes de \`${esc(v.param)}\` em ${esc(v.route)}`, '');
      if (v.file) out.push(img(v.file, `Variantes ${v.param} em ${v.route}`), '');
      out.push('| Variante | Escolha |', '|---|---|', ...v.values.map((val) => `| \`${esc(v.param)}=${esc(val)}\` | - [ ] |`), '');
      if (v.failed?.length) out.push(`<sub>Falharam: ${v.failed.map((f) => `\`${esc(f)}\``).join(', ')}</sub>`, '');
    }
  } else if (changed.length || added.length || removed.length) {
    out.push(tier >= 3 ? '_Imagens omitidas: o comentário passaria do limite do GitHub. Veja o artefato ou rode `render` localmente._' : '_Imagens não enviadas (modo só texto)._', '');
    for (const i of [...changed, ...added, ...removed]) out.push(`- \`${i.route}\` ${describeItem(i)}`);
    out.push('');
  }

  const unchanged = report.items.filter((i) => !i.changed);
  if (unchanged.length) out.push(`<sub>Sem diferença: ${unchanged.map((i) => `\`${i.route}\` ${where(i)}`).join(', ')}</sub>`, '');
  out.push(`<sub>Gerado por visual-diff em ${report.createdAt.slice(0, 16).replace('T', ' ')} UTC. Reexecuções editam este comentário.</sub>`);
  return out.join('\n') + '\n';
}

/** Escolhe o nível mais completo que cabe no limite do GitHub; no último caso, trunca com uma nota. */
export function renderCommentFitting(report, summary, opts) {
  for (const tier of [0, 1, 2, 3]) {
    const body = renderComment(report, summary, { ...opts, tier });
    if (body.length <= COMMENT_LIMIT - 512) return { body, tier };
  }
  const body = renderComment(report, summary, { ...opts, tier: 3 });
  const note = '\n\n_…comentário truncado para caber no limite do GitHub._\n';
  return { body: body.slice(0, COMMENT_LIMIT - note.length - 16) + note, tier: 4 };
}

function a11yBlock(d) {
  const row = (v) => `| ${v.impact} | \`${esc(v.id)}\` | ${esc(v.help)} | \`${esc(v.target).slice(0, 80)}\` |`;
  const out = ['<details><summary>Acessibilidade (axe)</summary>', ''];
  if (d.added.length) out.push(`**Novos (${d.added.length})**`, '', '| Impacto | Regra | O que é | Onde |', '|---|---|---|---|', ...d.added.slice(0, 15).map(row), '');
  if (d.resolved.length) out.push(`**Resolvidos (${d.resolved.length})**`, '', '| Impacto | Regra | O que é | Onde |', '|---|---|---|---|', ...d.resolved.slice(0, 10).map(row), '');
  out.push('</details>');
  return out.join('\n');
}

function tokensBlock(findings) {
  const row = (f) => `| ${f.kind === 'color' ? 'cor' : 'espaçamento'} | \`${esc(f.selector).slice(0, 60)}\` | \`${esc(f.prop)}: ${esc(f.value)}\` | ${f.nearest ? `\`${esc(f.nearest.name)}\` (${esc(f.nearest.value)})` : '—'} |`;
  return ['<details><summary>Fora dos design tokens</summary>', '', '| Tipo | Elemento | Valor | Token mais próximo |', '|---|---|---|---|', ...findings.slice(0, 15).map(row), '', '</details>'].join('\n');
}
