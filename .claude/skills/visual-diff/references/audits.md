# Variantes, acessibilidade, movimento e design tokens

Todos são opcionais e desligados por padrão. Rodam na mesma execução do `run` e aparecem no
`report.json`, no `summary.auto.md` e no comentário.

## Variantes (`?param=1..n`)

Para comparar versões alternativas de uma mesma página (heróis, layouts de teste A/B) controladas
por query string. Só o head é capturado; o resultado é uma faixa com uma coluna por valor e, no
comentário, uma tabela com caixas de seleção para o revisor marcar a preferida.

```json
{ "routes": [{ "path": "/", "variants": { "param": "hero", "values": "1..4", "viewports": ["desktop"], "themes": ["light"] } }] }
```

Ou na linha de comando: `run --variants "/:hero=1..4;/precos:plano=basico,pro"`. No máximo 12 valores.
Sem `viewports`/`themes`, usa o primeiro de cada.

## Acessibilidade (axe-core)

```json
{ "audits": { "a11y": true } }
```

Roda o axe (regras WCAG 2.0, 2.1 e 2.2, níveis A e AA) em cada captura dos dois lados e compara por
regra + seletor. Cada item alterado ganha `a11y: { added, resolved, unchanged }`; o comentário mostra
o que é novo e o que foi resolvido. Páginas novas listam todas as violações como novas. A ordem de
foco por Tab ainda não é comparada.

## Movimento (GIF antes | depois)

```json
{
  "audits": { "motion": true },
  "motion": { "durationMs": 2500, "fps": 10, "maxWidth": 360 },
  "routes": [{ "path": "/", "motion": { "steps": [{ "hover": ".btn" }, { "wait": 400 }, { "click": "#menu" }] } }]
}
```

Para rotas alteradas (todas com `audits.motion`, ou só as que têm `routes[].motion`), grava a tela
com animações ligadas no primeiro viewport e tema, nos dois lados, enquanto roda os passos, e monta
um GIF lado a lado. `changed` diz se os dois lados diferem quadro a quadro. Passos: `hover`, `click`,
`focus`, `type: { selector, text }`, `press: "Tab"`, `scroll` (px ou seletor), `wait` (ms).
Seletores ausentes são pulados e listados nos avisos.

## Design tokens

```json
{ "audits": { "tokens": { "include": ["--color-*", "--space-*"], "colorTolerance": 0.02, "allow": ["rgb(255, 255, 255)"] } } }
```

(`"tokens": true` usa os padrões.) Lê os tokens das CSS custom properties de `:root` (cores e
comprimentos), coleta os estilos computados dos elementos dentro das regiões alteradas no head
(cores de texto, fundo, borda, outline, fill/stroke; margin, padding e gap) e reporta valores que não
batem com nenhum token: cores pela distância em OKLab até o token mais próximo, espaçamentos por
igualdade. Só entram achados **novos**, que não existiam em lugar nenhum da mesma página no base.

Limites: tokens só de CSS custom properties (não lê JSON nem StyleX); no Tailwind v4 o espaçamento
é um único `--spacing` multiplicado, então só esse valor conta como token de espaçamento.
