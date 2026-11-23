import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ghApiHost, ghRepoArg, githubRepo, readPr, remoteFor } from './git.mjs';
import { markerFor, renderCommentFitting } from './markdown.mjs';
import { outDirOf } from './pipeline.mjs';
import { CliError, log, sh } from './util.mjs';

export function loadReport(root) {
  const f = path.join(outDirOf(root), 'report.json');
  if (!existsSync(f)) throw new CliError('Sem .visual-diff/report.json: rode `visual-diff run` primeiro.', { step: 'render' });
  return JSON.parse(readFileSync(f, 'utf8'));
}

/** summary.md do agente (se for desta execução) ou summary.auto.md. stale = summary.md mais velho que o relatório. */
export function loadSummary(root, report) {
  const out = outDirOf(root);
  const own = path.join(out, 'summary.md');
  if (existsSync(own)) {
    const stale = statSync(own).mtimeMs < Date.parse(report.createdAt) - 1000;
    return { text: readFileSync(own, 'utf8'), source: 'summary.md', stale };
  }
  const auto = path.join(out, 'summary.auto.md');
  if (existsSync(auto)) return { text: readFileSync(auto, 'utf8'), source: 'summary.auto.md', stale: false };
  return { text: '', source: null, stale: false };
}

/** Prévia local com caminhos relativos (abre bem no VS Code / GitHub local). */
export function render(root, cfg) {
  const report = loadReport(root);
  const summary = loadSummary(root, report);
  const out = outDirOf(root);
  const { body, tier } = renderCommentFitting(report, summary.text, { link: (p) => p, markerId: cfg.publish.marker });
  const file = path.join(out, 'comment.preview.md');
  writeFileSync(file, body);
  const warnings = [];
  if (summary.stale) warnings.push('O summary.md é anterior a este relatório; reescreva antes de publicar.');
  if (summary.source !== 'summary.md') warnings.push('Usando o resumo automático; escreva .visual-diff/summary.md para um resumo de UX.');
  return { file: path.relative(root, file), summarySource: summary.source, stats: report.stats, tier, chars: body.length, warnings };
}

function visibility(root, repo) {
  const r = sh('gh', ['repo', 'view', ghRepoArg(repo), '--json', 'visibility', '-q', '.visibility'], { cwd: root, allowFail: true });
  return r.ok && r.stdout.trim() ? r.stdout.trim().toUpperCase() : 'UNKNOWN';
}

/** Arquivos de imagem referenciados pelo relatório (todos ficam em compare/, com nomes únicos). */
export const imagesOf = (report) => [
  ...report.items.filter((i) => i.changed).flatMap((i) => [i.compare, ...(i.focus ?? [])]),
  ...(report.variants ?? []).map((v) => v.file),
  ...(report.motion ?? []).map((m) => m.file),
].filter(Boolean);

export async function publish(root, cfg, opts) {
  const report = loadReport(root);
  const summary = loadSummary(root, report);
  const prNumber = opts.pr ?? report.sides.pr?.number;
  const problems = []; // { text, blocking }
  const block = (text) => problems.push({ text, blocking: true });
  const note = (text) => problems.push({ text, blocking: false });

  // O repositório do PR vem da URL do PR (PUB-6); sem gh, cai no remote configurado.
  let pr = null;
  if (!prNumber) block('Nenhum PR: passe --pr <n> (ou rode `run --pr <n>`).');
  else {
    try {
      pr = readPr(root, prNumber, cfg);
    } catch (e) {
      block(`Não consegui ler o PR #${prNumber}: ${e.message}`);
    }
  }
  const repo = pr?.repo ?? githubRepo(root, cfg);
  if (!repo) block('Não achei o repositório do GitHub (nem pelo PR nem pelo remote). Defina publish.repo ou publish.remote.');
  const pushRemote = repo ? (cfg.publish.remote ?? remoteFor(root, repo)) : null;
  if (repo && !opts.noUpload && !pushRemote) block(`Nenhum remote git aponta para ${repo.slug}; adicione um (\`git remote add upstream …\`) ou defina publish.remote.`);

  let vis = 'UNKNOWN';
  if (repo && !opts.noUpload) {
    vis = visibility(root, repo);
    if (vis === 'PUBLIC' && !opts.allowPublicRepo) block('O repositório é PÚBLICO: as imagens ficariam visíveis para qualquer pessoa. Use --allow-public-repo só se o usuário autorizar, ou --no-upload.');
    if (vis === 'INTERNAL' && !opts.allowInternalRepo) block('O repositório é INTERNAL: todos da empresa no GitHub podem ver as imagens, não só quem tem acesso ao repo. Use --allow-internal-repo só se o usuário confirmar.');
    if (vis === 'UNKNOWN' && !opts.assumePrivate) block('Não consegui ler a visibilidade do repositório (gh logado?). Use --assume-private só se o usuário confirmar que é privado.');
  }

  // PUB-3: o relatório precisa ser do head atual do PR.
  let stale = false;
  if (report.sides.pr && prNumber && report.sides.pr.number !== Number(prNumber)) block(`O relatório é do PR #${report.sides.pr.number}, não do #${prNumber}.`);
  if (report.sides.head.workingTree && report.sides.head.dirty) block('O relatório foi gerado da árvore de trabalho com mudanças locais, que não estão no PR. Rode `run --pr <n>`.');
  if (pr && pr.headRefOid !== report.sides.head.sha) {
    if (opts.forceStale) {
      stale = true;
      note(`O PR está em ${pr.headRefOid.slice(0, 7)} e o relatório é de ${report.sides.head.sha.slice(0, 7)}; publicando com aviso (--force-stale).`);
    } else block(`O PR está em ${pr.headRefOid.slice(0, 7)}, mas o relatório é de ${report.sides.head.sha.slice(0, 7)}. Rode \`run --pr ${prNumber}\` de novo (ou use --force-stale).`);
  }
  if (report.partial?.length) note(`Relatório com recapturas parciais (--only): ${report.partial.length} chave(s).`);

  // PUB-2: resumo.
  if (summary.source !== 'summary.md') note('Sem .visual-diff/summary.md escrito pelo agente; o resumo automático será usado.');
  if (summary.stale) block('O .visual-diff/summary.md é anterior a este relatório (provavelmente de outra execução). Reescreva-o ou apague-o para usar o resumo automático.');

  const branch = cfg.publish.branch;
  const runId = report.runId ?? report.createdAt.replace(/[-:T]/g, '').slice(0, 14);
  const prefix = `pr-${prNumber}/${runId}`;
  const images = opts.noUpload ? [] : imagesOf(report);
  const linkBase = repo ? `https://${repo.host ?? 'github.com'}/${repo.slug}/raw/${branch}` : '';
  const link = opts.noUpload ? null : (p) => `${linkBase}/${prefix}/${path.basename(p)}`;
  const { body, tier } = renderCommentFitting(report, summary.text, { link, markerId: cfg.publish.marker, stale });
  if (tier > 0) note(`O comentário completo passaria do limite do GitHub; usei o nível ${tier} (${['completo', 'sem recortes', 'só links', 'sem imagens', 'truncado'][tier]}).`);
  const commentFile = path.join(outDirOf(root), 'comment.md');
  writeFileSync(commentFile, body);

  const blocking = problems.filter((p) => p.blocking).map((p) => p.text);
  const missing = images.filter((p) => !existsSync(path.join(outDirOf(root), p)));
  if (missing.length) blocking.push(`Imagens do relatório não existem mais: ${missing.slice(0, 3).join(', ')}. Rode \`run\` de novo.`);
  const result = {
    publishable: blocking.length === 0,
    problems: problems.map((p) => (p.blocking ? `[bloqueia] ${p.text}` : p.text)),
    repo: repo ? ghRepoArg(repo) : null,
    visibility: vis,
    pr: prNumber ?? null,
    remote: pushRemote,
    uploads: images.map((p) => `${prefix}/${path.basename(p)}`),
    uploadBytes: images.reduce((n, p) => n + (existsSync(path.join(outDirOf(root), p)) ? statSync(path.join(outDirOf(root), p)).size : 0), 0),
    branch,
    commentFile: path.relative(root, commentFile),
    commentChars: body.length,
    reminder: 'Antes de publicar, olhe as imagens procurando dados pessoais, e-mails, tokens ou dados de produção.',
  };
  if (opts.dryRun) return { dryRun: true, ...result };
  if (blocking.length) throw new CliError(`Publicação recusada:\n- ${blocking.join('\n- ')}`, { step: 'publish', code: 4 });

  if (images.length) {
    uploadAssets(root, branch, (tree) => {
      // Mantém arquivos de outros PRs; troca os deste PR pelos novos.
      const keep = tree.filter((e) => !e.path.startsWith(`pr-${prNumber}/`));
      const add = images.map((p) => ({ path: `${prefix}/${path.basename(p)}`, file: path.join(outDirOf(root), p) }));
      return { keep, add, message: `visual-diff: PR #${prNumber} (${runId}) [skip ci]` };
    }, { remote: pushRemote });
  }
  const verify = opts.verify && images.length ? await verifyUploads(root, repo, branch, result.uploads) : undefined;
  if (opts.noComment) return { ...result, posted: false, verify, body };
  const c = upsertComment(root, repo, prNumber, cfg.publish.marker, commentFile);
  return { ...result, posted: true, commentUrl: c.url, commentAction: c.action, ...(c.warning ? { warning: c.warning } : {}), verify };
}

/** Identidade de commit para ambientes sem git config (CI). */
function identityEnv(root) {
  const name = sh('git', ['config', 'user.name'], { cwd: root, allowFail: true }).stdout.trim();
  const email = sh('git', ['config', 'user.email'], { cwd: root, allowFail: true }).stdout.trim();
  const n = name || 'visual-diff';
  const e = email || 'visual-diff@users.noreply.github.com';
  return { GIT_AUTHOR_NAME: n, GIT_AUTHOR_EMAIL: e, GIT_COMMITTER_NAME: n, GIT_COMMITTER_EMAIL: e };
}

/**
 * Atualiza a branch órfã de assets com um único commit (sem tocar na árvore de trabalho, no índice
 * ou nas branches locais), usando um índice temporário e git plumbing em lote. Tenta de novo quando
 * outra publicação mexeu na branch ao mesmo tempo (lease).
 */
export function uploadAssets(root, branch, plan, { remote = 'origin', retries = 4 } = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'visual-diff-'));
  const remoteRef = `refs/visual-diff/${branch}`;
  try {
    for (let attempt = 1; ; attempt++) {
      const env = { GIT_INDEX_FILE: path.join(tmp, `index-${attempt}`) };
      const fetched = sh('git', ['fetch', '--quiet', remote, `+refs/heads/${branch}:${remoteRef}`], { cwd: root, allowFail: true });
      let oldSha = '';
      let tree = [];
      if (fetched.ok) {
        oldSha = sh('git', ['rev-parse', remoteRef], { cwd: root }).stdout.trim();
        tree = sh('git', ['ls-tree', '-r', '--full-tree', remoteRef], { cwd: root }).stdout.split('\n').filter(Boolean).map((l) => {
          const [meta, p] = l.split('\t');
          const [mode, , sha] = meta.split(' ');
          return { mode, sha, path: p };
        });
      } else sh('git', ['update-ref', '-d', remoteRef], { cwd: root, allowFail: true });
      const planned = plan(tree);
      if (!planned) return null;
      const { keep, add, message } = planned;
      const shas = add.length ? sh('git', ['hash-object', '-w', '--stdin-paths'], { cwd: root, input: add.map((a) => a.file).join('\n') + '\n' }).stdout.trim().split('\n') : [];
      const lines = [...keep.map((e) => `${e.mode} ${e.sha}\t${e.path}`), ...add.map((a, i) => `100644 ${shas[i]}\t${a.path}`)];
      if (lines.length) sh('git', ['update-index', '--add', '--index-info'], { cwd: root, env, input: lines.join('\n') + '\n', step: 'publish' });
      const treeSha = lines.length ? sh('git', ['write-tree'], { cwd: root, env }).stdout.trim() : sh('git', ['hash-object', '-t', 'tree', '-w', '--stdin'], { cwd: root, input: '' }).stdout.trim();
      const commit = sh('git', ['commit-tree', treeSha, '-m', message], { cwd: root, env: identityEnv(root), step: 'publish' }).stdout.trim();
      // Pacotes acima de 1 MB (o padrão de http.postBuffer) vão em pedaços, e o GitHub às vezes
      // responde "RPC failed; HTTP 400". Um buffer grande, só neste comando, evita isso.
      const push = sh('git', ['-c', 'http.postBuffer=524288000', 'push', '--quiet', '--no-verify', `--force-with-lease=refs/heads/${branch}:${oldSha}`, remote, `${commit}:refs/heads/${branch}`], { cwd: root, allowFail: true });
      if (push.ok) {
        log(`assets enviados para ${branch} em ${remote} (${add.length} imagem(ns), ${keep.length} mantida(s))`);
        return commit;
      }
      const err = push.stderr.trim();
      if (/stale info|fetch first|non-fast-forward|rejected.*lease|failed to push some refs/i.test(err) && !/denied|permission|protected|rule|403/i.test(err) && attempt < retries) {
        log(`a branch ${branch} mudou durante a publicação; tentando de novo (${attempt}/${retries - 1})`);
        continue;
      }
      let hint = 'Sem permissão de push? Fork? Use --no-upload para um comentário só com texto.';
      if (/RPC failed|hung up|unexpected disconnect|HTTP 5\d\d|timed out|Could not resolve host/i.test(err)) hint = 'Falha de rede ou do servidor durante o envio (não de permissão). Tente de novo; se repetir, confira a conexão ou use --no-upload.';
      if (/protected|rule|GH013|force.?push/i.test(err)) hint = `Uma regra (ruleset/branch protection) bloqueia force-push em ${branch}. Exclua essa branch da regra (veja references/privacy.md) ou use --no-upload.`;
      throw new CliError(`git push para ${branch} falhou: ${err}\n${hint}`, { step: 'publish', code: 3 });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function currentLogin(root, repo) {
  const r = sh('gh', ['api', ...ghApiHost(repo), 'user', '--jq', '.login'], { cwd: root, allowFail: true });
  if (r.ok && r.stdout.trim()) return r.stdout.trim();
  return process.env.GITHUB_ACTIONS ? 'github-actions[bot]' : null;
}

/** PUB-4: edita o comentário mais recente do próprio usuário; nunca o de outra pessoa. */
export function upsertComment(root, repo, pr, markerId, bodyFile) {
  const marker = markerFor(markerId);
  const host = ghApiHost(repo);
  const list = sh('gh', ['api', ...host, '--paginate', `repos/${repo.slug}/issues/${pr}/comments`, '--jq', `.[] | select(.body | contains(${JSON.stringify(marker)})) | {id, html_url, body, user: .user.login, updated_at}`], { cwd: root, step: 'comment' });
  const found = list.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const me = currentLogin(root, repo);
  const mine = found.filter((c) => me && c.user === me).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
  const body = readFileSync(bodyFile, 'utf8');
  if (mine) {
    if (mine.body.trim() === body.trim()) {
      log('comentário já está atualizado');
      return { url: mine.html_url, action: 'unchanged' };
    }
    const r = sh('gh', ['api', ...host, '--method', 'PATCH', `repos/${repo.slug}/issues/comments/${mine.id}`, '-F', `body=@${bodyFile}`, '--jq', '.html_url'], { cwd: root, step: 'comment' });
    log('comentário atualizado');
    return { url: r.stdout.trim(), action: 'updated' };
  }
  const r = sh('gh', ['api', ...host, '--method', 'POST', `repos/${repo.slug}/issues/${pr}/comments`, '-F', `body=@${bodyFile}`, '--jq', '.html_url'], { cwd: root, step: 'comment' });
  log('comentário criado');
  const others = [...new Set(found.map((c) => c.user))];
  return { url: r.stdout.trim(), action: 'created', warning: others.length ? `Já havia um comentário visual-diff de ${others.join(', ')}; criei um novo em vez de editar o de outra pessoa.` : undefined };
}

/**
 * PUB-1: confere que cada arquivo existe na branch (API autenticada) e que o link não abre sem login.
 */
export async function verifyUploads(root, repo, branch, paths) {
  const host = ghApiHost(repo);
  const details = [];
  for (const p of paths) {
    const r = sh('gh', ['api', ...host, `repos/${repo.slug}/contents/${p}?ref=${encodeURIComponent(branch)}`, '--jq', '.sha'], { cwd: root, allowFail: true });
    details.push({ path: p, onBranch: r.ok });
  }
  let anonymous = null;
  if (paths.length) {
    try {
      const res = await fetch(`https://${repo.host ?? 'github.com'}/${repo.slug}/raw/${branch}/${paths[0]}`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
      anonymous = res.status;
    } catch (e) {
      anonymous = `erro: ${e.message}`;
    }
  }
  const okAll = details.every((d) => d.onBranch);
  return {
    ok: okAll && anonymous !== 200 && !(typeof anonymous === 'number' && anonymous >= 300 && anonymous < 400),
    filesOnBranch: details.filter((d) => d.onBranch).length,
    files: details.length,
    anonymousStatus: anonymous,
    note: anonymous === 404 ? 'Sem login, o link devolve 404 (esperado num repo privado).' : 'Sem login, o link NÃO devolveu 404: confira a visibilidade do repositório.',
    missing: details.filter((d) => !d.onBranch).map((d) => d.path),
  };
}

/** Remove da branch de assets as imagens de PRs fechados. */
export function prune(root, cfg, { closed = true, dryRun = false } = {}) {
  const repo = githubRepo(root, cfg);
  if (!repo) throw new CliError('Não achei o repositório do GitHub. Defina publish.repo ou publish.remote.');
  const remote = cfg.publish.remote ?? repo.remote ?? remoteFor(root, repo) ?? 'origin';
  const branch = cfg.publish.branch;
  const removed = [];
  const plan = (tree) => {
    removed.length = 0;
    const prs = [...new Set(tree.map((e) => /^pr-(\d+)\//.exec(e.path)?.[1]).filter(Boolean))];
    for (const n of prs) {
      const st = sh('gh', ['pr', 'view', n, '--repo', ghRepoArg(repo), '--json', 'state', '-q', '.state'], { cwd: root, allowFail: true }).stdout.trim();
      if (closed && (st === 'CLOSED' || st === 'MERGED')) removed.push(Number(n));
    }
    if (removed.length === 0) return null;
    return { keep: tree.filter((e) => !removed.some((n) => e.path.startsWith(`pr-${n}/`))), add: [], message: `visual-diff: prune ${removed.map((n) => '#' + n).join(' ')} [skip ci]` };
  };
  const note = 'O prune troca o commit da branch; os objetos antigos podem continuar acessíveis por SHA e em caches do GitHub por um tempo.';
  if (dryRun) {
    const fetched = sh('git', ['fetch', '--quiet', remote, `+refs/heads/${branch}:refs/visual-diff/${branch}`], { cwd: root, allowFail: true });
    if (!fetched.ok) return { dryRun: true, removed: [] };
    const tree = sh('git', ['ls-tree', '-r', '--full-tree', `refs/visual-diff/${branch}`], { cwd: root }).stdout.split('\n').filter(Boolean).map((l) => ({ path: l.split('\t')[1] }));
    plan(tree);
    return { dryRun: true, removed: [...removed], note };
  }
  uploadAssets(root, branch, plan, { remote });
  return { removed: [...removed], note };
}
