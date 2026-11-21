---
name: visual-diff
description: Screenshots antes/depois, diff de pixels destacado e um resumo de UX para pull requests que mudam a interface, publicados como um único comentário fixo no PR, com as imagens privadas no próprio repositório. Use quando alguém quiser que revisores vejam uma mudança de frontend ("coloca prints antes/depois no PR", "como fica esse PR", "diff visual", "revisão de UI", "esse CSS quebrou alguma coisa?", "mostra o que minha branch muda na tela"), ou quiser comparar a branch local com a principal antes de abrir o PR, inclusive em previews já publicados.
---

# visual-diff

Renderiza as rotas afetadas do app no **base** e no **head** do PR, compara os screenshots e
publica um comentário com imagens `Antes | Depois | Diff` e um resumo de UX. A mecânica é
scriptada; o seu trabalho é o julgamento: quais rotas importam, o que as mudanças significam para
quem usa, e se está tudo certo para publicar.

`$SKILL` é a pasta que contém este arquivo. Rode a CLI assim:

```bash
node "$SKILL/bin/visual-diff.mjs" <comando> [opções]
```

O primeiro uso instala as dependências; a primeira captura baixa o Chromium do Playwright (~150 MB).
Todo comando imprime JSON no stdout e progresso no stderr. A saída fica em `.visual-diff/` na raiz
do repositório, que é adicionada automaticamente a `.git/info/exclude`.

## Regras de privacidade (sempre)

- Screenshots nunca vão para hosts públicos ou de terceiros (imgur, gists, Slack, CDNs). O único
  destino é a branch `visual-diff-assets` do próprio repositório.
- `publish` recusa repositórios públicos e `INTERNAL` (visíveis para a empresa toda) a menos que o
  usuário peça `--allow-public-repo` / `--allow-internal-repo` explicitamente. Se a visibilidade for
  pública, interna ou desconhecida, pare e pergunte.
- Antes de publicar, olhe as imagens procurando dados pessoais, e-mails, tokens ou dados de produção
  na tela. Se achar, não publique: mascare (`capture.mask`) e rode de novo.
- Credenciais vêm só de variáveis de ambiente (`"$NOME"` em `auth.headers`/`auth.cookies`) ou de um
  arquivo gerado por `login`. Nunca imprima valores secretos nem os coloque no resumo ou no comentário.

## 1. Contexto

```bash
gh pr view <n> --json number,url,baseRefName,headRefName,headRefOid   # ou: gh pr view (branch atual)
git status --short
```

- Procure `visual-diff.config.json` na raiz do repo. Se não existir, rode `init` (em monorepos ele
  escolhe o `appDir`), confira `startCommand`, `appDir` e `routes` e ofereça commitar o arquivo.
  `doctor` checa git, gh, Chromium, config e visibilidade: FAIL bloqueia; WARN (sem gh, sem remote)
  só importa para `--pr` e `publish`. `doctor --smoke` sobe o app atual e captura uma rota: use
  quando o `startCommand` for novo.
- **Publicar num PR:** passe `--pr <n>` para o head ser o commit enviado. Avise sobre trabalho não
  commitado ou não enviado, porque ele não aparece.
- **Ver trabalho em andamento:** omita `--head`; a árvore de trabalho (com mudanças não commitadas)
  é copiada para uma worktree e rotulada como tal (esse relatório não pode ser publicado).
- **Previews publicados:** `--base-url` e `--head-url` juntos (ver `references/privacy.md`).
- **Páginas com login:** `login --url <página de login>` abre um navegador para o usuário entrar e
  salva a sessão; depois `auth.storageState` + `auth.origins: ["local"]` no config.

## 2. Detectar UI alterada e escolher rotas

```bash
node "$SKILL/bin/visual-diff.mjs" detect --pr <n>
```

Mapeia arquivos alterados para rotas via `routes[].files` e `globalFiles` do config, depois por
convenção de framework (Next.js app/ e pages/, SvelteKit, Astro, Nuxt, Remix, HTML estático;
layouts cobrem as rotas abaixo deles, layout raiz e `_app` cobrem todas) e por um grafo de imports
que resolve aliases do tsconfig, `#imports` e pacotes do workspace. O JSON lista cada rota com
`reasons`, `confidence` e `change` (`added`, `removed`, `modified`), mais:

- `unmatched`: arquivos de UI sem rota. Ache as páginas você mesmo e passe com `--routes`.
- `unmatchedMaybe`: `.js`/`.ts` fora de pastas de interface sem rota; pode ser só backend.
- `needsExample`: rotas dinâmicas (`/blog/[slug]`). Ache um id real e passe `--routes /blog/ola`
  (ou ponha o exemplo em `routes` no config, que ele passa a ser usado sozinho).
- `notes` e `droppedRoutes`: rotas cortadas por `detect.maxRoutes`, dica de `appDir` em monorepos.

Se nenhum arquivo de UI mudou, diga isso e pare; não gere relatório vazio. Diga ao usuário em uma ou
duas linhas quais rotas vai capturar e por quê. Guarde as rotas afetadas que não serão capturadas
(login, modais, limites): elas vão no resumo, para "sem mudança" não ser lido como "tudo certo".

## 3. Capturar e comparar

O `run` sobe dois servidores e faz dezenas de capturas: **rode com timeout de 10 minutos**
(`timeout: 600000` na ferramenta Bash) **ou em segundo plano**, acompanhando o stderr. A primeira
linha do stderr traz uma estimativa. Se o processo for morto, o próximo `run` limpa servidores e
worktrees que sobraram (ou rode `cleanup`).

```bash
node "$SKILL/bin/visual-diff.mjs" run --pr <n> [--routes "/,/precos"] [--viewports desktop,mobile] [--themes light,dark]
```

Numa tacada só: cria worktrees para base (o merge-base) e head, prepara as dependências (liga o
`node_modules` ou instala quando o lockfile mudou), sobe os dois lados ao mesmo tempo em portas
livres, captura rota × viewport × tema alternando base e head, compara com alinhamento vertical
(conteúdo que só desceu não conta como alterado, mas o deslocamento é reportado), monta as imagens
(página inteira e recortes das regiões alteradas) e limpa tudo. As capturas são determinísticas:
animações zeradas, fontes e imagens aguardadas, `Math.random` e `crypto` com semente, relógio
congelado, vídeos pausados, iframes mascarados, analytics e chats bloqueados, e cada screenshot é
refeito até duas capturas seguidas serem iguais.

O stdout traz um resumo (`stats`, `changed`, `added`, `removed`, `failed`, `warnings`,
`notCaptured`); o detalhe fica em `.visual-diff/report.json` (`--json full` imprime tudo). Cada
item tem `kind`: `content` (pixels mudaram), `layout-shift` (só espaçamento: veja `shifts`),
`added` (página nova) ou `removed`. Use `--themes light,dark` quando cores ou tokens mudaram.

- Ajustar sem recapturar: mude `diff.*` no config e rode `diff`.
- Recapturar uma rota ou chave: `run … --only /precos` (ou `--only home__mobile__light`).
- Se falhar, o erro diz a etapa (`step`) e o log fica em `.visual-diff/logs/`; veja
  `references/troubleshooting.md`, corrija a causa e rode de novo. Um `run` que falha não apaga o
  relatório anterior. Nunca publique resultado de um lado só.

## 4. Revisar e escrever o resumo de UX

Abra as imagens antes de escrever (primeiro os recortes `compare/*__focus-*.png`, depois as
composições inteiras). Leia `.visual-diff/report.json` para os números e parta de
`.visual-diff/summary.auto.md`. Escreva `.visual-diff/summary.md` para um designer ou PM que não vai
ler o código (o `run` move um `summary.md` antigo para `summary.prev.md`):

```markdown
**O que mudou**
- **Botão principal**: mais preenchimento e cantos mais arredondados. O link ao lado anda para a direita.
- **Newsletter**: o rótulo "E-mail de trabalho" agora usa a cor da marca.

**Vale olhar**
- No tema escuro o rótulo azul sobre o fundo escuro parece ter pouco contraste.

**Não verificado:** `/configuracoes` (precisa de login).
```

Diretrizes: comece "vale olhar" pelo que parece não intencional (página que mudou sem seus arquivos
mudarem, quebra em um viewport só, contraste, valores fora do design system, problemas novos de
acessibilidade). Para `layout-shift`, diga que o conteúdo abaixo de y desceu N px em vez de chamar
as seções de alteradas. Um aviso de "não estabilizou" aponta algo que se mexe sozinho e sugere um
seletor: não descreva isso como mudança e sugira `capture.mask`. Diga "mudou", não "mudou
intencionalmente". Seja proporcional: uma cor trocada vale um item. Se não conseguir ver imagens,
escreva a partir do `report.json` e diga isso.

```bash
node "$SKILL/bin/visual-diff.mjs" render     # prévia: .visual-diff/comment.preview.md
```

## 5. Publicar um comentário fixo

Publicar escreve num PR compartilhado e envia uma branch: mostre o resumo ao usuário e peça um sim
antes, a não ser que o pedido já tenha dito para publicar.

```bash
node "$SKILL/bin/visual-diff.mjs" publish --pr <n> --dry-run   # lista uploads e problemas; não envia nada
node "$SKILL/bin/visual-diff.mjs" publish --pr <n> --verify
```

- Leia `publishable` e `problems` do dry run. Itens com `[bloqueia]` param a publicação real: repo
  público ou interno, visibilidade desconhecida, relatório de outro commit (o PR recebeu commits
  depois do `run`: rode de novo), relatório da árvore de trabalho com mudanças locais, ou um
  `summary.md` mais velho que o relatório. Conte ao usuário; não adicione `--allow-*`,
  `--assume-private` ou `--force-stale` por conta própria.
- As imagens vão para a branch órfã `visual-diff-assets` (um único commit, arquivos de outros PRs
  mantidos) e são linkadas como `https://github.com/<dono>/<repo>/raw/visual-diff-assets/…`, que só
  renderiza para quem pode ler o repo. `--verify` confere os arquivos na branch e que o link pede login.
- O comentário é achado por um marcador oculto e editado no lugar; o de outra pessoa nunca é
  editado (um novo é criado e o resultado avisa).
- Sem PR ainda: use `render` e ofereça publicar quando o PR existir.

| Saída | Significado |
|---|---|
| código 0, `status: ok` | relatório gerado |
| código 0, `status: no-ui-changes` | nenhum arquivo de UI mudou: diga isso e pare |
| código 0, `status: no-mapped-routes` | só `.js`/`.ts` que podem ser backend; decida se passa `--routes` |
| código 2, `status: no-mapped-routes` | UI alterada sem rota: ache as páginas e passe `--routes` |
| código 1 | erro (o JSON traz `error` e `step`) |
| código 3 | git não conseguiu enviar (permissão, fork, regra que bloqueia force-push): `--no-upload` |
| código 4 | publicação recusada (veja `problems`) |
| código 130/143 | interrompido; servidores e worktrees foram limpos |

## 6. Fechamento

Informe o link do comentário, as contagens, os itens de "vale olhar" e o que não foi capturado. Se
você descobriu rotas, máscaras ou ids dinâmicos, ofereça salvá-los em `visual-diff.config.json`.
Depois que PRs fecham, `node "$SKILL/bin/visual-diff.mjs" prune --closed` remove as imagens deles.

Todas as opções de config: `references/config.md`. Variantes, acessibilidade, movimento e tokens:
`references/audits.md`. Hospedagem, privacidade e previews protegidos: `references/privacy.md`.
Falhas e capturas instáveis: `references/troubleshooting.md`. Teste da publicação num repo de
sandbox: `references/publish-test.md`.
