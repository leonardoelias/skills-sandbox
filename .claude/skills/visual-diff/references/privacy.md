# Privacidade e hospedagem das imagens

Screenshots de código privado são tão sensíveis quanto o código. Por isso o `publish`:

- grava as imagens na branch órfã `visual-diff-assets` do **repositório do PR** (tirado da URL do
  PR, então fork e upstream não se misturam), usando git plumbing com um índice temporário (a árvore
  de trabalho, o índice e as branches locais não são tocados);
- linka como `https://github.com/<dono>/<repo>/raw/visual-diff-assets/pr-<n>/<execução>/<arquivo>`,
  que só renderiza para quem está logado e pode ler o repositório;
- mantém a branch com **um único commit** (substituído com `--force-with-lease`, com até 4
  tentativas se outra publicação mexeu na branch ao mesmo tempo), preserva os arquivos de outros PRs
  e descarta execuções antigas do mesmo PR, para os clones não incharem;
- checa a visibilidade antes e **recusa repositórios públicos** (a menos que o usuário passe
  `--allow-public-repo`) e **INTERNAL** (visíveis para todos da empresa no GitHub Enterprise; exige
  `--allow-internal-repo`); visibilidade desconhecida exige `--assume-private`;
- recusa relatórios de outro commit (o PR recebeu commits depois do `run`), da árvore de trabalho
  com mudanças locais e com um `summary.md` mais velho que o relatório;
- edita só o comentário do próprio usuário; se o existente for de outra pessoa (ou do bot do CI),
  cria um novo e avisa.

`publish --verify` confere, depois do envio, que cada arquivo existe na branch (pela API, com o seu
login) e que o link devolve 404 sem login.

## Antes de publicar

Olhe as imagens. Servidores de dev podem mostrar dados reais (banco de produção, e-mails de
clientes, tokens na tela, nomes em avatares). Mascare com `capture.mask` e rode de novo.

## Trade-offs e limites

- Todo mundo com leitura no repo (inclusive colaboradores externos) pode abrir as imagens.
- Clones completos baixam o snapshot atual de assets (`git clone --single-branch` evita).
- O `prune` troca o commit da branch, mas não apaga do histórico do GitHub: os objetos antigos
  continuam acessíveis por SHA por um tempo, e imagens podem continuar em caches (camo, CDN).
  Para remover algo sensível de verdade, é preciso o suporte do GitHub.
- GitHub Mobile e notificações por e-mail podem não renderizar as imagens.
- O commit leva `[skip ci]` para não disparar workflows `on: push`. Rulesets ou branch protection
  que proíbem force-push em todas as branches (`*`) bloqueiam a publicação (código 3): exclua
  `visual-diff-assets` da regra (Settings → Rules → Rulesets → Target branches → Exclude) ou use
  `--no-upload`.

Alternativas: comentário só com texto (`--no-upload`), ou artefatos do CI.

## Previews protegidos e páginas com login

Cabeçalho para previews (Vercel Authentication e similares):

```json
{ "auth": { "headers": { "x-vercel-protection-bypass": "$VERCEL_AUTOMATION_BYPASS_SECRET" } } }
```

```bash
VERCEL_AUTOMATION_BYPASS_SECRET=… node "$SKILL/bin/visual-diff.mjs" run \
  --base-url https://app-git-main-acme.vercel.app --head-url https://app-git-feature-acme.vercel.app --routes /,/precos
```

Cookies vindos do ambiente, ou uma sessão gravada por você no navegador:

```json
{ "auth": { "cookies": [{ "name": "session", "value": "$APP_SESSION" }], "origins": ["local"] } }
```

```bash
node "$SKILL/bin/visual-diff.mjs" login --url http://localhost:3000/login   # entre e feche a janela
```

```json
{ "auth": { "storageState": ".visual-diff/auth/storage-state.json", "origins": ["local"] } }
```

- O valor no config é sempre uma referência `"$NOME"`; um valor literal é recusado.
- `auth.origins` diz onde as credenciais valem: `previews` (padrão) e/ou `local`. Sem uso, as
  variáveis nem são lidas (um run local não exige a variável do preview).
- Cabeçalhos e cookies só vão para a origem do lado, nunca para terceiros carregados pela página.
- O arquivo do `login` fica em `.visual-diff/` (excluída do git) com permissão 600. Não o commite.
- Uma rota que redireciona para uma página de login aparece em `notCaptured`, não como "sem mudança".
- Nunca crie links de compartilhamento ou URLs com token de bypass, e nunca imprima o segredo: os
  valores são removidos dos logs, erros e relatórios.
