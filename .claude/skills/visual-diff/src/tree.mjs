// Acesso uniforme aos arquivos de um lado: a árvore de trabalho (disco) ou um commit (git).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { sh } from './util.mjs';

const MAX_FILE = 1024 * 1024; // arquivos maiores não entram no grafo de imports

/** Árvore de trabalho: arquivos rastreados + não rastreados (respeitando .gitignore). */
export function workingTree(root) {
  let files;
  const list = () => {
    if (!files) {
      const out = sh('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root }).stdout;
      files = [...new Set(out.split('\0').filter(Boolean))].filter((f) => existsSync(path.join(root, f)));
    }
    return files;
  };
  return {
    kind: 'working-tree',
    list,
    read(p) {
      try {
        const full = path.join(root, p);
        if (statSync(full).size > MAX_FILE) return null;
        return readFileSync(full, 'utf8');
      } catch {
        return null;
      }
    },
    readMany(paths) {
      return new Map(paths.map((p) => [p, this.read(p)]));
    },
  };
}

/** Um commit: lista via ls-tree e lê em lote via cat-file --batch (um processo só). */
export function commitTree(root, sha) {
  let files;
  const cache = new Map();
  const list = () => {
    if (!files) {
      const out = sh('git', ['ls-tree', '-r', '--name-only', '-z', sha], { cwd: root }).stdout;
      files = out.split('\0').filter(Boolean);
    }
    return files;
  };
  const readMany = (paths) => {
    const missing = paths.filter((p) => !cache.has(p));
    if (missing.length) {
      const r = spawnSync('git', ['cat-file', '--batch'], {
        cwd: root,
        input: missing.map((p) => `${sha}:${p}`).join('\n') + '\n',
        maxBuffer: 1024 * 1024 * 1024,
      });
      const buf = r.stdout ?? Buffer.alloc(0);
      let pos = 0;
      for (const p of missing) {
        const nl = buf.indexOf(10, pos);
        if (nl < 0) break;
        const header = buf.subarray(pos, nl).toString('utf8');
        pos = nl + 1;
        const m = /^\S+ (\w+) (\d+)$/.exec(header);
        if (!m) {
          cache.set(p, null); // "missing"
          continue;
        }
        const size = Number(m[2]);
        const content = buf.subarray(pos, pos + size);
        pos += size + 1;
        cache.set(p, m[1] === 'blob' && size <= MAX_FILE && !content.includes(0) ? content.toString('utf8') : null);
      }
    }
    return new Map(paths.map((p) => [p, cache.get(p) ?? null]));
  };
  return {
    kind: 'commit',
    sha,
    list,
    read: (p) => readMany([p]).get(p),
    readMany,
  };
}
