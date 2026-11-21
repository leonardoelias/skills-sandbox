import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export class CliError extends Error {
  constructor(message, { code = 1, step, hint } = {}) {
    super(message);
    this.code = code;
    this.step = step;
    this.hint = hint;
  }
}

// Segredos (valores de variáveis usadas em auth) nunca aparecem em logs, erros ou relatórios.
const secrets = new Set();
export function registerSecret(value) {
  if (value && String(value).length >= 4) secrets.add(String(value));
}
export function redact(text) {
  let out = String(text ?? '');
  for (const s of secrets) out = out.split(s).join('***');
  return out;
}

export const log = (...args) => process.stderr.write(`[visual-diff] ${redact(args.join(' '))}\n`);

/** Roda um comando de forma síncrona. Lança CliError se falhar (a não ser que allowFail). */
export function sh(cmd, args, { cwd, input, env, allowFail = false, step, maxBuffer = 512 * 1024 * 1024 } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    input,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: 'utf8',
    maxBuffer,
  });
  if (r.error) {
    if (allowFail) return { ok: false, stdout: '', stderr: String(r.error.message), status: -1 };
    throw new CliError(`${cmd} não encontrado ou falhou: ${r.error.message}`, { step });
  }
  const res = { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
  if (!res.ok && !allowFail) {
    throw new CliError(`\`${cmd} ${args.join(' ')}\` falhou (${r.status}): ${res.stderr.trim() || res.stdout.trim()}`, { step });
  }
  return res;
}

/** Versão assíncrona de sh para comandos longos (instalação), sem travar o event loop. */
export function shAsync(cmd, args, { cwd, env, logFile } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: env ? { ...process.env, ...env } : process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = (d) => {
      out += d;
      if (logFile) appendLog(logFile, d.toString());
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => resolve({ ok: false, status: -1, output: String(e.message) }));
    child.on('close', (status) => resolve({ ok: status === 0, status, output: out }));
  });
}

export const git = (args, opts = {}) => sh('git', args, opts).stdout.trim();

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** JSON com comentários e vírgulas finais (tsconfig, jsconfig). Devolve null se não der para ler. */
export function readJsonc(file) {
  try {
    const text = readFileSync(file, 'utf8');
    return JSON.parse(stripJsonComments(text));
  } catch {
    return null;
  }
}

export function stripJsonComments(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export function appendLog(file, text) {
  ensureDir(path.dirname(file));
  appendFileSync(file, text);
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Mata um grupo de processos (pid negativo). Ignora grupos que já saíram. */
export function killGroup(pgid, signal = 'SIGTERM') {
  if (!pgid) return false;
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Roda fn sobre items com no máximo `limit` tarefas ao mesmo tempo. Preserva a ordem dos resultados. */
export async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/** Fila serial: garante que tarefas que dividem um recurso (ex.: a página de composição) rodem uma por vez. */
export function serial() {
  let tail = Promise.resolve();
  return (fn) => {
    const p = tail.then(fn, fn);
    tail = p.catch(() => {});
    return p;
  };
}

/** Converte um glob (`**`, `*`, `?`, `{a,b}`) em RegExp, relativo à raiz do repositório. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) {
        re += escapeRe(c);
        continue;
      }
      re += `(?:${glob.slice(i + 1, end).split(',').map(escapeRe).join('|')})`;
      i = end;
    } else re += escapeRe(c);
  }
  // Um glob que termina numa pasta também casa com tudo dentro dela.
  return new RegExp(`^${re}(?:/.*)?$`);
}

const escapeRe = (s) => s.replace(/[.+^$()|[\]\\*?{}]/g, '\\$&');

const globCache = new Map();
export const matchesAny = (file, globs = []) =>
  globs.some((g) => {
    let re = globCache.get(g);
    if (!re) globCache.set(g, (re = globToRegExp(g)));
    return re.test(file);
  });

/** Nome de arquivo seguro para uma rota: "/" → "home", "/blog/a" → "blog-a", "/busca?q=x" → "busca-q-x". */
export function routeSlug(route) {
  const [p, q] = route.split('?');
  const clean = p.replace(/^\/+|\/+$/g, '');
  const base = clean ? clean.replace(/[^a-zA-Z0-9-_]+/g, '-').toLowerCase() : 'home';
  return q ? `${base}--${q.replace(/[^a-zA-Z0-9-_]+/g, '-').toLowerCase()}`.slice(0, 120) : base;
}

/** Distância de edição, para sugerir a opção certa quando alguém erra o nome. */
export function levenshtein(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

export function suggest(word, options) {
  let best = null;
  let bestD = Infinity;
  for (const o of options) {
    const d = levenshtein(word.toLowerCase(), o.toLowerCase());
    if (d < bestD) [best, bestD] = [o, d];
  }
  return bestD <= Math.max(2, Math.floor(word.length / 3)) ? best : null;
}

export const relPath = (root, f) => path.relative(root, f).split(path.sep).join('/');
