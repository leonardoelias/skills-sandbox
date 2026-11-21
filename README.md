# skills-sandbox

Projeto descartável para testar as skills [visual-diff](.claude/skills/visual-diff) e
[ritmo](.claude/skills/ritmo) num app de verdade. Repositório **privado** de propósito: a
visual-diff recusa publicar imagens em repositórios públicos.

- Monorepo com npm workspaces: o app Next.js 16 (Turbopack) em `apps/web` e um pacote de
  componentes em `packages/ui` (`@acme/ui`, consumido pelo `name` do workspace).
- Rotas: `/`, `/precos`, `/blog` e a dinâmica `/blog/[slug]` (exemplo: `/blog/ola`), com layout
  raiz, alias `@/` do tsconfig e CSS Modules no pacote compartilhado.
- Tokens de espaço em `apps/web/app/globals.css` (`--space-1` a `--space-8`), com problemas de
  ritmo plantados de propósito: margem fora da escala no hero, título "Recursos" mais perto do
  bloco de cima que do seu, grupos de cards com espaços diferentes, cards com mais espaço em cima
  que embaixo, botão com padding desigual e a newsletter sem respiro entre campo e botão.

## Rodar

```bash
npm install
npm run dev            # http://localhost:3000
```

## Testar a visual-diff

O PR aberto neste repositório muda o botão do pacote compartilhado, cria a página `/contato` (com
link no cabeçalho) e só o espaçamento do blog. Peça numa sessão do Claude Code aberta nesta pasta:
*"Roda o visual-diff no PR #1"*. Ou pela CLI:

```bash
node .claude/skills/visual-diff/bin/visual-diff.mjs detect --pr 1
node .claude/skills/visual-diff/bin/visual-diff.mjs run --pr 1
node .claude/skills/visual-diff/bin/visual-diff.mjs publish --pr 1 --dry-run
```

O roteiro completo da publicação está em `.claude/skills/visual-diff/references/publish-test.md`.

## Testar a ritmo

Peça *"faz um passe de ritmo vertical na home"*, ou meça direto com o app rodando:

```bash
node .claude/skills/ritmo/audit.mjs http://localhost:3000 .ritmo 1440
```
