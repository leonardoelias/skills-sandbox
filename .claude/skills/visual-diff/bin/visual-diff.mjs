#!/usr/bin/env node
// Ponto de entrada para agentes e humanos. Instala as dependências no primeiro uso e roda a CLI.
// O Chromium do Playwright é baixado sob demanda pelo comando `run`.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const deps = ['playwright', 'pixelmatch', 'pngjs', 'axe-core', 'gifenc'];
if (deps.some((d) => !existsSync(path.join(root, 'node_modules', d)))) {
  process.stderr.write('[visual-diff] instalando dependências (só no primeiro uso)…\n');
  const r = spawnSync(npm, [existsSync(path.join(root, 'package-lock.json')) ? 'ci' : 'install', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: root,
    stdio: ['ignore', process.stderr, process.stderr],
  });
  if (r.status !== 0) {
    process.stderr.write(`[visual-diff] erro: \`npm install\` falhou em ${root}\n`);
    process.exit(r.status ?? 1);
  }
}

const { main } = await import(pathToFileURL(path.join(root, 'src', 'cli.mjs')).href);
process.exit(await main(process.argv.slice(2)));
