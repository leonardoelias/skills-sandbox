import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { browserInstalled, captureOne, launchBrowser } from './capture.mjs';
import { CONFIG_FILE, loadConfig, normalizeConfig, normalizeTheme, parseViewports, suggestConfig } from './config.mjs';
import { detect } from './detect.mjs';
import { githubRepo, listWorktrees, repoRoot, resolveSides } from './git.mjs';
import { cleanupStale, outDirOf, rediff, resolveAuth, run } from './pipeline.mjs';
import { prune, publish, render } from './publish.mjs';
import { startSide } from './server.mjs';
import { CliError, ensureDir, redact, sh, sleep, suggest } from './util.mjs';

const HELP = `visual-diff <comando> [opções]

Comandos:
  init                 sugere ${CONFIG_FILE} (startCommand, rotas, appDir em monorepos)
  doctor [--smoke]     checa git, node, gh, Chromium, config, remote e visibilidade;
                       --smoke sobe o app atual, captura a primeira rota e derruba
  detect               arquivos alterados → rotas (com motivos)
  run                  captura base e head, faz o diff → .visual-diff/report.json + imagens
  diff                 refaz só o diff e as imagens a partir das capturas (ex.: depois de mudar diff.threshold)
  render               prévia do comentário → .visual-diff/comment.preview.md
  publish              envia imagens para a branch de assets e cria/atualiza o comentário fixo
  prune --closed       remove imagens de PRs fechados
  cleanup [--all]      mata servidores e remove worktrees deixados por execuções interrompidas
  login --url <url>    abre um navegador para você entrar no app e salva a sessão (auth.storageState)

Opções de detect/run:
  --pr <n>             usa base/head do PR (via gh)
  --base <ref>         ref base (padrão: branch padrão do origin)
  --head <ref>         ref head (padrão: árvore de trabalho atual, com mudanças locais)
  --routes /,/precos   rotas explícitas (ignora a detecção)
  --viewports desktop,mobile,tablet:820x1180@2
  --themes light,dark
  --base-url/--head-url  usa previews já publicados em vez de subir o app
  --only <chave|rota>  recaptura só isso e mescla no relatório existente
  --variants "/rota:param=1..4"  captura variantes do head (?param=1..4) numa faixa
  --json full          imprime o relatório inteiro (padrão: resumo)
  --no-cache           não reaproveita capturas do base em cache
  --keep-worktrees     não apaga as worktrees (debug)
  --config <arquivo>   caminho do config

publish:
  --dry-run            mostra o que seria enviado e se seria recusado; não envia nada
  --verify             depois do envio, confere os arquivos na branch e que o link exige login
  --no-upload          comentário só com texto
  --no-comment         envia as imagens e imprime o markdown sem comentar
  --force-stale        publica mesmo se o PR recebeu commits depois do run (com aviso)
  --allow-public-repo  permite repositório público (só com autorização explícita)
  --allow-internal-repo  permite repositório INTERNAL (visível para a empresa toda)
  --assume-private     quando a visibilidade não pode ser lida

Códigos de saída: 0 ok · 1 erro · 2 UI alterada sem rota mapeada · 3 push recusado ·
4 publicação recusada · 130/143 interrompido.
Toda saída em JSON vai para stdout; logs vão para stderr.`;

const FLAGS = ['dryRun', 'noUpload', 'noComment', 'allowPublicRepo', 'allowInternalRepo', 'assumePrivate', 'keepWorktrees', 'closed', 'force', 'help', 'forceStale', 'verify', 'noCache', 'smoke', 'all'];
const SIDES = ['pr', 'base', 'head', 'config'];
const CAPTURE = [...SIDES, 'routes', 'viewports', 'themes', 'baseUrl', 'headUrl', 'keepWorktrees'];
export const COMMAND_OPTIONS = {
  init: ['force', 'config'],
  doctor: ['smoke', 'config', 'routes', 'viewports'],
  detect: [...SIDES],
  run: [...CAPTURE, 'only', 'json', 'noCache', 'variants'],
  diff: ['config', 'json'],
  render: ['config'],
  publish: ['pr', 'config', 'dryRun', 'noUpload', 'noComment', 'allowPublicRepo', 'allowInternalRepo', 'assumePrivate', 'forceStale', 'verify'],
  prune: ['closed', 'dryRun', 'config'],
  cleanup: ['all', 'config'],
  login: ['url', 'out', 'config'],
  help: [],
};

const kebab = (k) => k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  if (cmd === '--help' || cmd === '-h') return { cmd: 'help', opts };
  if (cmd && !COMMAND_OPTIONS[cmd]) {
    const hint = suggest(cmd, Object.keys(COMMAND_OPTIONS));
    throw new CliError(`comando desconhecido: ${cmd}${hint ? ` (você quis dizer "${hint}"?)` : ''}\n\n${HELP}`);
  }
  const allowed = [...(COMMAND_OPTIONS[cmd] ?? []), 'help'];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-h') {
      opts.help = true;
      continue;
    }
    if (!a.startsWith('--')) throw new CliError(`argumento inesperado: ${a}`);
    const eq = a.indexOf('=');
    const k = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    const inline = eq >= 0 ? a.slice(eq + 1) : undefined;
    const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (!allowed.includes(key)) {
      const hint = suggest(key, allowed);
      throw new CliError(`opção desconhecida para \`${cmd}\`: --${k}${hint ? ` (você quis dizer --${kebab(hint)}?)` : ''}. Opções: ${allowed.filter((o) => o !== 'help').map((o) => '--' + kebab(o)).join(' ') || '(nenhuma)'}`);
    }
    if (FLAGS.includes(key)) {
      if (inline === undefined || inline === 'true') opts[key] = true;
      else if (inline === 'false') opts[key] = false;
      else throw new CliError(`--${k} não aceita valor (use --${k} ou --${k}=false)`);
      continue;
    }
    const value = inline ?? rest[++i];
    if (value === undefined || (inline === undefined && value.startsWith('--'))) throw new CliError(`--${k} precisa de um valor`);
    opts[key] = value;
  }
  if (opts.pr !== undefined && !/^\d+$/.test(opts.pr)) throw new CliError(`--pr precisa ser um número (recebi "${opts.pr}")`);
  if (opts.json !== undefined && opts.json !== 'full') throw new CliError('--json só aceita "full"');
  return { cmd, opts };
}

export async function main(argv) {
  try {
    const { cmd, opts } = parseArgs(argv);
    if (!cmd || cmd === 'help' || opts.help) {
      process.stderr.write(HELP + '\n');
      return 0;
    }
    const root = repoRoot();
    let cfg;
    let cfgError = null;
    try {
      cfg = loadConfig(root, opts.config);
    } catch (e) {
      if (cmd !== 'doctor' && cmd !== 'init' && cmd !== 'cleanup') throw e;
      cfgError = e;
      cfg = normalizeConfig({});
    }
    if (opts.viewports) cfg.viewports = parseViewports(opts.viewports);
    if (opts.themes) cfg.themes = opts.themes.split(',').map((n) => cfg.themes.find((t) => t.name === n) ?? normalizeTheme(n));
    const runOpts = {
      pr: opts.pr ? Number(opts.pr) : undefined,
      base: opts.base,
      head: opts.head,
      routes: opts.routes ? opts.routes.split(',').map((r) => r.trim()).filter(Boolean) : undefined,
      baseUrl: opts.baseUrl,
      headUrl: opts.headUrl,
      keepWorktrees: opts.keepWorktrees,
      only: opts.only,
      json: opts.json,
      noCache: opts.noCache,
      variants: opts.variants,
    };
    ensureExcluded(root);

    let result;
    switch (cmd) {
      case 'init': {
        const target = path.join(root, CONFIG_FILE);
        if (existsSync(target) && !opts.force) {
          result = { written: false, file: CONFIG_FILE, reason: 'já existe (use --force para sobrescrever)', config: JSON.parse(readFileSync(target, 'utf8')), ...(cfgError ? { problems: cfgError.message } : {}) };
          break;
        }
        const { config, notes } = suggestConfig(root);
        writeFileSync(target, JSON.stringify(config, null, 2) + '\n');
        result = { written: true, file: CONFIG_FILE, config, notes, next: 'Confira startCommand, appDir e routes antes do primeiro run; rode `doctor --smoke` para testar o startCommand.' };
        break;
      }
      case 'doctor':
        result = await doctor(root, cfg, { cfgError, smoke: opts.smoke, routes: runOpts.routes });
        break;
      case 'detect': {
        const sides = resolveSides(root, runOpts, cfg);
        const d = detect(root, cfg, sides);
        result = { base: sides.base.label, head: sides.head.label, ...d, changedFiles: d.changedFiles.length };
        break;
      }
      case 'run':
        result = await run(root, cfg, runOpts);
        break;
      case 'diff':
        result = await rediff(root, cfg);
        break;
      case 'render':
        result = render(root, cfg);
        break;
      case 'publish':
        result = await publish(root, cfg, { ...runOpts, dryRun: opts.dryRun, noUpload: opts.noUpload, noComment: opts.noComment, allowPublicRepo: opts.allowPublicRepo, allowInternalRepo: opts.allowInternalRepo, assumePrivate: opts.assumePrivate, forceStale: opts.forceStale, verify: opts.verify });
        break;
      case 'prune':
        if (!opts.closed) throw new CliError('Use `prune --closed` (remove as imagens de PRs fechados ou mesclados).');
        result = prune(root, cfg, { closed: true, dryRun: opts.dryRun });
        break;
      case 'cleanup':
        result = cleanupStale(root, { all: opts.all });
        break;
      case 'login':
        result = await login(root, opts);
        break;
    }
    const exitCode = result?.exitCode ?? 0;
    if (result && 'exitCode' in result) delete result.exitCode;
    process.stdout.write(redact(JSON.stringify(result, null, 2)) + '\n');
    return exitCode;
  } catch (e) {
    const err = e instanceof CliError ? e : new CliError(e.stack ?? String(e));
    process.stdout.write(redact(JSON.stringify({ error: err.message, step: err.step ?? null, code: err.code ?? 1 }, null, 2)) + '\n');
    process.stderr.write(`[visual-diff] erro${err.step ? ` (${err.step})` : ''}: ${redact(err.message)}\n`);
    return err.code ?? 1;
  }
}

async function doctor(root, cfg, { cfgError, smoke, routes }) {
  const checks = [];
  const add = (name, level, detail) => checks.push({ name, level, detail });
  add('git', 'OK', sh('git', ['--version']).stdout.trim());
  const node = process.versions.node.split('.').map(Number);
  add('node', node[0] > 20 || (node[0] === 20 && node[1] >= 10) ? 'OK' : 'FAIL', process.versions.node);
  const gh = sh('gh', ['auth', 'status'], { allowFail: true });
  add('gh', gh.ok ? 'OK' : 'WARN', gh.ok ? 'logado' : 'gh ausente ou não logado: só necessário para --pr e publish');
  const br = await browserInstalled();
  add('navegador', br.ok ? 'OK' : 'WARN', br.ok ? `Chromium do Playwright em ${br.path}` : 'Chromium do Playwright ainda não baixado; o primeiro run baixa (~150 MB)');
  if (cfgError) add('config', 'FAIL', cfgError.message);
  else add('config', cfg.found ? 'OK' : 'WARN', cfg.found ? path.relative(root, cfg.path) : `sem ${CONFIG_FILE}: rode \`init\``);
  if (!cfg.startCommand.startsWith('static:') && !cfg.startCommand.includes('{port}') && !/\bPORT\b/.test(cfg.startCommand)) {
    add('startCommand', 'FAIL', 'startCommand precisa usar {port} (ou ler PORT) para os dois lados rodarem em portas diferentes');
  }
  if (!cfg.startCommand.startsWith('static:') && !cfg.baseUrl.includes('{port}')) add('baseUrl', 'FAIL', 'baseUrl precisa ter {port} (ex.: http://localhost:{port})');
  if (cfg.appDir !== '.' && !existsSync(path.join(root, cfg.appDir))) add('appDir', 'FAIL', `${cfg.appDir} não existe`);
  const orphans = listWorktrees(root).filter((w) => w.includes('visual-diff-wt-'));
  if (orphans.length) add('worktrees', 'WARN', `${orphans.length} worktree(s) de execuções interrompidas; rode \`cleanup\``);
  const repo = githubRepo(root, cfg);
  if (!repo) add('remote', 'WARN', 'sem remote do GitHub (ou publish.repo): publish não vai funcionar');
  else if (gh.ok) {
    const v = sh('gh', ['repo', 'view', repo.host === 'github.com' ? repo.slug : `${repo.host}/${repo.slug}`, '--json', 'visibility', '-q', '.visibility'], { allowFail: true }).stdout.trim();
    const level = v === 'PRIVATE' ? 'OK' : 'WARN';
    const extra = v === 'PUBLIC' ? ' (publish recusa sem --allow-public-repo)' : v === 'INTERNAL' ? ' (visível para toda a empresa; publish pede --allow-internal-repo)' : '';
    add('visibilidade', level, v ? `${repo.slug}: ${v}${extra}` : 'não foi possível ler');
  }
  const out = { ok: !checks.some((c) => c.level === 'FAIL'), checks };
  if (smoke && out.ok) out.smoke = await smokeTest(root, cfg, routes?.[0] ?? cfg.routes[0]?.path ?? '/');
  if (out.smoke && !out.smoke.ok) out.ok = false;
  return out;
}

/** Sobe o app do checkout atual (sem worktree), captura uma rota e derruba. */
async function smokeTest(root, cfg, route) {
  const logFile = path.join(ensureDir(path.join(outDirOf(root), 'logs')), 'smoke.log');
  const t0 = Date.now();
  let srv;
  let browser;
  try {
    srv = await startSide(root, { ...cfg, deps: 'link' }, { name: 'smoke', dir: root }, logFile, null);
    const bootMs = Date.now() - t0;
    browser = await launchBrowser();
    const auth = resolveAuth(root, cfg, { usingPreviews: false });
    const shot = await captureOne(browser, { target: new URL(route, srv.url + '/').toString(), vp: cfg.viewports[0], theme: cfg.themes[0], cfg, runStart: new Date(), auth, isPreview: false });
    if (shot.ok) writeFileSync(path.join(outDirOf(root), 'smoke.png'), shot.png);
    return { ok: shot.ok, route, url: srv.url, status: shot.status, bootMs, captureMs: Date.now() - t0 - bootMs, stable: shot.stable, image: shot.ok ? '.visual-diff/smoke.png' : null, log: path.relative(root, logFile) };
  } catch (e) {
    return { ok: false, route, error: redact(e.message), log: path.relative(root, logFile) };
  } finally {
    await browser?.close().catch(() => {});
    await srv?.stop().catch(() => {});
  }
}

/** CAP-3: navegador visível para a pessoa entrar; a sessão é salva enquanto a janela está aberta. */
async function login(root, opts) {
  if (!opts.url) throw new CliError('Passe --url <página de login> (ex.: http://localhost:3000/login).');
  const file = path.resolve(root, opts.out ?? '.visual-diff/auth/storage-state.json');
  ensureDir(path.dirname(file));
  const ignored = sh('git', ['check-ignore', '-q', file], { cwd: root, allowFail: true }).ok || file.startsWith(outDirOf(root) + path.sep);
  const browser = await launchBrowser({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(opts.url);
  process.stderr.write('[visual-diff] entre no app na janela aberta e feche a janela quando terminar (até 10 min).\n');
  let last = null;
  const deadline = Date.now() + 10 * 60_000;
  let closed = false;
  page.on('close', () => (closed = true));
  browser.on('disconnected', () => (closed = true));
  while (!closed && Date.now() < deadline) {
    try {
      last = await context.storageState();
    } catch {
      break;
    }
    await sleep(1500);
  }
  await browser.close().catch(() => {});
  if (!last) throw new CliError('Não consegui ler a sessão do navegador.');
  writeFileSync(file, JSON.stringify(last, null, 2), { mode: 0o600 });
  const rel = path.relative(root, file);
  return {
    file: rel,
    cookies: last.cookies.length,
    domains: [...new Set(last.cookies.map((c) => c.domain))],
    origins: last.origins.map((o) => o.origin),
    next: `Adicione ao config: "auth": { "storageState": "${rel}", "origins": ["local"] } (use "previews" para previews publicados).`,
    ...(ignored ? {} : { warning: `${rel} não está ignorado pelo git; não commite esse arquivo.` }),
  };
}

/** Garante que .visual-diff/ não entre em commits. */
function ensureExcluded(root) {
  const gitDir = sh('git', ['rev-parse', '--git-common-dir'], { cwd: root }).stdout.trim();
  const exclude = path.resolve(root, gitDir, 'info', 'exclude');
  ensureDir(path.dirname(exclude));
  const cur = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (!cur.split('\n').includes('.visual-diff/')) appendFileSync(exclude, `${cur && !cur.endsWith('\n') ? '\n' : ''}.visual-diff/\n`);
  ensureDir(outDirOf(root));
}
