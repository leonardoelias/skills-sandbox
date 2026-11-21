// Roda diffImages fora da thread principal (o pixelmatch é síncrono e pesado em páginas longas).
import { parentPort, workerData } from 'node:worker_threads';
import { diffImages } from './diff.mjs';

try {
  const { before, after, opts } = workerData;
  parentPort.postMessage({ ok: true, result: diffImages(before, after, opts) });
} catch (e) {
  parentPort.postMessage({ ok: false, error: e.stack ?? String(e) });
}
