// Grafo de imports montado numa passada: lista os arquivos, extrai os especificadores, resolve
// caminhos relativos, aliases (tsconfig paths, detect.aliases, #imports) e pacotes do workspace,
// e guarda o mapa reverso (arquivo → quem o importa).
import path from 'node:path';
import { stripJsonComments } from './util.mjs';
import { readWorkspaces } from './workspace.mjs';

const P = path.posix;
const JS_EXT = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'];
const STYLE_EXT = ['.css', '.scss', '.sass', '.less'];
const MULTI_EXT = ['.vue', '.svelte', '.astro', '.html', '.mdx', '.md'];
export const SOURCE_EXT = [...JS_EXT, ...STYLE_EXT, ...MULTI_EXT];
const RESOLVE_EXT = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte', '.astro', '.mdx', '.css', '.scss', '.sass', '.less', '.json'];
const SKIP_DIRS = /(^|\/)(node_modules|dist|build|out|coverage|\.next|\.svelte-kit|\.output|\.nuxt|\.astro|\.turbo|\.vercel|storybook-static)\//;

const RE_JS_STATIC = /(?:^|[^\w$.])(?:import|export)\s*(?:type\s+)?(?:[\w*{}\s,$]+?\s*from\s*)?['"]([^'"\n]+)['"]/g;
const RE_JS_DYNAMIC = /\b(?:import|require)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;
const RE_CSS_IMPORT = /@(?:import|use|forward)\s+(?:url\(\s*)?['"]?([^'")\s;]+)['"]?/g;
const RE_CSS_URL = /url\(\s*['"]?([^'")\s]+)['"]?\s*\)/g;
const RE_HTML = /\b(?:src|href)\s*=\s*['"]([^'"]+)['"]/g;

/** Especificadores importados por um arquivo, conforme a extensão. */
export function extractSpecifiers(text, ext) {
  const out = new Set();
  const grab = (re) => {
    re.lastIndex = 0;
    for (let m; (m = re.exec(text)); ) out.add(m[1]);
  };
  const isJs = JS_EXT.includes(ext) || MULTI_EXT.includes(ext);
  const isStyle = STYLE_EXT.includes(ext) || MULTI_EXT.includes(ext);
  if (isJs) {
    grab(RE_JS_STATIC);
    grab(RE_JS_DYNAMIC);
  }
  if (isStyle) {
    grab(RE_CSS_IMPORT);
    grab(RE_CSS_URL);
  }
  if (MULTI_EXT.includes(ext)) grab(RE_HTML);
  return [...out].filter((s) => s && !/^(?:[a-z]+:|\/\/|#$|data:|mailto:|\{)/i.test(s) && !s.includes('${'));
}

/**
 * Monta o grafo de um lado. tree: { list(), readMany() } (ver tree.mjs).
 * opts: { appDir, staticDir, aliases } (appDir e staticDir relativos à raiz do repo / ao appDir).
 */
export function buildGraph(tree, { appDir = '.', staticDir = null, aliases = {} } = {}) {
  const all = tree.list();
  const files = new Set(all);
  const sources = all.filter((f) => SOURCE_EXT.includes(P.extname(f).toLowerCase()) && !SKIP_DIRS.test(f));
  const contents = tree.readMany(sources);
  const configs = new Map(all.filter((f) => /(^|\/)(tsconfig|jsconfig)\.json$/.test(f)).map((f) => [f, null]));
  const pkgJsonFiles = all.filter((f) => /(^|\/)package\.json$/.test(f) && !f.includes('node_modules/'));
  const pkgJson = tree.readMany(pkgJsonFiles);
  const workspaces = readWorkspaces(tree);
  const appRoot = appDir === '.' ? '' : appDir;

  // ---- resolução de arquivo -------------------------------------------------------------------
  const tryFile = (p) => {
    p = P.normalize(p).replace(/^\.\//, '');
    if (p.startsWith('../')) return null;
    if (files.has(p)) return p;
    const ext = P.extname(p);
    // TS em ESM importa "./x.js" apontando para x.ts.
    if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
      const stem = p.slice(0, -ext.length);
      for (const e of ['.ts', '.tsx', '.mts', '.cts']) if (files.has(stem + e)) return stem + e;
    }
    for (const e of RESOLVE_EXT) if (files.has(p + e)) return p + e;
    for (const e of RESOLVE_EXT) if (files.has(`${p}/index${e}`)) return `${p}/index${e}`;
    // Parciais do Sass: _nome.scss e pasta/_index.scss.
    const dir = P.dirname(p);
    const base = P.basename(p);
    for (const e of ['.scss', '.sass', '']) {
      const cand = P.join(dir, `_${base}${e}`);
      if (files.has(cand)) return cand;
      if (files.has(`${p}/_index${e || '.scss'}`)) return `${p}/_index${e || '.scss'}`;
    }
    return null;
  };

  // ---- tsconfig / jsconfig (paths, baseUrl, extends) ------------------------------------------
  const readConfig = (file, depth = 0) => {
    if (configs.get(file)) return configs.get(file);
    let json = null;
    try {
      json = JSON.parse(stripJsonComments(tree.read(file) ?? ''));
    } catch {
      json = null;
    }
    const dir = P.dirname(file);
    let resolved = { paths: null, pathsBase: dir, baseUrl: null };
    const exts = [].concat(json?.extends ?? []);
    for (const ext of exts) {
      if (depth > 5 || typeof ext !== 'string' || !ext.startsWith('.')) continue;
      let parent = P.normalize(P.join(dir, ext));
      if (!parent.endsWith('.json')) parent += '.json';
      if (files.has(parent)) {
        const pc = readConfig(parent, depth + 1);
        resolved = { ...resolved, ...pc };
      }
    }
    const co = json?.compilerOptions ?? {};
    if (co.baseUrl !== undefined) resolved.baseUrl = P.normalize(P.join(dir, co.baseUrl));
    if (co.paths) resolved = { ...resolved, paths: co.paths, pathsBase: co.baseUrl !== undefined ? P.normalize(P.join(dir, co.baseUrl)) : dir };
    configs.set(file, resolved);
    return resolved;
  };
  const configCache = new Map();
  const nearestConfig = (fromDir) => {
    if (configCache.has(fromDir)) return configCache.get(fromDir);
    let dir = fromDir;
    let found = null;
    for (;;) {
      for (const name of ['tsconfig.json', 'jsconfig.json']) {
        const f = dir === '.' || dir === '' ? name : `${dir}/${name}`;
        if (configs.has(f)) {
          found = readConfig(f);
          break;
        }
      }
      if (found || dir === '.' || dir === '') break;
      dir = P.dirname(dir);
    }
    configCache.set(fromDir, found);
    return found;
  };

  const nearestPkg = (fromDir) => {
    let dir = fromDir;
    for (;;) {
      const f = dir === '.' || dir === '' ? 'package.json' : `${dir}/package.json`;
      if (pkgJson.has(f)) {
        try {
          return { dir: dir === '' ? '.' : dir, json: JSON.parse(pkgJson.get(f) ?? '') };
        } catch {
          return null;
        }
      }
      if (dir === '.' || dir === '') return null;
      dir = P.dirname(dir);
    }
  };

  // Mapeia "./*" e "#x/*" com curinga.
  const matchPattern = (map, key) => {
    if (map[key] !== undefined) return [map[key]];
    for (const [pat, target] of Object.entries(map)) {
      const star = pat.indexOf('*');
      if (star < 0) continue;
      const pre = pat.slice(0, star);
      const post = pat.slice(star + 1);
      if (key.startsWith(pre) && key.endsWith(post) && key.length >= pre.length + post.length) {
        const mid = key.slice(pre.length, key.length - post.length);
        return [].concat(target).map((t) => pickCondition(t)).filter(Boolean).map((t) => t.replace('*', mid));
      }
    }
    return null;
  };
  const pickCondition = (t) => {
    if (typeof t === 'string') return t;
    if (Array.isArray(t)) return t.map(pickCondition).find(Boolean) ?? null;
    if (t && typeof t === 'object') {
      for (const k of ['source', 'svelte', 'import', 'module', 'browser', 'default', 'require', 'node']) if (t[k]) return pickCondition(t[k]);
    }
    return null;
  };
  // Pacotes publicados apontam para dist/; o código-fonte costuma estar em src/.
  const fromBuilt = (dir, target) => {
    const t = target.replace(/^\.\//, '');
    const direct = tryFile(P.join(dir, t));
    if (direct) return direct;
    const swapped = t.replace(/^(dist|build|lib|esm|cjs)\//, 'src/').replace(/\.(m|c)?js$|\.d\.ts$/, '');
    return tryFile(P.join(dir, swapped));
  };

  const resolveWorkspace = (spec) => {
    const ws = workspaces.find((w) => spec === w.name || spec.startsWith(w.name + '/'));
    if (!ws) return null;
    const sub = spec.slice(ws.name.length).replace(/^\//, '');
    const exp = ws.pkg.exports;
    if (exp !== undefined) {
      const map = typeof exp === 'string' || Array.isArray(exp) || !Object.keys(exp).some((k) => k.startsWith('.')) ? { '.': exp } : exp;
      const key = sub ? `./${sub}` : '.';
      const targets = matchPattern(map, key)?.map((t) => (typeof t === 'string' ? t : pickCondition(t))).filter(Boolean);
      for (const t of targets ?? []) {
        const hit = fromBuilt(ws.dir, t);
        if (hit) return hit;
      }
    }
    if (sub) return tryFile(P.join(ws.dir, sub)) ?? tryFile(P.join(ws.dir, 'src', sub));
    for (const field of ['source', 'svelte', 'module', 'main']) {
      if (typeof ws.pkg[field] === 'string') {
        const hit = fromBuilt(ws.dir, ws.pkg[field]);
        if (hit) return hit;
      }
    }
    return tryFile(P.join(ws.dir, 'src/index')) ?? tryFile(P.join(ws.dir, 'index'));
  };

  const resolve = (spec, from) => {
    spec = spec.replace(/[?#].*$/, '');
    if (spec.startsWith('~')) spec = spec.slice(1); // convenção do webpack para pacotes em CSS
    if (!spec) return null;
    const fromDir = P.dirname(from);
    if (spec.startsWith('.')) return tryFile(P.join(fromDir, spec));
    // Em CSS/Sass e HTML, um caminho sem ./ também é relativo ao arquivo.
    const fromExt = P.extname(from).toLowerCase();
    if ((STYLE_EXT.includes(fromExt) || fromExt === '.html') && !spec.startsWith('/')) {
      const hit = tryFile(P.join(fromDir, spec));
      if (hit) return hit;
    }
    if (spec.startsWith('/')) {
      const roots = [];
      if (staticDir !== null) roots.push(P.join(appRoot, staticDir));
      roots.push(P.join(appRoot, 'public'), appRoot || '.');
      for (const r of roots) {
        const hit = tryFile(P.join(r, spec.slice(1)));
        if (hit) return hit;
      }
      return null;
    }
    if (spec.startsWith('#')) {
      const pkg = nearestPkg(fromDir);
      const targets = pkg?.json?.imports ? matchPattern(pkg.json.imports, spec) : null;
      for (const t of targets?.map(pickCondition).filter(Boolean) ?? []) {
        const hit = t.startsWith('.') ? fromBuilt(pkg.dir, t) : resolve(t, from);
        if (hit) return hit;
      }
      return null;
    }
    for (const [key, target] of Object.entries(aliases)) {
      if (spec === key || spec.startsWith(key.endsWith('/') ? key : key + '/')) {
        const rest = spec.slice(key.length).replace(/^\//, '');
        const hit = tryFile(P.join(appRoot, target, rest));
        if (hit) return hit;
      }
    }
    const tc = nearestConfig(fromDir);
    if (tc?.paths) {
      const targets = matchPattern(tc.paths, spec);
      for (const t of targets ?? []) {
        const hit = tryFile(P.join(tc.pathsBase, t));
        if (hit) return hit;
      }
    }
    const ws = resolveWorkspace(spec);
    if (ws) return ws;
    if (tc?.baseUrl) return tryFile(P.join(tc.baseUrl, spec));
    // SvelteKit: $lib aponta para src/lib.
    if (spec === '$lib' || spec.startsWith('$lib/')) return tryFile(P.join(appRoot, 'src/lib', spec.slice(5)));
    return null;
  };

  // ---- mapa reverso ----------------------------------------------------------------------------
  const importers = new Map();
  for (const f of sources) {
    const text = contents.get(f);
    if (!text) continue;
    for (const spec of extractSpecifiers(text, P.extname(f).toLowerCase())) {
      const target = resolve(spec, f);
      if (!target || target === f) continue;
      let set = importers.get(target);
      if (!set) importers.set(target, (set = new Set()));
      set.add(f);
    }
  }

  return {
    files,
    resolve,
    importersOf: (f) => importers.get(f) ?? new Set(),
    edges: () => importers,
  };
}

/**
 * BFS reverso a partir de `file` até achar entradas (classify devolve não-nulo), no máximo maxDepth níveis.
 * Devolve [{ entry, scope, via: [cadeia de arquivos] }].
 */
export function reachEntries(graph, file, classify, maxDepth = 6) {
  const found = [];
  const seen = new Set([file]);
  let frontier = [[file]];
  for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
    const next = [];
    for (const chain of frontier) {
      for (const imp of graph.importersOf(chain[chain.length - 1])) {
        if (seen.has(imp)) continue;
        seen.add(imp);
        const scope = classify(imp);
        if (scope) found.push({ entry: imp, scope, via: [...chain, imp] });
        else next.push([...chain, imp]);
      }
    }
    frontier = next;
  }
  return found;
}
