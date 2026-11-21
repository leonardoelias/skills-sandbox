import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { a11yDelta, runAxe } from './a11y.mjs';
import { buildUrl, captureKey, captureOne, contextOptions, launchBrowser, prepareContext } from './capture.mjs';
import { parseVariantValues, SKILL_VERSION } from './config.mjs';
import { detect } from './detect.mjs';
import { createComposer, diffImages, diffInWorker, readPng } from './diff.mjs';
import { addWorktree, applyWorkingTree, listWorktrees, removeWorktree, resolveSides } from './git.mjs';
import { autoSummary } from './markdown.mjs';
import { startSide } from './server.mjs';
import { CliError, ensureDir, isAlive, killGroup, log, pool, readJson, redact, registerSecret, relPath, routeSlug, serial } from './util.mjs';

export const outDirOf = (root) => path.join(root, '.visual-diff');
const stateFile = (root) => path.join(outDirOf(root), 'state.json');
const LOGIN_PATH = /\/(login|log-in|signin|sign-in|sign_in|auth|entrar|acesso|sso|oauth|session\/new|users\/sign_in)(\/|$|\?)/i;
const WT_PREFIX = 'visual-diff-wt-';
const CACHE_WT = 'visual-diff-cache';

// ---- SRV-1: estado, limpeza de órfãos e sinais ---------------------------------------------------

function syncSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function killGroupsSync(pgids) {
  const alive = pgids.filter((g) => killGroup(g, 'SIGTERM'));
  if (alive.length) syncSleep(400);
  for (const g of alive) killGroup(g, 'SIGKILL');
  return alive;
}

function removeWorktreeSync(root, dir) {
  spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: root });
  rmSync(dir, { recursive: true, force: true });
  // A pasta temporária em volta (visual-diff-wt-<pid>-…) some quando fica vazia.
  const parent = path.dirname(dir);
  try {
    if (path.basename(parent).startsWith(WT_PREFIX) && readdirSync(parent).length === 0) rmSync(parent, { recursive: true, force: true });
  } catch {}
}

/**
 * Mata servidores e remove worktrees de execuções que morreram sem limpar (kill -9, timeout do agente).
 * all: também remove as worktrees de cache (cache.worktrees).
 */
export function cleanupStale(root, { all = false } = {}) {
  const out = { killed: [], worktrees: [], stages: [] };
  const state = readJson(stateFile(root), null);
  if (state && (!isAlive(state.pid) || state.pid === process.pid)) {
    out.killed.push(...killGroupsSync(state.servers ?? []));
    for (const w of state.worktrees ?? []) {
      if (existsSync(w) && !w.includes(CACHE_WT)) {
        removeWorktreeSync(root, w);
        out.worktrees.push(w);
      }
    }
    rmSync(stateFile(root), { force: true });
  }
  const liveRun = state && isAlive(state.pid) && state.pid !== process.pid;
  if (!liveRun) {
    for (const w of listWorktrees(root)) {
      if ((w.includes(WT_PREFIX) || (all && w.includes(CACHE_WT))) && !out.worktrees.includes(w)) {
        removeWorktreeSync(root, w);
        out.worktrees.push(w);
      }
    }
    spawnSync('git', ['worktree', 'prune'], { cwd: root });
  }
  const outDir = outDirOf(root);
  if (existsSync(outDir)) {
    for (const e of readdirSync(outDir)) {
      const m = /^\.run-(\d+)$/.exec(e);
      if (m && (!isAlive(Number(m[1])) || Number(m[1]) === process.pid)) {
        rmSync(path.join(outDir, e), { recursive: true, force: true });
        out.stages.push(e);
      }
    }
  }
  if (all) rmSync(path.join(os.tmpdir(), CACHE_WT, repoHash(root)), { recursive: true, force: true });
  return out;
}

const repoHash = (root) => createHash('sha1').update(root).digest('hex').slice(0, 10);

/** Registra o que precisa ser limpo se o processo morrer, e trata SIGINT/SIGTERM/SIGHUP. */
function runGuard(root, stage) {
  const state = { pid: process.pid, startedAt: new Date().toISOString(), stage, servers: [], worktrees: [] };
  const save = () => writeFileSync(stateFile(root), JSON.stringify(state, null, 2));
  save();
  const onSignal = (sig) => {
    log(`recebi ${sig}: parando servidores e removendo worktrees…`);
    killGroupsSync(state.servers);
    for (const w of state.worktrees) if (!w.includes(CACHE_WT)) removeWorktreeSync(root, w);
    rmSync(stage, { recursive: true, force: true });
    rmSync(stateFile(root), { force: true });
    process.exit({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[sig] ?? 1);
  };
  const sigs = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const s of sigs) process.on(s, onSignal);
  return {
    addServer: (pgid) => pgid && (state.servers.push(pgid), save()),
    addWorktree: (dir) => (state.worktrees.push(dir), save()),
    done: () => {
      for (const s of sigs) process.off(s, onSignal);
      rmSync(stateFile(root), { force: true });
    },
  };
}

// ---- auth (SRV-5, CAP-3) -------------------------------------------------------------------------

const fromEnv = (where, v) => {
  const m = /^\$(\w+)$/.exec(String(v));
  if (!m) throw new CliError(`${where} deve referenciar uma variável de ambiente ("$NOME"), nunca o valor.`, { step: 'auth' });
  const val = process.env[m[1]];
  if (!val) throw new CliError(`Variável de ambiente ${m[1]} (${where}) não está definida.`, { step: 'auth' });
  registerSecret(val);
  return val;
};

/** Resolve credenciais só quando serão usadas (previews, ou auth.origins com "local"). */
export function resolveAuth(root, cfg, { usingPreviews }) {
  const origins = cfg.auth.origins ?? ['previews'];
  const used = (usingPreviews && origins.includes('previews')) || (!usingPreviews && origins.includes('local'));
  const auth = { headers: null, cookies: [], storageState: null, origins };
  if (!used) return auth;
  const headers = {};
  for (const [k, v] of Object.entries(cfg.auth.headers ?? {})) headers[k] = fromEnv(`auth.headers.${k}`, v);
  auth.headers = Object.keys(headers).length ? headers : null;
  auth.cookies = (cfg.auth.cookies ?? []).map((c, i) => ({ ...c, value: fromEnv(`auth.cookies[${i}].value`, c.value) }));
  if (cfg.auth.storageState) {
    const p = path.resolve(root, cfg.auth.storageState);
    if (!existsSync(p)) throw new CliError(`auth.storageState aponta para ${cfg.auth.storageState}, que não existe. Rode \`visual-diff login --url <url do login>\`.`, { step: 'auth' });
    try {
      for (const c of JSON.parse(readFileSync(p, 'utf8')).cookies ?? []) registerSecret(c.value);
    } catch {}
    auth.storageState = p;
  }
  return auth;
}

// ---- cache de capturas do base (PERF-3) -----------------------------------------------------------

function cacheKeyFor(cfg, sha, route, vp, theme, waitFor) {
  const relevant = { v: SKILL_VERSION, sha, route, vp, theme, waitFor, capture: cfg.capture, startCommand: cfg.startCommand, baseUrl: cfg.baseUrl, appDir: cfg.appDir, env: cfg.env, a11y: cfg.audits.a11y, auth: { origins: cfg.auth.origins, storage: !!cfg.auth.storageState } };
  return createHash('sha1').update(JSON.stringify(relevant)).digest('hex');
}

function pruneCache(dir) {
  if (!existsSync(dir)) return;
  const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    try {
      if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
    } catch {}
  }
}

// ---- execução ------------------------------------------------------------------------------------

const cssBox = (r, scale) => ({ x: Math.round(r.x / scale), y: Math.round(r.y / scale), w: Math.round(r.w / scale), h: Math.round(r.h / scale) });
const pathOf = (u) => {
  try {
    const x = new URL(u);
    return (x.pathname.replace(/\/+$/, '') || '/') + x.search;
  } catch {
    return u;
  }
};

/** Executa detect → worktrees → servidores → captura → diff → relatório. */
export async function run(root, cfg, opts = {}) {
  const out = outDirOf(root);
  ensureDir(out);
  const cleaned = cleanupStale(root);
  if (cleaned.killed.length || cleaned.worktrees.length) log(`limpei sobras de uma execução anterior: ${cleaned.killed.length} servidor(es), ${cleaned.worktrees.length} worktree(s)`);

  const sides = resolveSides(root, opts, cfg);
  const det = detect(root, cfg, sides);
  const usingPreviews = !!(opts.baseUrl || opts.headUrl);
  if (usingPreviews && !(opts.baseUrl && opts.headUrl)) throw new CliError('Passe --base-url e --head-url juntos.');

  // Rotas: --routes ganha da detecção; objetos do config trazem waitFor, variants e motion.
  const routePaths = opts.routes ?? det.routes.map((r) => r.path);
  const variantsCli = parseVariantsOpt(opts.variants);
  if (!opts.routes && routePaths.length === 0 && !variantsCli.length) {
    if (det.uiFiles.length === 0) return { status: 'no-ui-changes', sides: summarizeSides(sides), detect: det, exitCode: 0 };
    const certain = det.unmatched.length + det.needsExample.length;
    return {
      status: 'no-mapped-routes',
      sides: summarizeSides(sides),
      unmatched: det.unmatched,
      unmatchedMaybe: det.unmatchedMaybe,
      needsExample: det.needsExample,
      notes: det.notes,
      hint: certain
        ? 'Arquivos de UI sem rota: ache as páginas que os usam e passe --routes (ou mapeie em routes[].files).'
        : 'Só arquivos .js/.ts fora de pastas de interface mudaram; pode ser só backend. Se afetarem a tela, passe --routes.',
      exitCode: certain ? 2 : 0,
    };
  }
  const routeCfg = (p) => cfg.routes.find((r) => r.path === p) ?? { path: p, files: [] };
  const routes = routePaths.map(routeCfg);
  const expected = new Map(det.routes.map((r) => [r.path, r.change]));

  // Plano de capturas (com --only, só as chaves ou rotas pedidas).
  let plan = [];
  for (const r of routes) for (const vp of cfg.viewports) for (const theme of cfg.themes) plan.push({ route: r, vp, theme, key: captureKey(r.path, vp, theme) });
  if (opts.only) {
    const wanted = String(opts.only).split(',').map((s) => s.trim());
    plan = plan.filter((p) => wanted.some((w) => w === p.key || w === p.route.path || p.key.startsWith(w)));
    if (!plan.length) throw new CliError(`--only ${opts.only} não casa com nenhuma captura (chaves são rota__viewport__tema).`);
  }
  const variantJobs = collectVariants(routes, variantsCli, cfg);

  // Reaproveita o relatório anterior com --only (precisa ser dos mesmos commits).
  let previous = null;
  if (opts.only) {
    previous = readJson(path.join(out, 'report.json'), null);
    if (!previous) throw new CliError('--only precisa de um .visual-diff/report.json anterior; rode `run` completo primeiro.');
    if (previous.sides.base.sha !== sides.base.sha || previous.sides.head.sha !== sides.head.sha || sides.head.dirty) {
      throw new CliError('O relatório existente é de outro base/head (ou há mudanças locais); rode `run` completo.');
    }
  }

  const perCapture = 2.5;
  const boot = usingPreviews ? 3 : cfg.startCommand.startsWith('static:') ? 2 : 25;
  const total = plan.length * 2 + variantJobs.reduce((n, v) => n + v.values.length, 0);
  log(`${plan.length} captura(s) por lado${variantJobs.length ? ` + ${total - plan.length * 2} de variantes` : ''}; estimativa ~${Math.round(boot + (total * perCapture) / Math.max(1, cfg.capture.concurrency))} s. Rode com timeout de 10 min ou em segundo plano; o progresso fica no stderr e em .visual-diff/logs/.`);

  // PIPE-1: tudo vai para .run-<pid>/ e só substitui a saída anterior no fim, se der certo.
  const stage = path.join(out, `.run-${process.pid}`);
  rmSync(stage, { recursive: true, force: true });
  const dirs = Object.fromEntries(['before', 'after', 'compare', 'logs', 'work'].map((d) => [d, ensureDir(path.join(stage, d))]));
  const guard = runGuard(root, stage);
  const runStart = new Date();
  const runId = runStart.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const warnings = [];
  const auth = resolveAuth(root, cfg, { usingPreviews });

  // Cache do base: se todas as capturas do base estão em cache, nem sobe o servidor do base.
  const cacheDir = path.join(out, 'cache');
  const useCache = !usingPreviews && cfg.cache.base && !opts.noCache;
  if (useCache) pruneCache(cacheDir);
  const cached = new Map();
  if (useCache) {
    for (const p of plan) {
      const k = cacheKeyFor(cfg, sides.base.sha, p.route.path, p.vp, p.theme, p.route.waitFor);
      p.cacheKey = k;
      const meta = readJson(path.join(cacheDir, `${k}.json`), null);
      if (meta && existsSync(path.join(cacheDir, `${k}.png`)) && (!cfg.audits.a11y || meta.extra)) cached.set(p.key, meta);
    }
  }
  const baseNeeded = !(useCache && cached.size === plan.length) || cfg.audits.tokens || cfg.audits.motion || routes.some((r) => r.motion);

  const wtRoot = cfg.cache.worktrees ? ensureDir(path.join(os.tmpdir(), CACHE_WT, repoHash(root))) : path.join(os.tmpdir(), `${WT_PREFIX}${process.pid}-${Date.now()}`);
  const side = {
    base: { name: 'base', sha: sides.base.sha, dir: path.join(wtRoot, cfg.cache.worktrees ? `base-${sides.base.sha.slice(0, 12)}` : 'base') },
    head: {
      name: 'head',
      sha: sides.head.sha,
      dir: path.join(wtRoot, cfg.cache.worktrees && !sides.head.workingTree ? `head-${sides.head.sha.slice(0, 12)}` : `head-${process.pid}`),
    },
  };
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const reusable = (s) => cfg.cache.worktrees && !(s.name === 'head' && sides.head.workingTree) && existsSync(s.dir) && listWorktrees(root).map(real).includes(real(s.dir));

  const servers = {};
  let browser;
  let composer;
  const createdWorktrees = [];
  try {
    if (!usingPreviews) {
      for (const s of [side.base, side.head]) {
        if (s.name === 'base' && !baseNeeded) continue;
        if (reusable(s)) {
          log(`reaproveitando a worktree ${s.name} em ${s.sha.slice(0, 7)}`);
          continue;
        }
        log(`criando worktree ${s.name} em ${s.sha.slice(0, 7)}`);
        addWorktree(root, s.sha, s.dir);
        guard.addWorktree(s.dir);
        createdWorktrees.push(s.dir);
      }
      if (sides.head.workingTree && sides.head.dirty) applyWorkingTree(root, side.head.dir);
    }

    // SRV-3: os dois lados sobem ao mesmo tempo.
    const startOne = async (name, url) => {
      const srv = await startSide(root, cfg, side[name], path.join(dirs.logs, `${name}.log`), url, { onSpawn: (g) => guard.addServer(g) });
      servers[name] = srv;
      if (srv.warning) warnings.push(srv.warning);
      return srv;
    };
    const browserP = launchBrowser();
    await Promise.all([baseNeeded ? startOne('base', opts.baseUrl) : null, startOne('head', opts.headUrl), browserP.then((b) => (browser = b))]);
    composer = await createComposer(browser);
    const compose = serial();

    const captureSideOf = async (name, p) => {
      const srv = servers[name];
      const target = buildUrl(srv.url, p.route.path, p.theme);
      const onPage = cfg.audits.a11y ? (page) => runAxe(page) : undefined;
      try {
        const shot = await captureOne(browser, { target, vp: p.vp, theme: p.theme, cfg, runStart, auth, isPreview: usingPreviews, waitFor: p.route.waitFor, onPage });
        const file = path.join(name === 'base' ? dirs.before : dirs.after, `${p.key}.png`);
        if (shot.ok) writeFileSync(file, shot.png);
        const { png, ...meta } = shot;
        log(`${name}: ${p.key} (${shot.status}${shot.ok && !shot.stable ? ', instável' : ''}${shot.truncated ? ', cortada' : ''})`);
        return { ...meta, target, file: shot.ok ? file : null };
      } catch (e) {
        log(`${name}: ${p.key} FALHOU: ${redact(e.message).split('\n')[0]}`);
        return { ok: false, status: 0, target, error: redact(e.message.split('\n')[0]) };
      }
    };
    const fromCache = (p) => {
      const meta = cached.get(p.key);
      const file = path.join(dirs.before, `${p.key}.png`);
      copyFileSync(path.join(cacheDir, `${p.cacheKey}.png`), file);
      log(`base: ${p.key} (cache)`);
      return { ...meta, file, fromCache: true };
    };

    const workers = Math.max(1, Math.min(4, os.cpus().length - 1));
    const diffSlots = serialPool(workers);
    const items = [];
    const failed = [];
    const notCaptured = [];
    const shots = {};

    await pool(plan, Math.max(1, cfg.capture.concurrency), async (p) => {
      const [b, h] = await Promise.all([cached.has(p.key) ? fromCache(p) : captureSideOf('base', p), captureSideOf('head', p)]);
      shots[p.key] = { b, h };
      if (useCache && b.ok && !b.fromCache) {
        ensureDir(cacheDir);
        copyFileSync(b.file, path.join(cacheDir, `${p.cacheKey}.png`));
        const { file, ...meta } = b;
        writeFileSync(path.join(cacheDir, `${p.cacheKey}.json`), JSON.stringify(meta));
      }
      const base = { key: p.key, route: p.route.path, viewport: p.vp.name, theme: p.theme.name };
      const scale = p.vp.deviceScaleFactor ?? 1;
      const title = `${p.route.path} · ${p.vp.name} · ${p.theme.name}`;
      const ext = cfg.diff.composeFormat === 'png' ? 'png' : 'jpg';

      // Página nova ou removida (RTE-1).
      const gone = (s) => !s.ok && [404, 410].includes(s.status);
      if (gone(b) && h.ok) {
        const size = readPngSize(h.file);
        const file = await compose(() => composer.single({ file: h.file, size, label: 'Depois (página nova)', title, outFile: path.join(dirs.compare, `${p.key}.${ext}`), format: cfg.diff.composeFormat, scale }));
        items.push({ ...base, status: 'added', changed: true, kind: 'added', changedPercent: 100, stable: h.stable, truncated: h.truncated, after: relPath(stage, h.file), compare: relPath(stage, file), focus: [], a11y: h.extra && !h.extra.error ? { added: h.extra, resolved: [], unchanged: 0 } : undefined });
        return;
      }
      if (b.ok && gone(h)) {
        const size = readPngSize(b.file);
        const file = await compose(() => composer.single({ file: b.file, size, label: 'Antes (página removida)', title, outFile: path.join(dirs.compare, `${p.key}.${ext}`), format: cfg.diff.composeFormat, scale }));
        items.push({ ...base, status: 'removed', changed: true, kind: 'removed', changedPercent: 100, stable: b.stable, before: relPath(stage, b.file), compare: relPath(stage, file), focus: [] });
        return;
      }
      if (!b.ok || !h.ok) {
        const hint = (s) => (s.ok ? 'ok' : s.error ?? `HTTP ${s.status}`);
        failed.push({ ...base, base: hint(b), head: hint(h) });
        return;
      }

      // CAP-2: redirecionamentos (login vira "não capturado", não "sem mudança").
      const redirected = (s) => (s.target && s.finalUrl && pathOf(s.finalUrl) !== pathOf(s.target) ? pathOf(s.finalUrl) : null);
      const redirB = redirected(b);
      const redirH = redirected(h);
      if ((redirB && LOGIN_PATH.test(redirB)) || (redirH && LOGIN_PATH.test(redirH))) {
        notCaptured.push({ route: p.route.path, viewport: p.vp.name, theme: p.theme.name, reason: `redirecionou para ${redirH ?? redirB} (precisa de login: veja auth.storageState)` });
        return;
      }
      if (redirB || redirH) warnings.push(`${p.key}: redirecionou (base → ${redirB ?? 'sem redirecionamento'}; head → ${redirH ?? 'sem redirecionamento'}).`);

      const d = await diffSlots(() => diffInWorker(b.file, h.file, { threshold: cfg.diff.threshold, scale, maxRegions: cfg.diff.focusRegions, rowTolerance: cfg.diff.rowTolerance, maxFocusArea: cfg.diff.maxFocusArea, workDir: dirs.work, key: p.key, truncated: !!(b.truncated || h.truncated) }));
      const item = buildItem(base, d, scale, b, h, stage);
      if (redirB || redirH) item.redirect = { base: redirB, head: redirH };
      if (cfg.audits.a11y && b.extra && h.extra && !b.extra.error && !h.extra.error) item.a11y = a11yDelta(b.extra, h.extra);
      if (item.changed) {
        const full = await compose(() => composer.compare({ before: b.file, after: h.file, diff: d.files.diff, sizeBefore: d.sizeBefore, sizeAfter: d.sizeAfter, regions: d.regions, title: `${title}${d.kind === 'layout-shift' ? ' · só espaçamento' : ''}`, outFile: path.join(dirs.compare, `${p.key}.${ext}`), format: cfg.diff.composeFormat, scale }));
        item.compare = relPath(stage, full);
        item.focus = [];
        for (const [i, r] of d.regions.entries()) {
          const f = await compose(() => composer.focus({ aligned: d.files.aligned, after: h.file, diff: d.files.diff, size: d.sizeAfter, region: r, title: `${title} · região ${i + 1}`, outFile: path.join(dirs.compare, `${p.key}__focus-${i + 1}.png`), scale }));
          item.focus.push(relPath(stage, f));
        }
      }
      items.push(item);
    });

    // Avisos de estabilidade (CAP-8), corte (CAP-5) e espera (waitFor).
    for (const [key, { b, h }] of Object.entries(shots)) {
      for (const [name, s] of [['base', b], ['head', h]]) {
        if (!s.ok) continue;
        if (s.unstable && (!s.stable || s.frozen)) {
          const where = `${s.unstable.box.w}×${s.unstable.box.h} em x=${s.unstable.box.x}, y=${s.unstable.box.y}`;
          warnings.push(`${key} (${name}): ${s.stable ? 'só estabilizou depois de pausar timers e animações' : 'não estabilizou'}; algo se mexe em ${where}${s.unstable.selector ? ` (provável: \`${s.unstable.selector}\`)` : ''}. Considere capture.mask.`);
        }
        if (s.waitForTimedOut) warnings.push(`${key} (${name}): waitFor não ficou verdadeiro em 15 s; capturei assim mesmo.`);
      }
      if (h.ok && h.truncated) warnings.push(`${key}: página com ${h.fullHeightCss}px; capturei só os primeiros ${cfg.capture.maxHeight}px (capture.maxHeight).`);
    }

    // CAP-7: temas que saem idênticos provavelmente não estão sendo aplicados.
    if (cfg.themes.length > 1) {
      for (const r of routes) {
        for (const vp of cfg.viewports) {
          const files = cfg.themes.map((t) => shots[captureKey(r.path, vp, t)]?.h).filter((s) => s?.ok).map((s) => readFileSync(s.file));
          if (files.length > 1 && files.every((f) => f.equals(files[0]))) warnings.push(`${captureKey(r.path, vp, { name: '*' })}: as capturas de ${cfg.themes.map((t) => t.name).join(' e ')} são idênticas no head; o tema pode não estar sendo aplicado (veja themes[].localStorage, cookie ou htmlClass).`);
        }
      }
    }

    // ORIG-1: variantes (só o head).
    const variants = [];
    for (const job of variantJobs) variants.push(await captureVariants(browser, composer, compose, { job, cfg, srv: servers.head, runStart, auth, usingPreviews, dirs, stage }));

    // ORIG-5 e ORIG-4: auditorias que precisam dos dois servidores, só nas rotas alteradas.
    const changedItems = items.filter((i) => i.changed && i.status === 'changed');
    if (cfg.audits.tokens && changedItems.length && servers.base) {
      await auditTokensFor(browser, changedItems, { cfg, servers, runStart, auth, usingPreviews, warnings });
    }
    const motion = [];
    const motionRoutes = routes.filter((r) => (cfg.audits.motion || r.motion) && items.some((i) => i.route === r.path && i.changed));
    if (motionRoutes.length && servers.base) motion.push(...(await recordMotionFor(browser, motionRoutes, { cfg, servers, runStart, auth, usingPreviews, dirs, stage, warnings })));

    if (items.length === 0 && !variants.length) {
      throw new CliError(`Nenhuma captura funcionou nos dois lados:\n${failed.map((f) => `- ${f.key}: base=${f.base} head=${f.head}`).join('\n') || notCaptured.map((n) => `- ${n.route}: ${n.reason}`).join('\n')}`, { step: 'capture' });
    }

    for (const i of items) if (expected.get(i.route) === 'added' && i.status !== 'added' && !i.changed) warnings.push(`\`${i.route}\` é uma página nova no diff, mas existe igual nos dois lados.`);

    const order = new Map(plan.map((p, i) => [p.key, i]));
    items.sort((a, b) => order.get(a.key) - order.get(b.key));
    let report = {
      version: 2,
      runId,
      createdAt: runStart.toISOString(),
      sides: summarizeSides(sides),
      source: usingPreviews ? { base: opts.baseUrl, head: opts.headUrl } : 'worktrees',
      routes: routes.map((r) => ({ path: r.path, reasons: det.routes.find((x) => x.path === r.path)?.reasons ?? ['--routes'], change: expected.get(r.path) ?? 'modified' })),
      viewports: cfg.viewports,
      themes: cfg.themes.map((t) => t.name),
      stats: null,
      items,
      failed,
      warnings: [...new Set(warnings)].map(redact),
      notCaptured: [
        ...notCaptured,
        ...det.droppedRoutes.map((r) => ({ route: r, reason: 'além de detect.maxRoutes' })),
        ...det.needsExample.map((n) => ({ route: n.pattern, reason: `rota dinâmica (${n.file}); passe um exemplo com --routes` })),
      ],
      unmatchedFiles: det.unmatched,
      unmatchedMaybe: det.unmatchedMaybe,
      variants,
      motion,
    };
    if (previous) report = mergeReports(previous, report, plan);
    report.stats = statsOf(report);

    // Troca a saída anterior pela nova só agora.
    writeFileSync(path.join(stage, 'report.json'), JSON.stringify(report, null, 2));
    writeFileSync(path.join(stage, 'summary.auto.md'), autoSummary(report));
    commitStage(root, stage, { merge: !!previous, keys: plan.map((p) => p.key) });
    return { status: 'ok', ...compactResult(report, opts.json === 'full') };
  } finally {
    await composer?.close();
    await Promise.all(Object.values(servers).map((s) => s.stop().catch(() => {})));
    await browser?.close().catch(() => {});
    if (!usingPreviews && !opts.keepWorktrees && !cfg.cache.worktrees) {
      for (const dir of createdWorktrees) if (existsSync(dir)) removeWorktree(root, dir);
      rmSync(wtRoot, { recursive: true, force: true });
    } else if (opts.keepWorktrees || cfg.cache.worktrees) log(`worktrees mantidas em ${wtRoot}`);
    rmSync(stage, { recursive: true, force: true });
    guard.done();
  }
}

/** Fila com N vagas (para o diff em workers). */
function serialPool(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}

const readPngSize = (file) => {
  const buf = readFileSync(file);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
};

function buildItem(base, d, scale, b, h, stage) {
  const changed = d.kind !== 'none';
  return {
    ...base,
    status: changed ? 'changed' : 'unchanged',
    changed,
    kind: d.kind,
    changedPercent: d.changedPercent,
    changedPixels: d.changedPixels,
    sizeBefore: d.sizeBefore,
    sizeAfter: d.sizeAfter,
    heightDeltaCss: Math.round((d.sizeAfter.height - d.sizeBefore.height) / scale),
    shifts: d.shifts.map((s) => ({ fromYCss: Math.round(s.fromY / scale), toYCss: Math.round(s.toY / scale), byCss: Math.round(s.by / scale) })).filter((s) => s.byCss !== 0),
    inserted: d.inserted.map((r) => ({ yCss: Math.round(r.y / scale), hCss: Math.round(r.h / scale), blank: r.blank })),
    removed: d.removed.map((r) => ({ atYCss: Math.round(r.atY / scale), hCss: Math.round(r.h / scale), blank: r.blank })),
    regions: d.regions.map((r) => cssBox(r, scale)),
    regionsTotal: d.regionsTotal,
    regionsSkipped: d.regionsSkipped,
    stable: b.stable && h.stable,
    truncated: !!(b.truncated || h.truncated),
    before: relPath(stage, b.file),
    after: relPath(stage, h.file),
  };
}

function statsOf(report) {
  const items = report.items;
  return {
    captures: items.length,
    changed: items.filter((i) => i.changed && i.status === 'changed').length,
    layoutOnly: items.filter((i) => i.kind === 'layout-shift').length,
    unchanged: items.filter((i) => !i.changed).length,
    added: items.filter((i) => i.status === 'added').length,
    removed: items.filter((i) => i.status === 'removed').length,
    failed: report.failed.length,
    variants: (report.variants ?? []).length,
  };
}

/** --only: substitui no relatório anterior só as chaves recapturadas. */
function mergeReports(prev, next, plan) {
  const keys = new Set(plan.map((p) => p.key));
  const keep = (list) => (list ?? []).filter((x) => !keys.has(x.key));
  return {
    ...prev,
    runId: next.runId,
    createdAt: next.createdAt,
    items: [...keep(prev.items), ...next.items],
    failed: [...keep(prev.failed), ...next.failed],
    warnings: [...new Set([...(prev.warnings ?? []).filter((w) => ![...keys].some((k) => w.startsWith(k))), ...next.warnings])],
    variants: next.variants.length ? next.variants : prev.variants,
    motion: next.motion.length ? next.motion : prev.motion,
    partial: [...new Set([...(prev.partial ?? []), ...keys])],
  };
}

/**
 * Move a pasta de staging para .visual-diff/. Sem merge: troca before/after/compare/logs inteiros.
 * Com merge (--only): copia só os arquivos das chaves recapturadas.
 */
function commitStage(root, stage, { merge, keys }) {
  const out = outDirOf(root);
  // PUB-2: um summary.md de outra execução não pode ser publicado com este relatório.
  const summary = path.join(out, 'summary.md');
  if (existsSync(summary) && !merge) renameSync(summary, path.join(out, 'summary.prev.md'));
  for (const d of ['before', 'after', 'compare', 'logs']) {
    const src = path.join(stage, d);
    const dest = path.join(out, d);
    if (!merge) {
      rmSync(dest, { recursive: true, force: true });
      renameSync(src, dest);
      continue;
    }
    ensureDir(dest);
    if (d !== 'logs') for (const f of readdirSync(dest)) if (keys.some((k) => f.startsWith(k + '.') || f.startsWith(k + '__'))) rmSync(path.join(dest, f), { recursive: true, force: true });
    copyTree(src, dest);
  }
  for (const f of ['report.json', 'summary.auto.md']) renameSync(path.join(stage, f), path.join(out, f));
}

function copyTree(src, dest) {
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const t = path.join(dest, e.name);
    if (e.isDirectory()) {
      ensureDir(t);
      copyTree(s, t);
    } else copyFileSync(s, t);
  }
}

/** SKL-2: o stdout leva só o que o agente precisa; o detalhe fica no report.json. */
export function compactResult(report, full = false) {
  if (full) return { ...report, out: '.visual-diff' };
  const pick = (i) => ({ key: i.key, kind: i.kind, ...(i.kind === 'content' ? { changedPercent: i.changedPercent } : {}), ...(i.shifts?.length ? { shifts: i.shifts.slice(0, 3) } : {}), compare: i.compare ? `.visual-diff/${i.compare}` : undefined, focus: (i.focus ?? []).map((f) => `.visual-diff/${f}`), ...(i.a11y?.added?.length ? { a11yAdded: i.a11y.added.length } : {}), ...(i.tokens?.length ? { tokenFindings: i.tokens.length } : {}) });
  return {
    runId: report.runId,
    sides: { base: report.sides.base.label, head: report.sides.head.label, pr: report.sides.pr },
    stats: report.stats,
    changed: report.items.filter((i) => i.changed && i.status === 'changed').map(pick),
    added: report.items.filter((i) => i.status === 'added').map(pick),
    removed: report.items.filter((i) => i.status === 'removed').map(pick),
    variants: (report.variants ?? []).map((v) => ({ route: v.route, param: v.param, file: v.file ? `.visual-diff/${v.file}` : null })),
    motion: (report.motion ?? []).map((m) => ({ route: m.route, changed: m.changed, file: m.file ? `.visual-diff/${m.file}` : null })),
    failed: report.failed,
    warnings: report.warnings,
    notCaptured: report.notCaptured,
    unmatchedFiles: report.unmatchedFiles,
    unmatchedMaybe: report.unmatchedMaybe,
    report: '.visual-diff/report.json',
    next: 'Abra os recortes (focus) e as composições, depois escreva .visual-diff/summary.md partindo de .visual-diff/summary.auto.md.',
  };
}

function summarizeSides(s) {
  return {
    pr: s.pr ? { number: s.pr.number, url: s.pr.url, headRefOid: s.pr.headRefOid } : null,
    base: s.base,
    head: s.head,
  };
}

// ---- variantes (ORIG-1) --------------------------------------------------------------------------

/** --variants "/rota:param=1..4;/outra:x=a,b" → [{ route, param, values }]. */
export function parseVariantsOpt(opt) {
  if (!opt) return [];
  return String(opt).split(';').filter(Boolean).map((part) => {
    const m = /^([^:]+):([\w-]+)=(.+)$/.exec(part.trim());
    if (!m) throw new CliError(`--variants inválido: "${part}" (use /rota:param=1..4)`);
    return { route: m[1], param: m[2], values: parseVariantValues(m[3]) };
  });
}

function collectVariants(routes, cli, cfg) {
  const jobs = [];
  for (const r of routes) if (r.variants) jobs.push({ route: r.path, waitFor: r.waitFor, param: r.variants.param, values: parseVariantValues(r.variants.values), viewports: r.variants.viewports, themes: r.variants.themes });
  for (const v of cli) if (!jobs.some((j) => j.route === v.route && j.param === v.param)) jobs.push({ ...v, waitFor: cfg.routes.find((r) => r.path === v.route)?.waitFor });
  return jobs.flatMap((j) => {
    const vps = j.viewports?.length ? cfg.viewports.filter((v) => j.viewports.includes(v.name)) : [cfg.viewports[0]];
    const themes = j.themes?.length ? cfg.themes.filter((t) => j.themes.includes(t.name)) : [cfg.themes[0]];
    return vps.flatMap((vp) => themes.map((theme) => ({ ...j, vp, theme })));
  });
}

async function captureVariants(browser, composer, compose, { job, cfg, srv, runStart, auth, usingPreviews, dirs, stage }) {
  const vdir = ensureDir(path.join(dirs.after, 'variants'));
  const shots = [];
  const failed = [];
  for (const value of job.values) {
    const target = buildUrl(srv.url, job.route, job.theme, { [job.param]: value });
    const key = `${routeSlug(job.route)}__${job.param}-${value}__${job.vp.name}__${job.theme.name}`.replace(/[^\w.-]+/g, '-');
    try {
      const s = await captureOne(browser, { target, vp: job.vp, theme: job.theme, cfg, runStart, auth, isPreview: usingPreviews, waitFor: job.waitFor });
      if (!s.ok) throw new Error(s.error);
      const file = path.join(vdir, `${key}.png`);
      writeFileSync(file, s.png);
      shots.push({ label: `${job.param}=${value}`, file, size: readPngSize(file) });
      log(`variante: ${key}`);
    } catch (e) {
      failed.push(`${job.param}=${value}: ${redact(e.message).split('\n')[0]}`);
    }
  }
  const out = { route: job.route, param: job.param, values: job.values, viewport: job.vp.name, theme: job.theme.name, failed, file: null };
  if (shots.length) {
    const ext = cfg.diff.composeFormat === 'png' ? 'png' : 'jpg';
    const file = await compose(() => composer.strip({ items: shots, title: `${job.route} · ${job.param} · ${job.vp.name} · ${job.theme.name}`, outFile: path.join(dirs.compare, `${routeSlug(job.route)}__variants-${job.param}__${job.vp.name}__${job.theme.name}.${ext}`), format: cfg.diff.composeFormat, scale: job.vp.deviceScaleFactor ?? 1 }));
    out.file = relPath(stage, file);
  }
  return out;
}

// ---- auditorias com página aberta (ORIG-5, ORIG-4) ----------------------------------------------

async function withPage(browser, { target, vp, theme, cfg, runStart, auth, isPreview }, fn) {
  const context = await browser.newContext(contextOptions(vp, theme, cfg, auth));
  try {
    await prepareContext(context, { cfg, theme, origin: new URL(target).origin, auth, isPreview });
    const page = await context.newPage();
    if (cfg.capture.fixedTime) await page.clock.setFixedTime(cfg.capture.fixedTime === 'run-start' ? runStart : new Date(cfg.capture.fixedTime));
    await page.goto(target, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForLoadState('networkidle', { timeout: cfg.capture.networkIdleMs }).catch(() => {});
    await page.waitForTimeout(cfg.capture.settleMs);
    return await fn(page);
  } finally {
    await context.close().catch(() => {});
  }
}

async function auditTokensFor(browser, items, { cfg, servers, runStart, auth, usingPreviews, warnings }) {
  let tokensMod;
  try {
    tokensMod = await import('./tokens.mjs');
  } catch (e) {
    warnings.push(`Auditoria de tokens indisponível: ${e.message}`);
    return;
  }
  const opts = typeof cfg.audits.tokens === 'object' ? cfg.audits.tokens : {};
  for (const item of items) {
    const vp = cfg.viewports.find((v) => v.name === item.viewport);
    const theme = cfg.themes.find((t) => t.name === item.theme);
    const route = item.route;
    try {
      const run = (name, regions) =>
        withPage(browser, { target: buildUrl(servers[name].url, route, theme), vp, theme, cfg, runStart, auth, isPreview: usingPreviews }, async (page) => {
          const tokens = await tokensMod.readTokens(page, { include: opts.include });
          const styles = await tokensMod.collectStyles(page, { regions });
          return { tokens, findings: tokensMod.auditTokens(styles, tokens, { colorTolerance: opts.colorTolerance, allow: opts.allow }) };
        });
      const head = await run('head', item.regions.length ? item.regions : [{ x: 0, y: 0, w: vp.width, h: item.sizeAfter.height / (vp.deviceScaleFactor ?? 1) }]);
      if (!head.tokens.colors.length && !head.tokens.spacing.length) {
        warnings.push(`${item.key}: nenhum design token (CSS custom property em :root) encontrado; auditoria de tokens pulada.`);
        continue;
      }
      const base = await run('base', [{ x: 0, y: 0, w: vp.width, h: 100_000 }]);
      item.tokens = tokensMod.newFindings(base.findings, head.findings).slice(0, 50);
    } catch (e) {
      warnings.push(`${item.key}: auditoria de tokens falhou: ${redact(e.message).split('\n')[0]}`);
    }
  }
}

async function recordMotionFor(browser, routes, { cfg, servers, runStart, auth, usingPreviews, dirs, stage, warnings }) {
  let motionMod;
  try {
    motionMod = await import('./motion.mjs');
  } catch (e) {
    warnings.push(`GIFs de movimento indisponíveis: ${e.message}`);
    return [];
  }
  const vp = cfg.viewports[0];
  const theme = cfg.themes[0];
  const out = [];
  for (const r of routes) {
    const steps = r.motion?.steps ?? cfg.motion.steps ?? [];
    const durationMs = r.motion?.durationMs ?? cfg.motion.durationMs;
    try {
      const rec = (name) => {
        const url = buildUrl(servers[name].url, r.path, theme);
        return motionMod.recordMotion(browser, {
          url,
          contextOptions: contextOptions(vp, theme, cfg, auth),
          prepareContext: (ctx) => prepareContext(ctx, { cfg, theme, origin: new URL(url).origin, auth, isPreview: usingPreviews }),
          steps,
          durationMs,
          fps: cfg.motion.fps,
        });
      };
      const before = await rec('base');
      const after = await rec('head');
      const file = path.join(dirs.compare, `${routeSlug(r.path)}__motion__${vp.name}.gif`);
      const g = await motionMod.encodeMotionGif({ before: before.frames, after: after.frames }, { fps: cfg.motion.fps, durationMs, maxWidth: cfg.motion.maxWidth, title: `${r.path} · ${vp.name}`, outFile: file, browser });
      const skipped = [...new Set([...(before.skipped ?? []), ...(after.skipped ?? [])])];
      if (skipped.length) warnings.push(`${r.path}: passos de movimento pulados (seletor ausente): ${skipped.join(', ')}`);
      out.push({ route: r.path, viewport: vp.name, theme: theme.name, file: relPath(stage, g.file), changed: g.changed, frames: g.frameCount });
      log(`movimento: ${r.path} (${g.frameCount} quadros${g.changed ? ', mudou' : ''})`);
    } catch (e) {
      warnings.push(`${r.path}: GIF de movimento falhou: ${redact(e.message).split('\n')[0]}`);
    }
  }
  return out;
}

// ---- refazer só o diff (SKL-4) -------------------------------------------------------------------

/** Refaz diff e composições a partir de before/ e after/ com o config atual (sem recapturar). */
export async function rediff(root, cfg) {
  const out = outDirOf(root);
  const report = readJson(path.join(out, 'report.json'), null);
  if (!report) throw new CliError('Sem .visual-diff/report.json: rode `visual-diff run` primeiro.', { step: 'diff' });
  const work = ensureDir(path.join(out, '.diff-work'));
  const compareDir = ensureDir(path.join(out, 'compare'));
  const browser = await launchBrowser();
  const composer = await createComposer(browser);
  try {
    for (const item of report.items) {
      if (item.status !== 'changed' && item.status !== 'unchanged') continue;
      const vp = report.viewports.find((v) => v.name === item.viewport) ?? { deviceScaleFactor: 1 };
      const scale = vp.deviceScaleFactor ?? 1;
      const bFile = path.join(out, item.before);
      const hFile = path.join(out, item.after);
      if (!existsSync(bFile) || !existsSync(hFile)) continue;
      for (const f of readdirSync(compareDir)) if (f.startsWith(item.key + '.') || f.startsWith(item.key + '__focus')) rmSync(path.join(compareDir, f), { force: true });
      const d = diffImages(bFile, hFile, { threshold: cfg.diff.threshold, scale, maxRegions: cfg.diff.focusRegions, rowTolerance: cfg.diff.rowTolerance, maxFocusArea: cfg.diff.maxFocusArea, workDir: work, key: item.key, truncated: !!item.truncated });
      const next = buildItem({ key: item.key, route: item.route, viewport: item.viewport, theme: item.theme }, d, scale, { stable: item.stable, file: bFile, truncated: item.truncated }, { stable: true, file: hFile }, out);
      Object.assign(item, next, { a11y: item.a11y, tokens: item.tokens, redirect: item.redirect, compare: undefined, focus: [] });
      if (item.changed) {
        const title = `${item.route} · ${item.viewport} · ${item.theme}`;
        const ext = cfg.diff.composeFormat === 'png' ? 'png' : 'jpg';
        item.compare = relPath(out, await composer.compare({ before: bFile, after: hFile, diff: d.files.diff, sizeBefore: d.sizeBefore, sizeAfter: d.sizeAfter, regions: d.regions, title, outFile: path.join(compareDir, `${item.key}.${ext}`), format: cfg.diff.composeFormat, scale }));
        for (const [i, r] of d.regions.entries()) item.focus.push(relPath(out, await composer.focus({ aligned: d.files.aligned, after: hFile, diff: d.files.diff, size: d.sizeAfter, region: r, title: `${title} · região ${i + 1}`, outFile: path.join(compareDir, `${item.key}__focus-${i + 1}.png`), scale })));
      }
    }
  } finally {
    await composer.close();
    await browser.close().catch(() => {});
    rmSync(work, { recursive: true, force: true });
  }
  report.stats = statsOf(report);
  report.rediffedAt = new Date().toISOString();
  writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(path.join(out, 'summary.auto.md'), autoSummary(report));
  return { status: 'ok', ...compactResult(report) };
}

export { readPng };
