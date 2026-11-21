# Roteiro: validar a publicação num repositório de sandbox

Os testes automáticos (`test/publish.test.mjs`) cobrem o git plumbing contra um remote local e um
`gh` falso. O que só o GitHub de verdade responde (o link renderiza só para quem lê o repo, o
comentário aparece e é editado no lugar) precisa deste teste manual, feito uma vez por versão e
sempre num **repositório privado descartável**, nunca num repo de produto.

## Preparar

```bash
gh repo create <seu-usuario>/visual-diff-sandbox --private --clone && cd visual-diff-sandbox
cp -r <repo-da-skill>/examples/sample-site/. .
git add -A && git commit -m antes && git push -u origin HEAD
git checkout -b feature
sed -i '' 's/padding: 8px 14px; border-radius: 4px;/padding: 10px 18px; border-radius: 8px;/' styles.css
git commit -am depois && git push -u origin feature
gh pr create --fill
```

## Roteiro

| # | Passo | Esperado |
|---|---|---|
| 1 | `visual-diff run --pr <n>` | `stats.changed: 4` |
| 2 | `visual-diff publish --pr <n> --dry-run` | `publishable: true`, `visibility: PRIVATE`, 4 composições + recortes em `uploads` |
| 3 | `visual-diff publish --pr <n> --verify` | `posted: true`, `verify.ok: true`, `verify.anonymousStatus: 404` |
| 4 | Abrir o PR logado no navegador | comentário com imagens renderizadas |
| 5 | Abrir uma URL de imagem numa janela anônima | 404 |
| 6 | GitHub Mobile e o e-mail de notificação | anotar se as imagens aparecem (podem não aparecer) |
| 7 | Escrever `.visual-diff/summary.md` e publicar de novo | o mesmo comentário é editado (`commentAction: updated`), nenhum novo |
| 8 | `git ls-remote origin visual-diff-assets` e `git log origin/visual-diff-assets` | 1 commit, sem pai, mensagem com `[skip ci]` |
| 9 | Novo commit no PR, sem rodar `run`, e `publish --pr <n>` | recusado (código 4): o relatório é de outro commit |
| 10 | Fechar o PR e `visual-diff prune --closed` | `removed: [n]`; a branch fica sem `pr-<n>/` |
| 11 | Tornar o repo público e `publish --dry-run` | `[bloqueia] O repositório é PÚBLICO` |

Anote o resultado de cada passo (data, versão da skill, versão do `gh`). Depois apague o repositório:
`gh repo delete <seu-usuario>/visual-diff-sandbox`.
