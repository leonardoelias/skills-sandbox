# visual-diff.config.json

Fica na raiz do repositório. Todas as chaves são opcionais; `init` sugere um ponto de partida.
O config é validado: uma chave desconhecida ou com tipo errado faz o comando parar, com sugestão
("você quis dizer `capture`?"). O JSON Schema está em `visual-diff.schema.json` (o `init` referencia
o arquivo em `$schema` quando a skill está dentro do repo, para o editor completar e validar).

```json
{
  "$schema": "./.claude/skills/visual-diff/visual-diff.schema.json",
  "appDir": "apps/web",
  "startCommand": "npm run dev -- --port {port}",
  "baseUrl": "http://localhost:{port}",
  "installCommand": null,
  "deps": "auto",
  "startTimeoutMs": 90000,
  "env": { "NEXT_TELEMETRY_DISABLED": "1" },
  "routes": [
    { "path": "/", "files": ["src/app/page.tsx", "src/components/Hero/**"] },
    { "path": "/precos", "files": ["src/app/precos/**"], "waitFor": "[data-loaded]" },
    { "path": "/blog/ola" }
  ],
  "globalFiles": ["src/styles/**", "tailwind.config.*"],
  "viewports": ["desktop", "mobile", "tablet:820x1180@2"],
  "themes": [{ "name": "light" }, { "name": "dark", "colorScheme": "dark", "localStorage": { "theme": "dark" } }],
  "capture": { "mask": ["[data-testid=timestamp]"], "hide": [".cookie-banner"], "locale": "pt-BR", "maxHeight": 8000 },
  "diff": { "threshold": 0.1, "focusRegions": 3 },
  "detect": { "maxRoutes": 10, "aliases": { "~": "src" } },
  "auth": { "headers": { "x-vercel-protection-bypass": "$VERCEL_AUTOMATION_BYPASS_SECRET" } },
  "audits": { "a11y": true },
  "publish": { "branch": "visual-diff-assets", "marker": "default" }
}
```

## Servidor

| Chave | Padrão | |
|---|---|---|
| `appDir` | `"."` | Subpasta do app num monorepo. Comandos rodam nela; rotas por convenção são relativas a ela. Arquivos fora dela (pacotes compartilhados) entram pelo grafo de imports. |
| `startCommand` | `npm run dev -- --port {port}` | `{port}` é trocado por uma porta livre (também exportada como `PORT`). `static:<pasta>` usa o servidor estático embutido. Builds de produção (`npm run build && npm run start -- -p {port}`) capturam mais rápido e sem overlays de dev. |
| `baseUrl` | `http://localhost:{port}` | Onde esperar a resposta. Use `localhost`, não `127.0.0.1`: Vite costuma escutar só em IPv6 e o Next bloqueia recursos de dev para `127.0.0.1`. |
| `deps` | `"auto"` | `auto`: cria um `node_modules` cujas entradas são links para o do checkout principal (pacotes do workspace apontam para a própria worktree) e instala quando o lockfile difere ou o app usa Turbopack (Next 16+ ou `--turbo`). `link`: nunca instala. `install`: sempre instala. Se o servidor falhar com links, instala e tenta de novo. |
| `installCommand` | inferido | Comando de instalação. Sem ele, vem do lockfile mais próximo (subindo até a raiz): `npm ci`, `pnpm install --frozen-lockfile`, `yarn install --immutable`/`--frozen-lockfile`, `bun install --frozen-lockfile`. |
| `startTimeoutMs` | `90000` | Quanto esperar o servidor responder. |
| `env` | `{}` | Variáveis extras para o servidor (sem segredos; segredos vêm do seu ambiente). |

## Rotas e detecção

- `routes[].path`: caminho capturado (pode ter query: `/busca?q=teste`). Um exemplo concreto de uma
  rota dinâmica (`/blog/ola` para `app/blog/[slug]/page.tsx`) passa a ser usado sozinho pela detecção.
- `routes[].files`: globs (relativos a `appDir` ou à raiz) que, se mudarem, afetam essa rota.
- `routes[].waitFor`: seletor CSS ou `"js:<expressão>"` que precisa ficar verdadeiro antes da captura.
- `routes[].variants` e `routes[].motion`: ver `audits.md`.
- `globalFiles`: globs que afetam todas as rotas configuradas (ou, sem rotas configuradas, todas as
  rotas descobertas por convenção).
- `detect.uiExtensions`, `detect.ignore`, `detect.maxRoutes`: filtros da detecção.
- `detect.maxDepth` (6): quantos níveis de import subir até achar uma página ou layout.
- `detect.aliases`: aliases que não estão no tsconfig (ex.: os do `vite.config`), relativos a `appDir`.

A detecção já entende `paths`/`baseUrl` do tsconfig e jsconfig (seguindo `extends`), `imports`
(`#x`) do package.json, `$lib` do SvelteKit e pacotes do workspace (npm, yarn, bun e pnpm). Globs
aceitam `**`, `*`, `?` e `{a,b}`; um glob que nomeia uma pasta casa com tudo dentro dela.

## Captura

| Chave | Padrão | |
|---|---|---|
| `viewports` | `desktop, mobile` | Presets `desktop` (1280×800), `tablet` (820×1180 @2x), `mobile` (390×844 @2x), ou `nome:LxA@escala`, ou objetos `{ name, width, height, deviceScaleFactor, isMobile }`. |
| `themes` | `light` | `{ name, colorScheme, query, localStorage, cookie, htmlClass, htmlAttr }`. `colorScheme` emula `prefers-color-scheme`; `query` vai na URL; `localStorage`/`cookie` são gravados antes da página carregar (next-themes e similares); `htmlClass`/`htmlAttr` vão no `<html>`. Se dois temas saem idênticos, o relatório avisa. |
| `capture.mask` | `[]` | Seletores pintados de magenta nos dois lados (datas, avatares aleatórios, dados ao vivo). |
| `capture.maskEmbeds` | `["iframe"]` | Mesma coisa para conteúdo embutido; acrescente `"canvas"` ou `"video"` se precisar. |
| `capture.hide` | `[]` | Seletores escondidos com `visibility: hidden` (banners de cookie, widgets de chat). |
| `capture.fullPage` | `true` | Página inteira ou só a primeira dobra. |
| `capture.maxHeight` | `8000` | Altura máxima (px CSS); páginas maiores são cortadas e marcadas `truncated`. |
| `capture.maxScrollSteps` | `40` | Teto de passos de rolagem para disparar lazy-loading (feeds infinitos). |
| `capture.fixedTime` | `"run-start"` | Congela `Date` nos dois lados (`"run-start"`, uma data ISO ou `null`). Os timers continuam rodando. |
| `capture.locale`, `capture.timezone` | `en-US`, `UTC` | Idioma e fuso do navegador. Troque o idioma se o app redireciona por idioma. |
| `capture.networkIdleMs` | `2500` | Quanto esperar a rede ficar ociosa (servidores de dev com HMR nunca ficam). |
| `capture.waitFor` | `null` | Como `routes[].waitFor`, para todas as rotas. |
| `capture.blockHosts` | `[]` | Hosts extras a bloquear (`"widget.exemplo.com"` ou `"exemplo.com/pixel"`). |
| `capture.blockDefaultHosts` | `true` | Bloqueia analytics, chats e pixels conhecidos (Google Analytics, Segment, Hotjar, Intercom, Sentry…). |
| `capture.settleMs`, `capture.maxRetakes` | `250`, `4` | Espera entre capturas e quantas vezes refazer até estabilizar. Depois de 2 mudanças, timers e animações são pausados. |
| `capture.concurrency` | `2` | Quantas chaves capturar ao mesmo tempo (cada uma abre uma página por lado). |

## Diff

| Chave | Padrão | |
|---|---|---|
| `diff.threshold` | `0.1` | Sensibilidade do pixelmatch (0 a 1; menor = mais sensível). |
| `diff.rowTolerance` | `0.003` | Fração da largura que pode diferir para duas linhas ainda contarem como "a mesma" no alinhamento (absorve rasterização diferente em páginas altas). |
| `diff.focusRegions` | `3` | Quantos recortes ampliados por captura. O comentário diz quantas regiões havia no total. |
| `diff.maxFocusArea` | `0.4` | Regiões maiores que essa fração da imagem não viram recorte (a página inteira já mostra). |
| `diff.composeFormat` | `"jpeg"` | Formato da composição de página inteira (os recortes são sempre PNG). |

Depois de mudar `diff.*`, `visual-diff diff` refaz as imagens sem recapturar.

## Autenticação

| Chave | |
|---|---|
| `auth.headers` | `{ "cabeçalho": "$VARIAVEL" }`. O valor é sempre uma referência a variável de ambiente. |
| `auth.cookies` | `[{ "name", "value": "$VARIAVEL", "domain"?, "path"? }]`. Sem `domain`, vale para a origem de cada lado. |
| `auth.storageState` | Arquivo gerado por `visual-diff login --url <login>` (padrão `.visual-diff/auth/storage-state.json`, fora do git). |
| `auth.origins` | `["previews"]` (padrão), `["local"]` ou os dois: onde as credenciais são usadas. Sem uso, as variáveis nem são lidas. |

Os valores secretos são removidos de logs, erros e relatórios. Detalhes em `privacy.md`.

## Auditorias, variantes e movimento

`audits.a11y`, `audits.tokens`, `audits.motion`, `motion.*` e `routes[].variants`: ver `audits.md`.

## Cache

| Chave | Padrão | |
|---|---|---|
| `cache.base` | `true` | Guarda as capturas do base em `.visual-diff/cache/` (chave: commit + config + rota/viewport/tema). Se todas estão em cache, o servidor do base nem sobe. `--no-cache` ignora. |
| `cache.worktrees` | `false` | Mantém as worktrees por commit (com `node_modules` e `.next`/`.vite` aquecidos) entre execuções. `cleanup --all` remove. |

## Publicação

| Chave | |
|---|---|
| `publish.branch` | Branch órfã das imagens. |
| `publish.marker` | Id do comentário fixo; use ids diferentes para ter mais de um comentário por PR (ex.: um por app num monorepo). |
| `publish.repo` | `owner/repo` (ou `host/owner/repo`) onde o PR vive, quando não é o do remote. Normalmente vem da URL do PR. |
| `publish.remote` | Remote git usado para enviar as imagens (padrão: o que aponta para o repositório do PR, senão `origin`). |
| `publish.host` | Host do GitHub Enterprise Server (ex.: `github.empresa.com`). `GH_HOST` também é aceito. |

## Variáveis de ambiente

- `VISUAL_DIFF_BROWSER_CHANNEL=chrome` usa o Chrome instalado em vez do Chromium do Playwright.
