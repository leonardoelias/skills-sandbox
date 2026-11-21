import path from 'node:path';
import { discoverRoutes, dynamicMatcher, fileToScope, isDynamic, staticDirOf } from './config.mjs';
import { changedEntries } from './git.mjs';
import { buildGraph, reachEntries } from './imports.mjs';
import { commitTree, workingTree } from './tree.mjs';
import { matchesAny } from './util.mjs';
import { readWorkspaces } from './workspace.mjs';

// .js/.ts fora de pastas de interface podem ser só backend: contam como "talvez UI".
const MAYBE_EXT = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'];
const UI_DIRS = /(^|\/)(components?|ui|styles?|css|theme|themes|app|pages|routes|layouts?|views|templates|public|assets|static|icons|design-system)\//;

/**
 * Mapeia arquivos alterados para rotas. Ordem de precedência:
 * 1. routes[].files do config  2. globalFiles (todas as rotas)  3. convenções de framework (páginas,
 * layouts, arquivos globais)  4. grafo reverso de imports até uma página, layout ou arquivo global.
 * Nenhum arquivo de UI some: o que não tem rota vai para `unmatched` (certo) ou `unmatchedMaybe`.
 */
export function detect(root, cfg, sides) {
  const entries = changedEntries(root, sides);
  const appPrefix = cfg.appDir === '.' ? '' : cfg.appDir + '/';
  const staticDir = staticDirOf(cfg);
  const relToApp = (f) => (!appPrefix ? f : f.startsWith(appPrefix) ? f.slice(appPrefix.length) : null);
  const ignored = (f) => matchesAny(f, cfg.detect.ignore) || (relToApp(f) !== null && matchesAny(relToApp(f), cfg.detect.ignore));
  const ui = entries.filter((e) => cfg.detect.uiExtensions.includes(path.extname(e.path).toLowerCase()) && !ignored(e.path));

  const headTree = sides.head.workingTree ? workingTree(root) : commitTree(root, sides.head.sha);
  let baseTree = null;
  const graphs = new Map();
  const graphOf = (which) => {
    if (!graphs.has(which)) {
      const tree = which === 'head' ? headTree : (baseTree ??= commitTree(root, sides.base.sha));
      graphs.set(which, buildGraph(tree, { appDir: cfg.appDir, staticDir, aliases: cfg.detect.aliases }));
    }
    return graphs.get(which);
  };

  const configured = cfg.routes;
  let discovered = null;
  const known = () => {
    discovered ??= discoverRoutes(headTree.list(), cfg);
    return [...new Set([...configured.map((r) => r.path), ...discovered])];
  };
  // Alvos de uma mudança global: as rotas configuradas; sem elas, as descobertas; sem nada, "/".
  const globalTargets = () => {
    if (configured.length) return configured.map((r) => r.path);
    const d = known();
    return d.length ? d : ['/'];
  };
  const underPrefix = (prefix) => {
    const hits = known().filter((r) => {
      const p = r.split('?')[0];
      return p === prefix || p.startsWith(prefix.endsWith('/') ? prefix : prefix + '/');
    });
    return hits.length ? hits : isDynamic(prefix) ? [] : [prefix];
  };

  const routes = new Map(); // path → { path, reasons, confidence, change }
  const add = (route, reason, confidence, change = 'modified') => {
    const r = routes.get(route) ?? { path: route, reasons: [], confidence, change };
    if (!r.reasons.includes(reason)) r.reasons.push(reason);
    if (rank(confidence) > rank(r.confidence)) r.confidence = confidence;
    if (change !== 'modified') r.change = change;
    routes.set(route, r);
  };
  const unmatched = [];
  const unmatchedMaybe = [];
  const needsExample = [];

  // Rota dinâmica: usa um exemplo configurado (/blog/ola para /blog/[slug]) ou pede um.
  const addPage = (route, reason, confidence, file, change) => {
    if (!isDynamic(route)) return add(route, reason, confidence, change);
    const re = dynamicMatcher(route);
    const examples = configured.filter((r) => re.test(r.path.split('?')[0]));
    if (examples.length) for (const ex of examples) add(ex.path, `${reason} (exemplo de ${route})`, confidence, change);
    else if (!needsExample.some((n) => n.pattern === route)) needsExample.push({ file, pattern: route });
  };

  const applyScope = (scope, file, reason, confidence, change) => {
    if (scope.kind === 'page') addPage(scope.route, reason, confidence, file, change);
    else if (scope.kind === 'layout') for (const t of underPrefix(scope.prefix)) add(t, `${reason} (layout de ${scope.prefix})`, rank(confidence) > 1 ? 'media' : confidence);
    else if (scope.kind === 'global') for (const t of globalTargets()) add(t, `${reason} (afeta todas as rotas)`, rank(confidence) > 1 ? 'media' : confidence);
    else if (scope.kind === 'aux') for (const t of underPrefix(scope.prefix)) add(t, `${reason} (estado de carregamento/erro, pode não aparecer)`, 'baixa');
  };

  for (const e of ui) {
    const file = e.path;
    const rel = relToApp(file);
    const maybe = MAYBE_EXT.includes(path.extname(file).toLowerCase()) && !UI_DIRS.test(file);
    let placed = false;

    for (const r of configured) {
      if (matchesAny(file, r.files) || (rel !== null && matchesAny(rel, r.files))) {
        add(r.path, `${file} (routes[].files)`, 'alta');
        placed = true;
      }
    }
    if (matchesAny(file, cfg.globalFiles) || (rel !== null && matchesAny(rel, cfg.globalFiles))) {
      for (const t of globalTargets()) add(t, `${file} (globalFiles)`, 'media');
      placed = true;
    }

    const scope = rel !== null ? fileToScope(rel, { staticDir }) : null;
    if (scope) {
      const change = scope.kind === 'page' ? (e.status === 'A' ? 'added' : e.status === 'D' ? 'removed' : 'modified') : 'modified';
      applyScope(scope, file, `${file} (convenção de rota)`, 'alta', change);
      if (e.status === 'R' && e.from) {
        const old = relToApp(e.from) !== null ? fileToScope(relToApp(e.from), { staticDir }) : null;
        if (old?.kind === 'page' && old.route !== scope.route) addPage(old.route, `${e.from} → ${file} (renomeado)`, 'alta', e.from, 'removed');
      }
      placed = true;
    }

    if (!placed) {
      // Arquivo apagado: quem o importava está no base.
      const graph = graphOf(e.status === 'D' ? 'base' : 'head');
      const classify = (f) => {
        const r = relToApp(f);
        return r === null ? null : fileToScope(r, { staticDir });
      };
      const found = reachEntries(graph, file, classify, cfg.detect.maxDepth);
      for (const { scope: s, via } of found) {
        const chain = via.slice(1).join(' → ');
        applyScope(s, file, `${file} → importado por ${chain}`, maybe ? 'baixa' : 'media');
      }
      if (found.length === 0) (maybe ? unmatchedMaybe : unmatched).push(file);
    }
  }

  const sorted = [...routes.values()].sort((a, b) => rank(b.confidence) - rank(a.confidence) || b.reasons.length - a.reasons.length || a.path.localeCompare(b.path));
  const notes = [];
  if (sorted.length > cfg.detect.maxRoutes) notes.push(`${sorted.length - cfg.detect.maxRoutes} rota(s) além de detect.maxRoutes (${cfg.detect.maxRoutes}) foram cortadas; use --routes para escolher.`);
  if (!appPrefix && (unmatched.length || unmatchedMaybe.length)) {
    const ws = readWorkspaces(headTree).filter((w) => [...unmatched, ...unmatchedMaybe].some((f) => f.startsWith(w.dir + '/')));
    if (ws.length) notes.push(`Parece um monorepo (${ws.map((w) => w.dir).join(', ')}): defina appDir no config para as convenções de rota funcionarem.`);
  }
  return {
    changedFiles: entries.map((e) => e.path),
    uiFiles: ui.map((e) => e.path),
    routes: sorted.slice(0, cfg.detect.maxRoutes),
    droppedRoutes: sorted.slice(cfg.detect.maxRoutes).map((r) => r.path),
    unmatched,
    unmatchedMaybe,
    needsExample,
    notes,
  };
}

const rank = (c) => ({ baixa: 0, media: 1, alta: 2 })[c] ?? 0;
