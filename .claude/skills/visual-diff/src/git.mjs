import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { CliError, git, log, sh } from './util.mjs';

export function repoRoot(cwd = process.cwd()) {
  const r = sh('git', ['rev-parse', '--show-toplevel'], { cwd, allowFail: true });
  if (!r.ok) throw new CliError('Não é um repositório git (rode dentro do repo do app).', { step: 'git' });
  return r.stdout.trim();
}

export function defaultBranch(root, remote = 'origin') {
  const r = sh('git', ['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`], { cwd: root, allowFail: true });
  if (r.ok) return r.stdout.trim(); // ex.: origin/main
  for (const b of [`${remote}/main`, `${remote}/master`, 'main', 'master']) {
    if (sh('git', ['rev-parse', '--verify', '--quiet', b], { cwd: root, allowFail: true }).ok) return b;
  }
  throw new CliError('Não achei a branch padrão; passe --base <ref>.', { step: 'git' });
}

export const revParse = (root, ref) => {
  const r = sh('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: root, allowFail: true });
  if (!r.ok) throw new CliError(`Ref não encontrada: ${ref}`, { step: 'git' });
  return r.stdout.trim();
};

export const shortSha = (sha) => sha.slice(0, 7);

/** host/owner/repo de uma URL de remote (https, ssh ou scp-like). */
export function parseRemoteUrl(url) {
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(String(url).trim());
  return m ? { host: m[1].toLowerCase(), owner: m[2], repo: m[3], slug: `${m[2]}/${m[3]}` } : null;
}

export function listRemotes(root) {
  const r = sh('git', ['remote', '-v'], { cwd: root, allowFail: true });
  const out = new Map();
  for (const line of r.stdout.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\(push\)$/.exec(line);
    if (m) out.set(m[1], { name: m[1], url: m[2], parsed: parseRemoteUrl(m[2]) });
  }
  return [...out.values()];
}

const allowedHost = (host, cfg) => host === 'github.com' || host === cfg?.publish?.host || host === process.env.GH_HOST;

/**
 * Repositório do GitHub onde publicar: publish.repo, senão o remote publish.remote, senão origin.
 * Devolve { host, owner, repo, slug, remote } (remote = nome do remote git que aponta para ele, se houver).
 */
export function githubRepo(root, cfg = {}) {
  const remotes = listRemotes(root);
  const pub = cfg.publish ?? {};
  if (pub.repo) {
    const parts = pub.repo.split('/');
    const [host, owner, repo] = parts.length === 3 ? parts : [pub.host ?? 'github.com', ...parts];
    const match = remotes.find((r) => r.parsed && r.parsed.slug.toLowerCase() === `${owner}/${repo}`.toLowerCase() && r.parsed.host === host);
    return { host, owner, repo, slug: `${owner}/${repo}`, remote: pub.remote ?? match?.name ?? null };
  }
  const name = pub.remote ?? 'origin';
  const r = remotes.find((x) => x.name === name);
  if (!r?.parsed || !allowedHost(r.parsed.host, cfg)) return null;
  return { ...r.parsed, remote: name };
}

/** Acha o remote git que aponta para host/slug. */
export function remoteFor(root, { host, slug }) {
  return listRemotes(root).find((r) => r.parsed && r.parsed.host === host && r.parsed.slug.toLowerCase() === slug.toLowerCase())?.name ?? null;
}

/** Argumentos de gh para um repositório (inclui host para GitHub Enterprise). */
export const ghRepoArg = (repo) => (repo.host && repo.host !== 'github.com' ? `${repo.host}/${repo.slug}` : repo.slug);
export const ghApiHost = (repo) => (repo?.host && repo.host !== 'github.com' ? ['--hostname', repo.host] : []);

/** Lê o PR via gh. O repositório vem da URL do PR (não do remote), o que separa fork e upstream. */
export function readPr(root, pr, cfg = {}) {
  const repoArgs = cfg.publish?.repo ? ['--repo', cfg.publish.repo] : [];
  const r = sh('gh', ['pr', 'view', String(pr), ...repoArgs, '--json', 'number,url,baseRefName,headRefName,headRefOid,isCrossRepository,state,isDraft'], { cwd: root, allowFail: true });
  if (!r.ok) throw new CliError(`gh pr view ${pr} falhou: ${r.stderr.trim()} (rode \`gh auth login\`?)`, { step: 'pr' });
  const info = JSON.parse(r.stdout);
  const m = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(info.url ?? '');
  info.repo = m ? { host: m[1].toLowerCase(), owner: m[2], repo: m[3], slug: `${m[2]}/${m[3]}` } : null;
  return info;
}

/** Lê o PR e garante que base e head estão disponíveis localmente. */
export function prInfo(root, pr, cfg = {}) {
  const info = readPr(root, pr, cfg);
  const remote = (info.repo && remoteFor(root, info.repo)) ?? 'origin';
  info.remote = remote;
  sh('git', ['fetch', '--quiet', remote, info.baseRefName], { cwd: root, allowFail: true });
  if (!sh('git', ['cat-file', '-e', `${info.headRefOid}^{commit}`], { cwd: root, allowFail: true }).ok) {
    sh('git', ['fetch', '--quiet', remote, `pull/${info.number}/head`], { cwd: root, step: 'pr' });
  }
  return info;
}

/**
 * Resolve os dois lados. head = null significa "árvore de trabalho atual" (inclui mudanças não commitadas).
 * base é sempre o merge-base entre a ref base e o head, como o GitHub mostra o diff do PR.
 */
export function resolveSides(root, { pr, base, head }, cfg = {}) {
  let prData = null;
  let baseRef = base;
  let headRef = head;
  if (pr) {
    prData = prInfo(root, pr, cfg);
    baseRef ??= `${prData.remote}/${prData.baseRefName}`;
    headRef ??= prData.headRefOid;
  }
  baseRef ??= defaultBranch(root, cfg.publish?.remote ?? 'origin');
  const headSha = headRef ? revParse(root, headRef) : revParse(root, 'HEAD');
  const baseTip = revParse(root, baseRef);
  const mb = sh('git', ['merge-base', baseTip, headSha], { cwd: root, allowFail: true });
  const baseSha = mb.ok ? mb.stdout.trim() : baseTip;
  const dirty = !headRef && git(['status', '--porcelain'], { cwd: root }).length > 0;
  return {
    pr: prData,
    base: { ref: baseRef, sha: baseSha, label: `${baseRef} @ ${shortSha(baseSha)}` },
    head: {
      ref: headRef ?? 'HEAD',
      sha: headSha,
      workingTree: !headRef,
      dirty,
      label: headRef ? `${prData ? prData.headRefName : headRef} @ ${shortSha(headSha)}` : `árvore de trabalho (${shortSha(headSha)}${dirty ? ' + mudanças locais' : ''})`,
    },
  };
}

/**
 * Arquivos alterados entre base e head (ou a árvore de trabalho, incluindo não rastreados), com o tipo:
 * [{ path, status: 'A'|'M'|'D'|'R', from? }]. Renomeações viram R com o caminho antigo em from.
 */
export function changedEntries(root, sides) {
  const args = ['diff', '--name-status', '-M', '-z', sides.base.sha];
  if (!sides.head.workingTree) args.push(sides.head.sha);
  const parts = sh('git', args, { cwd: root }).stdout.split('\0').filter((x) => x !== '');
  const out = new Map();
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++];
    const code = status[0];
    if (code === 'R' || code === 'C') {
      const from = parts[i++];
      const to = parts[i++];
      out.set(to, { path: to, status: code === 'R' ? 'R' : 'A', from });
    } else {
      const p = parts[i++];
      out.set(p, { path: p, status: code === 'T' ? 'M' : code });
    }
  }
  if (sides.head.workingTree) {
    for (const f of git(['ls-files', '--others', '--exclude-standard'], { cwd: root }).split('\n')) if (f && !out.has(f)) out.set(f, { path: f, status: 'A' });
  }
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export const changedFiles = (root, sides) => changedEntries(root, sides).map((e) => e.path);

export function addWorktree(root, sha, dir) {
  if (existsSync(dir)) removeWorktree(root, dir);
  mkdirSync(path.dirname(dir), { recursive: true });
  sh('git', ['worktree', 'add', '--detach', '--force', dir, sha], { cwd: root, step: 'worktree' });
}

/** Copia as mudanças locais (rastreadas e não rastreadas) para dentro de uma worktree em HEAD. */
export function applyWorkingTree(root, dir) {
  const patch = sh('git', ['diff', 'HEAD', '--binary'], { cwd: root }).stdout;
  if (patch.trim()) sh('git', ['apply', '--whitespace=nowarn', '-'], { cwd: dir, input: patch, step: 'worktree' });
  const untracked = git(['ls-files', '--others', '--exclude-standard'], { cwd: root }).split('\n').filter(Boolean);
  for (const f of untracked) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    copyFileSync(path.join(root, f), path.join(dir, f));
  }
  if (untracked.length) log(`copiados ${untracked.length} arquivo(s) não rastreado(s) para a worktree do head`);
}

export function removeWorktree(root, dir) {
  sh('git', ['worktree', 'remove', '--force', dir], { cwd: root, allowFail: true });
  rmSync(dir, { recursive: true, force: true });
  sh('git', ['worktree', 'prune'], { cwd: root, allowFail: true });
}

/** Worktrees registradas (caminhos absolutos). */
export function listWorktrees(root) {
  const r = sh('git', ['worktree', 'list', '--porcelain'], { cwd: root, allowFail: true });
  return r.stdout.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length));
}
