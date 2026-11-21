---
name: ritmo
description: "Mede o espaço vertical que se vê numa interface, de tinta a tinta, desenha uma faixa colorida por valor em cada espaço, acha os que quebram o ritmo e corrige no container: gap fora da escala, irmãos com espaços diferentes, grupos que se misturam porque o espaço de dentro é igual ao de fora, título mais perto do bloco de cima que do seu, caixa com mais espaço em cima que embaixo, e o mesmo token aparecendo com valores diferentes por causa do line-height. Use para um passe de espaçamento vertical, ritmo vertical, \"o espaçamento está estranho\", \"está tudo grudado\", \"está tudo solto\", seções que não respiram, cards desiguais, botão com texto baixo, ou para aplicar text-box-trim. Gatilhos: ritmo, ritmo vertical, vertical rhythm, spacing pass, espaçamento vertical, gap, margin, proximidade, text-box-trim, leading-trim, baseline, padding de botão, Refactoring UI."
---

# Ritmo

Meça o espaço que se vê, depois mexa no código. Num passe de espaçamento feito no olho, o mesmo `gap-4` vira 19px num lugar e 31px em outro, e ninguém sabe dizer qual era a intenção. Medido de tinta a tinta, cada container acaba com uma escada de três ou quatro degraus, e cada espaço está num degrau ou tem um motivo escrito para não estar.

Fontes: o capítulo de layout e espaçamento do *Refactoring UI* (Wathan e Schoger): "avoid ambiguous spacing", mais espaço em volta de um grupo do que dentro dele, e uma escala em que dois valores nunca ficam a menos de uns 25% um do outro. Também os princípios de proximidade e de região comum da Gestalt, e o `text-box` do CSS (Inline Layout Level 3), que corta a entrelinha para o espaço do código ser o espaço que se vê.

Esta skill cuida do espaço vertical entre blocos empilhados e do espaço de cima e de baixo dentro das caixas. As bordas horizontais e o centro das linhas de uma barra são do gridlines. Área de toque, tamanho de fonte e o line-height entre linhas de um parágrafo são de outras skills.

## Antes de começar

1. Leia a política de design do projeto. Se ela registra uma escada ("8px dentro de um item, 16px entre itens, 32px entre grupos, 64px entre seções") ou os tokens de espaço, esses valores são o alvo. Não os derive de novo e não os mude sem a aprovação de quem cuida deles.
2. Rode o app localmente, com dados reais sempre que der. Estados vazios e telas deslogadas escondem a maior parte das pilhas que quebram. Se só conseguiu ver estados vazios, diga isso no relatório.

## Processo

Siga estes passos em ordem em cada página, painel e sobreposição do escopo.

### 1. Medir

Injete o `probe.js` (nesta pasta) e chame `window.__ritmo()`. Há dois jeitos:

- **Headless:** `node <pasta desta skill>/audit.mjs <url> .ritmo [largura] [prep.mjs]`. O script procura o Playwright em `PW_DIR`, depois na pasta atual, depois na skill visual-diff ao lado. Se não achar, instale numa pasta de rascunho (`npm i --prefix <rascunho> playwright`, `npx --prefix <rascunho> playwright install chromium`) e aponte `PW_DIR` para ela. Um `prep.mjs` que exporta `async (page) => {}` abre o menu, a aba ou o diálogo a medir.
- **Navegador ao vivo:** cole o `probe.js` na página com o evaluate da ferramenta de navegador e chame `window.__ritmo()`.

Opções (no navegador, como objeto; no headless, como variáveis de ambiente): `root`/`ROOT` mede só uma parte; `ignore`/`IGNORE` pula seletores; `scale`/`SCALE` (`4,8,12,16,24,32,48,64`) ou `step`/`STEP` (`4`) fixa a escala; `ink`/`INK=1` contorna a tinta medida de cada bloco. Sem escala informada, o probe usa `--spacing` (Tailwind 4), depois os tokens `--space-*`, `--spacing-*`, `--gap-*` do `:root`, e por último presume múltiplos de 4px. Com a escala presumida, as distâncias fora da grade saem como `NOTA escala presumida` e não contam como falha, porque a grade é um palpite: passe `SCALE` ou `STEP` (ou defina os tokens no projeto) para valerem.

Meça em 1440px e em 390px. Abra cada sobreposição que a página tem: menus, popovers, diálogos, sheets, a paleta de comandos. Salve as capturas em `.ritmo/` no projeto e mantenha essa pasta fora do controle de versão.

O probe mede tinta, não caixas. A tinta de um texto vai da altura das maiúsculas até a linha de base, a mesma convenção do `text-box: trim-both cap alphabetic`; descendentes não contam. A tinta de uma caixa (fundo diferente do pai, borda nos quatro lados ou sombra), imagem, ícone ou campo é a própria caixa. Uma borda só em cima ou só embaixo, ou uma sombra de 1px num eixo só, é uma divisória e conta como linha. Para cada pai com filhos empilhados, o probe acha o bloco diretamente abaixo de cada filho e desenha o espaço entre eles: **uma faixa por espaço, com a mesma cor para o mesmo valor**, o número ao lado, e um contorno vermelho nas falhas. Nas caixas com falha, pinta de vermelho o espaço de cima e o de baixo.

Uma página com ritmo tem poucas cores. Muitas cores parecidas (15, 16, 17, 19) são o primeiro sinal.

### 2. Ler

Para cada região do resumo, anote a distribuição de espaços na tinta: é a escada que a página usa de fato. Depois liste cada `FALHA`: o tipo, onde está, os valores. Cada tipo:

- `escala`: a distância entre as caixas, que é o valor que está no código, não é um token.
- `irmãos`: pares equivalentes (o mesmo componente, o mesmo par de filhos) com espaços visíveis diferentes. Com dois pares e dois valores, o probe pede para você decidir qual vale.
- `proximidade`: o espaço entre dois blocos é igual ou menor que o maior espaço dentro de um deles. Os grupos se misturam.
- `título`: o título tem espaço acima menor ou igual ao de baixo, então parece pertencer ao bloco de cima.
- `caixa`: a caixa tem espaço de cima diferente do de baixo, medido na tinta.
- `NOTA entrelinha`: o mesmo espaço de código aparece na tela com valores diferentes por causa do line-height.

Olhe a captura também. O probe pode errar quem está "diretamente abaixo" em layouts incomuns. Confirme cada falha no olho antes de corrigir.

### 3. Decidir a escada

Para cada região, siga esta árvore:

```
A política do projeto registra a escada?
├── Sim → use. Fim.
└── Não
    ├── A região divide uma pilha com uma vizinha (seções irmãs, cards da mesma lista)?
    │   └── Sim → use os degraus da vizinha. Pilhas irmãs têm uma escada só.
    └── Não → parta dos valores que a maioria dos pares já usa e junte-os em 3 ou 4 degraus da escala.
```

Depois dê um papel a cada par: **dentro** de um item (título e meta, rótulo e campo), **entre** itens de uma lista, **entre grupos** e **entre seções**. Cada papel ocupa um degrau, e cada degrau fica a pelo menos 1,5× o anterior. Um espaço que não é nem um degrau nem outro, como 20px entre um degrau de 16 e um de 24, é lido como engano.

### 4. Corrigir

- **Mova o par fora do padrão, nunca a maioria.** Se 9 pares estão a 16px e um está a 12px, o de 12 muda.
- **Corrija no container da pilha:** o `gap` do pai flex ou grid, ou um token de pilha que todos os filhos leem (`--stack-gap`, `--section-gap`). Nunca corrija com margem solta num item (`mt-[3px]`, `-mt-1`, `style="margin-top: -4px"`), porque o próximo item que entrar nessa pilha erra de novo.
- **Troque margem por `gap` quando mexer na pilha.** Margem colapsa, vaza para fora do componente e quebra quando a ordem dos filhos muda.
- **Use os tokens de espaço do projeto.** Se o espaço pede um valor fora da escala, quem está errado é a estrutura (o item está no grupo errado ou falta um wrapper), não a escala.
- Quando remover um espaço que alguém escolheu de propósito (um comentário explica), atualize o comentário com o novo motivo.

### 5. Medir de novo

Rode o probe outra vez nos mesmos estados. Para passar: nenhuma falha que não esteja registrada como exceção; pares equivalentes a 1px um do outro; cada região com no máximo quatro valores de espaço além dos degraus de seção. O 1px de folga é o arredondamento das métricas da fonte; 2px ou mais é falha. Confira que os 390px não quebraram: pilhas que viram coluna no celular têm de ganhar os mesmos degraus.

### 6. Registrar e relatar

Registre a escada nova na política de design do projeto, ao lado das regras de espaço que já existem, com a data e quem decidiu. Relate uma tabela por página (onde, antes, depois), as capturas inline e uma lista de "não verificado": estados que você não alcançou e espaços que deixou de propósito.

```markdown
| Onde | Antes | Depois |
|---|---|---|
| Novembro, entre entradas | 15px, igual ao de dentro (gap 4px) | 27px (gap 16px) |
| "Setembro" | 25px acima, 30px abaixo | 45px acima, 30px abaixo (margin-top 32px) |
| Botão "Receber por e-mail" | 16px em cima, 11px embaixo | 14px e 14px (padding 9px) |
```

## As regras

### A tinta é a medida

O leitor vê letras e formas, não caixas. Um `gap-4` entre um título de 44px com `line-height: 1.15` e um parágrafo de 18px com `line-height: 1.6` aparece como 32px, porque a meia-entrelinha e o espaço acima das maiúsculas somam por cima do gap. Meça da linha de base de cima até a altura das maiúsculas de baixo. Descendentes (g, p, q) não contam, porque o olho lê a linha de base.

Por quê: dois espaços iguais no código e diferentes na tela parecem descuido, e dois espaços diferentes no código e iguais na tela parecem intenção. Só a tinta diz qual é qual.

### Uma escada, poucos degraus

Cada região usa três ou quatro degraus: dentro, entre itens, entre grupos, entre seções. Por exemplo 4–8, 12–16, 24–32 e 48–96. Cada degrau fica a pelo menos 1,5× o anterior, e todo valor vem da escala.

Por quê: o ritmo é a repetição. Com poucos valores, o olho aprende a escada na primeira tela e lê a estrutura da página pelos espaços.

### Dentro menos que entre

O maior espaço dentro de um grupo tem de ser menor que o espaço entre esse grupo e o próximo. Se forem iguais, os itens de uma lista viram uma coluna de linhas soltas e ninguém sabe onde um item acaba. Uma caixa (fundo, borda, sombra) ou uma divisória já agrupa sozinha. Entre caixas e entre itens divididos por uma linha, a proximidade não precisa fazer esse trabalho. O espaço acima de um título dentro do bloco (prosa com h2 soltos) também não conta como espaço de dentro: ele separa seções, e quem cuida dele é a regra do título.

Por quê: proximidade é o agrupamento mais forte que existe depois da região comum. Espaço ambíguo obriga o leitor a deduzir a estrutura pelo conteúdo.

### Título perto do que ele abre

O espaço acima de um título é maior que o de baixo, com folga clara (1,5× a 2×). Um sobretítulo (kicker, eyebrow) logo acima faz parte do título e fica mais perto dele que o parágrafo de baixo.

Por quê: o título pertence ao bloco que vem depois. Com espaços iguais, ele flutua entre as duas seções e parece legenda da de cima.

### Irmãos iguais, espaços iguais

O mesmo componente repetido (cards de uma lista, entradas de um changelog, campos de um formulário) tem o mesmo espaço visível entre si e por dentro, com 1px de folga. Cards de alturas diferentes num grid deixam vãos desiguais embaixo dos menores. A correção é esticar os cards até a altura da linha (`align-items: stretch` com o card em `height: 100%`), não mexer no gap.

### Caixa: mesmo espaço em cima e embaixo

Numa caixa, o espaço da borda de cima até a tinta é igual ao espaço da tinta até a borda de baixo, com 1px de folga. Num botão, isso centraliza a altura das maiúsculas, que é o centro que o olho vê. Mídia que encosta na borda (capa no topo do card) fica fora da regra. Se o padding já é igual e a tinta não, a culpa é da fonte (ascendente e descendente desiguais). Corte o texto do controle com `text-box: trim-both cap alphabetic` e refaça o padding, ou compense com padding desigual e um comentário dizendo por quê.

### Entrelinha: corte o texto ou aceite a caixa

Quando a mesma distância de código vira espaços diferentes na tela, há duas saídas:

1. **Cortar.** `text-box: trim-both cap alphabetic` nos textos dos componentes faz o gap do código virar o espaço visível. Só corta em cima da primeira linha e embaixo da última; o line-height entre as linhas de um parágrafo não muda. É uma mudança visual grande, porque todo espaço que encosta em texto encolhe. Pergunte a quem cuida do design antes de aplicar no projeto todo, aplique por componente e meça de novo. Confira o suporte nos navegadores do projeto (caniuse ou o pacote `web-features`). Onde não há suporte, o texto volta à caixa normal: o espaço só fica um pouco maior, nada se sobrepõe.
2. **Aceitar a caixa.** Mantenha os gaps nos tokens e ajuste os pares que mais destoam com o degrau vizinho. Registre na política que o projeto mede pela caixa.

Para um design system novo, corte. Para um produto grande em produção, comece aceitando a caixa e corte componente por componente.

### Espaços elásticos e prosa

`justify-content: space-between`, `flex-grow` e `margin-top: auto` produzem espaços que mudam com o conteúdo. O probe pula os dois primeiros. O `margin-top: auto` aparece como fora da escala: confirme no código e liste como elástico, sem corrigir. Prosa longa (`.prose`, MDX) usa margens em `em`, que seguem o tamanho da fonte e caem fora de uma escala em px de propósito. Meça com `IGNORE=".prose"` ou aceite a escala em `em`, mas aplique ainda assim as regras de título e de proximidade.

## O que nunca muda neste passe

- Tamanho de fonte, peso, e o line-height entre linhas de um mesmo parágrafo.
- Altura de linha de controles, áreas de toque e tamanhos aprovados pela política. Se fechar um espaço exige mudar um deles, deixe o espaço, anote o tamanho e pergunte.
- Bordas horizontais e o centro das barras (isso é do gridlines), cores, raios.
- Elementos semânticos e comportamento. Este é um passe de espaço.

## Erros comuns

- **Medir caixa em vez de tinta.** Um gap de 16px entre dois textos quase nunca aparece como 16px.
- **Corrigir no olho.** Sem as faixas, 2px de diferença passam numa tela e aparecem na página inteira.
- **Mover a maioria até o par errado.** A escada é onde a maioria dos pares já está, a não ser que a política diga outra coisa.
- **Ajuste por item.** `mt-[3px]` num card é uma correção que o próximo card não herda.
- **Igualar tudo.** Ritmo não é espaço igual em todo lugar: é poucos valores, cada um com um papel. Espaços iguais dentro e entre grupos são uma falha de proximidade.
- **Espremer o de dentro para resolver a proximidade.** Primeiro suba o espaço entre grupos um degrau.
- **Medir só estados vazios** e declarar a página com ritmo.

## Limites do probe

- Em grids, mede o vizinho de baixo em cada coluna. O espaço entre colunas não é medido.
- Conteúdo de `::before` e `::after` não entra na tinta.
- Texto vertical, elementos girados, canvas e SVG contam como caixa.
- Fontes que carregam depois da medição dão métricas erradas. O `audit.mjs` espera `document.fonts.ready`; no navegador ao vivo, meça depois que a página assentar.

## Checklist

- [ ] Escada e tokens da política lidos primeiro e usados como alvo
- [ ] Faixas desenhadas em 1440px e 390px, sobreposições abertas, capturas em `.ritmo/`
- [ ] Cada região com a escada anotada e cada par com um papel (dentro, entre itens, entre grupos, entre seções)
- [ ] Nenhum espaço entre dois degraus
- [ ] Grupos: dentro menor que entre; títulos mais perto do que abrem
- [ ] Irmãos com o mesmo espaço; caixas com o mesmo espaço em cima e embaixo
- [ ] Correções no `gap` do container ou em tokens de pilha, não em itens soltos
- [ ] Decisão sobre entrelinha (cortar ou aceitar a caixa) tomada com quem cuida do design
- [ ] Medido de novo: sem falhas fora das exceções registradas
- [ ] Escada nova registrada na política; o relatório lista o que não foi verificado
