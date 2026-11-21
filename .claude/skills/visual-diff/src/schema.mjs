// JSON Schema do visual-diff.config.json. É a fonte única: `validateConfig` usa este objeto e
// `npm run schema` grava visual-diff.schema.json a partir dele (um teste confere que estão iguais).
import { suggest } from './util.mjs';

const str = { type: 'string' };
const bool = { type: 'boolean' };
const num = { type: 'number' };
const strList = { type: 'array', items: str };
const stringMap = { type: 'object', additionalProperties: str };
const envRef = { type: 'string', pattern: '^\\$\\w+$', description: 'Referência a uma variável de ambiente ("$NOME"), nunca o valor.' };

const step = {
  type: 'object',
  description: 'Um passo de interação: hover, click, focus, type, press, scroll ou wait.',
  properties: {
    hover: str,
    click: str,
    focus: str,
    type: { type: 'object', properties: { selector: str, text: str }, additionalProperties: false },
    press: str,
    scroll: num,
    wait: num,
  },
  additionalProperties: false,
};

const viewport = {
  oneOf: [
    { type: 'string', description: 'desktop, tablet, mobile ou nome:LxA@escala' },
    {
      type: 'object',
      properties: { name: str, width: num, height: num, deviceScaleFactor: num, isMobile: bool, hasTouch: bool },
      required: ['name'],
      additionalProperties: false,
    },
  ],
};

const variants = {
  type: 'object',
  description: 'Captura só o head com ?param=valor para cada valor e monta uma faixa comparativa.',
  properties: {
    param: str,
    values: { oneOf: [str, { type: 'array', items: { type: ['string', 'number'] } }], description: '"1..4" ou uma lista' },
    viewports: strList,
    themes: strList,
  },
  required: ['param', 'values'],
  additionalProperties: false,
};

const route = {
  oneOf: [
    str,
    {
      type: 'object',
      properties: {
        path: str,
        files: strList,
        waitFor: { type: 'string', description: 'Seletor CSS ou "js:<expressão>" que precisa ser verdadeira antes da captura.' },
        variants,
        motion: {
          type: 'object',
          properties: { steps: { type: 'array', items: step }, durationMs: num },
          additionalProperties: false,
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  ],
};

const theme = {
  oneOf: [
    str,
    {
      type: 'object',
      properties: {
        name: str,
        colorScheme: { enum: ['light', 'dark', 'no-preference'] },
        query: stringMap,
        localStorage: stringMap,
        cookie: stringMap,
        htmlClass: str,
        htmlAttr: stringMap,
      },
      required: ['name'],
      additionalProperties: false,
    },
  ],
};

export const CONFIG_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'visual-diff.config.json',
  type: 'object',
  properties: {
    $schema: str,
    appDir: { type: 'string', description: 'Subpasta do app num monorepo.' },
    startCommand: { type: 'string', description: 'Comando do servidor; {port} vira uma porta livre. "static:<pasta>" usa o servidor estático embutido.' },
    baseUrl: str,
    installCommand: { type: ['string', 'null'] },
    deps: { enum: ['auto', 'link', 'install'], description: 'auto: liga o node_modules do checkout principal e instala quando o lockfile difere ou o app é Next.' },
    startTimeoutMs: num,
    env: stringMap,
    routes: { type: 'array', items: route },
    globalFiles: strList,
    viewports: { oneOf: [str, { type: 'array', items: viewport }] },
    themes: { type: 'array', items: theme },
    capture: {
      type: 'object',
      properties: {
        mask: strList,
        hide: strList,
        maskEmbeds: strList,
        fullPage: bool,
        settleMs: num,
        maxRetakes: num,
        fixedTime: { type: ['string', 'null'], description: '"run-start", uma data ISO ou null' },
        locale: str,
        timezone: str,
        maxHeight: num,
        maxScrollSteps: num,
        networkIdleMs: num,
        waitFor: { type: ['string', 'null'] },
        blockHosts: strList,
        blockDefaultHosts: bool,
        concurrency: num,
      },
      additionalProperties: false,
    },
    diff: {
      type: 'object',
      properties: {
        threshold: num,
        focusRegions: num,
        rowTolerance: num,
        composeFormat: { enum: ['jpeg', 'png'] },
        maxFocusArea: num,
      },
      additionalProperties: false,
    },
    detect: {
      type: 'object',
      properties: {
        uiExtensions: strList,
        ignore: strList,
        maxRoutes: num,
        maxDepth: num,
        aliases: stringMap,
      },
      additionalProperties: false,
    },
    auth: {
      type: 'object',
      properties: {
        headers: { type: 'object', additionalProperties: envRef },
        cookies: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: str, value: envRef, domain: str, path: str },
            required: ['name', 'value'],
            additionalProperties: false,
          },
        },
        storageState: { type: ['string', 'null'] },
        origins: { type: 'array', items: { enum: ['previews', 'local'] } },
      },
      additionalProperties: false,
    },
    audits: {
      type: 'object',
      properties: {
        a11y: bool,
        tokens: { oneOf: [bool, { type: 'object', properties: { include: strList, colorTolerance: num, allow: strList }, additionalProperties: false }] },
        motion: bool,
      },
      additionalProperties: false,
    },
    motion: {
      type: 'object',
      properties: { durationMs: num, fps: num, maxWidth: num, steps: { type: 'array', items: step } },
      additionalProperties: false,
    },
    cache: {
      type: 'object',
      properties: { base: bool, worktrees: bool },
      additionalProperties: false,
    },
    publish: {
      type: 'object',
      properties: {
        branch: str,
        marker: str,
        remote: { type: ['string', 'null'] },
        repo: { type: ['string', 'null'], description: 'owner/repo (ou host/owner/repo) onde o PR vive, se não for o do remote.' },
        host: { type: ['string', 'null'] },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

/**
 * Valida um valor contra o schema acima (o subconjunto que ele usa). Devolve uma lista de erros legíveis,
 * com sugestão de nome quando a chave parece um erro de digitação.
 */
export function validateConfig(value, schema = CONFIG_SCHEMA, where = '') {
  const errors = [];
  check(value, schema, where || '(raiz)', errors);
  return errors;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function matchesType(v, t) {
  const actual = typeOf(v);
  const types = Array.isArray(t) ? t : [t];
  return types.some((x) => x === actual || (x === 'integer' && Number.isInteger(v)));
}

function check(v, s, where, errors) {
  if (s.oneOf) {
    const attempts = s.oneOf.map((alt) => {
      const e = [];
      check(v, alt, where, e);
      return e;
    });
    if (attempts.some((e) => e.length === 0)) return;
    // Mostra os erros da alternativa cujo tipo bate com o valor, se houver.
    const byType = s.oneOf.findIndex((alt) => alt.type && matchesType(v, alt.type));
    errors.push(...(byType >= 0 ? attempts[byType] : [`${where}: valor inválido`]));
    return;
  }
  if (s.enum) {
    if (!s.enum.includes(v)) errors.push(`${where}: use ${s.enum.map((x) => JSON.stringify(x)).join(', ')} (recebi ${JSON.stringify(v)})`);
    return;
  }
  if (s.type && !matchesType(v, s.type)) {
    errors.push(`${where}: esperava ${[].concat(s.type).join(' ou ')}, recebi ${typeOf(v)}`);
    return;
  }
  if (s.pattern && typeof v === 'string' && !new RegExp(s.pattern).test(v)) {
    errors.push(`${where}: ${s.description ?? `não casa com ${s.pattern}`}`);
  }
  if (typeOf(v) === 'object' && (s.properties || s.additionalProperties !== undefined)) {
    for (const [k, val] of Object.entries(v)) {
      const sub = s.properties?.[k];
      if (sub) check(val, sub, `${where === '(raiz)' ? '' : where + '.'}${k}`, errors);
      else if (s.additionalProperties === false) {
        const hint = suggest(k, Object.keys(s.properties ?? {}));
        errors.push(`${where === '(raiz)' ? '' : where + '.'}${k}: chave desconhecida${hint ? ` (você quis dizer "${hint}"?)` : ''}`);
      } else if (typeof s.additionalProperties === 'object') check(val, s.additionalProperties, `${where}.${k}`, errors);
    }
    for (const req of s.required ?? []) if (!(req in v)) errors.push(`${where}: falta "${req}"`);
  }
  if (typeOf(v) === 'array' && s.items) v.forEach((item, i) => check(item, s.items, `${where}[${i}]`, errors));
}
