// Pacotes de um monorepo (npm/yarn/bun workspaces e pnpm-workspace.yaml) e detecção de framework.
import path from 'node:path';
import { globToRegExp } from './util.mjs';

const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** Padrões de workspace da raiz. tree: { list(), read(p) } (ver tree.mjs). */
export function workspacePatterns(tree) {
  const pkg = parse(tree.read('package.json') ?? '') ?? {};
  const patterns = [];
  if (Array.isArray(pkg.workspaces)) patterns.push(...pkg.workspaces);
  else if (Array.isArray(pkg.workspaces?.packages)) patterns.push(...pkg.workspaces.packages);
  const pnpm = tree.read('pnpm-workspace.yaml');
  if (pnpm) {
    let inPackages = false;
    for (const line of pnpm.split('\n')) {
      if (/^packages\s*:/.test(line)) inPackages = true;
      else if (/^\S/.test(line)) inPackages = false;
      else if (inPackages) {
        const m = /^\s*-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/.exec(line);
        if (m) patterns.push(m[1].trim());
      }
    }
  }
  return patterns;
}

/** Lista os pacotes do workspace: [{ name, dir, pkg }], dir relativo à raiz do repo. */
export function readWorkspaces(tree) {
  const patterns = workspacePatterns(tree);
  if (!patterns.length) return [];
  // globToRegExp casa a pasta e tudo dentro dela; aqui queremos a pasta exata do pacote.
  const dirGlob = (p) => new RegExp(globToRegExp(p.replace(/^\.\//, '').replace(/\/$/, '')).source.replace(/\(\?:\/\.\*\)\?\$$/, '$'));
  const include = patterns.filter((p) => !p.startsWith('!')).map(dirGlob);
  const exclude = patterns.filter((p) => p.startsWith('!')).map((p) => dirGlob(p.slice(1)));
  const pkgFiles = tree.list().filter((f) => f.endsWith('/package.json') && !f.includes('node_modules/'));
  const contents = tree.readMany(pkgFiles);
  const out = [];
  for (const f of pkgFiles) {
    const dir = path.posix.dirname(f);
    if (!include.some((re) => re.test(dir)) || exclude.some((re) => re.test(dir))) continue;
    const pkg = parse(contents.get(f) ?? '');
    if (pkg?.name) out.push({ name: pkg.name, dir, pkg });
  }
  return out;
}

/** Framework de um package.json, pelo nome das dependências. */
export function frameworkOf(pkg) {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  if (deps.next) return 'next';
  if (deps['@sveltejs/kit']) return 'sveltekit';
  if (deps.astro) return 'astro';
  if (deps.nuxt) return 'nuxt';
  if (deps['@remix-run/dev'] || deps['@react-router/dev']) return 'remix';
  if (deps.vite) return 'vite';
  return null;
}
