import { registerFieldRenderer } from './schema.js';

const installed = new Set();

/** The host configures executable modules. Schema documents only describe data. */
export async function loadFieldModules(paths = [], load = url => import(url)) {
  for (const path of paths) {
    const url = new URL(path, location.origin);
    if (url.origin !== location.origin || !['http:', 'https:'].includes(url.protocol)) {
      throw new Error('Field modules must be served by the API host.');
    }
    if (installed.has(url.href)) continue;
    const { fieldRenderers } = await load(url.href);
    if (!Array.isArray(fieldRenderers) || fieldRenderers.some(entry =>
      typeof entry?.predicate !== 'function' || typeof entry?.render !== 'function')) {
      throw new Error('Invalid fieldRenderers export in ' + url.pathname);
    }
    if (!installed.has(url.href)) {
      for (const { predicate, render } of fieldRenderers) registerFieldRenderer(predicate, render);
      installed.add(url.href);
    }
  }
}
