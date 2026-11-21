# Problemas comuns

## O run demora ou foi morto pelo timeout

- Rode com timeout de 10 min ou em segundo plano. A primeira linha do stderr estima o tempo.
- Se o processo morreu (timeout, `kill -9`), o próximo `run` mata os servidores e remove as
  worktrees que sobraram. Para limpar já: `cleanup` (`cleanup --all` remove também as worktrees de
  `cache.worktrees`). `doctor` avisa quando há worktrees órfãs.
- Acelerar: build de produção no `startCommand`, menos viewports/temas, `capture.concurrency` maior,
  `cache.worktrees: true` para reaproveitar `node_modules` e `.next` entre execuções. Recapturas do
  mesmo PR reaproveitam as capturas do base em cache.

## O servidor nunca fica pronto (`step: start:base` / `start:head`)

- Confira se `startCommand` usa `{port}` (ou lê `PORT`) e se `baseUrl` tem `{port}`. Os dois lados
  sobem ao mesmo tempo em portas diferentes. `doctor --smoke` testa o comando no checkout atual.
- Use `"baseUrl": "http://localhost:{port}"`: Vite costuma escutar só em `::1`, e o Next.js bloqueia
  recursos de dev para `127.0.0.1`.
- Boot lento (Next frio, monorepo grande): aumente `startTimeoutMs`.
- Faltou variável de ambiente: o fim do log aparece no erro; o log completo está em
  `.visual-diff/logs/<lado>.log`. Ponha valores não secretos em `env`; segredos vêm do seu shell.
- Dependências: com `deps: "auto"`, o `node_modules` é ligado e a instalação roda quando o lockfile
  muda ou o app usa Turbopack (que recusa links para fora do projeto). Se o servidor falhar com os
  links, a instalação roda e o servidor tenta de novo. Force com `"deps": "install"`.

## "Nenhuma mudança de UI", `no-mapped-routes` ou arquivos em `unmatched`

- Rode `detect` e leia os `reasons` e as `notes`.
- Monorepo: defina `appDir` (o `init` sugere). Pacotes do workspace são resolvidos pelo `name`.
- Alias que não está no tsconfig (ex.: só no `vite.config`): `detect.aliases`.
- `unmatchedMaybe` lista `.js`/`.ts` que podem ser só backend; se afetarem a tela, passe `--routes`.
- Ou mapeie com `routes[].files`, ou passe as rotas direto: `--routes /,/precos`.

## Diferenças entre commits idênticos (falsos positivos)

- Rode `run --base HEAD --head HEAD --routes /`: tudo deveria sair sem diferença.
- O aviso "não estabilizou" diz onde algo se mexe e sugere um seletor: use `capture.mask` ou
  `capture.hide`. Depois de 2 mudanças, timers e animações são pausados; se só assim estabilizou,
  o aviso também aparece.
- Datas na página: `capture.fixedTime` (padrão `"run-start"`).
- Fontes remotas lentas: aumente `capture.settleMs`. Conteúdo que carrega tarde: `waitFor`.
- Widgets de terceiros: os conhecidos já são bloqueados; acrescente outros em `capture.blockHosts`.

## Só espaçamento mudou

Itens com `kind: "layout-shift"` não têm pixels de conteúdo diferentes, mas o conteúdo se deslocou
(`shifts`: "abaixo de y desceu N px"). No Diff, a faixa âmbar à esquerda marca o que só se deslocou,
o verde marca espaço inserido e a linha magenta marca onde algo foi removido.

## Tema escuro igual ao claro

O aviso "as capturas de light e dark são idênticas" quer dizer que o tema não foi aplicado. Se o
app troca o tema por classe ou localStorage (next-themes), use `themes[].localStorage`,
`themes[].cookie` ou `themes[].htmlClass`.

## Página nova, removida ou que redireciona

- Página nova (404 no base, 200 no head) vira item `added`; removida vira `removed`. Outros
  4xx/5xx são falha e aparecem em `failed`.
- Redirecionamento para login aparece em `notCaptured`: configure `auth` (ver `privacy.md`).
  Outros redirecionamentos (ex.: `/` → `/en`) são capturados com aviso; ajuste `capture.locale`.

## Páginas muito longas

Acima de `capture.maxHeight` (8000 px CSS) a captura é cortada e o item marcado `truncated`; o que
entra pelo corte por causa de um deslocamento não conta como alteração. Feeds infinitos param em
`capture.maxScrollSteps`.

## Publicação recusada

- `problems` do `publish --dry-run` explica; os itens `[bloqueia]` param a publicação.
- PR recebeu commits depois do run: `run --pr <n>` de novo.
- `summary.md` mais velho que o relatório: reescreva ou apague.
- Código 3: sem permissão de push (fork, token sem `contents: write`) ou regra que bloqueia
  force-push na branch de assets (ver `privacy.md`). Use `--no-upload`.

## Debug

- `--keep-worktrees` mantém as worktrees e imprime onde estão.
- `--json full` imprime o relatório inteiro.
- `VISUAL_DIFF_BROWSER_CHANNEL=chrome` usa o Chrome instalado.
