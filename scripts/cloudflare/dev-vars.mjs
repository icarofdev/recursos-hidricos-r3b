import { readFile } from 'node:fs/promises';

/** Parser intencionalmente simples: uma variável por linha, sem expansão ou execução. */
export async function readDevVars(file = '.dev.vars') {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  const values = {};
  for (const [index, source] of text.split(/\r?\n/).entries()) {
    const line = source.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    const key = separator < 0 ? '' : line.slice(0, separator).trim();
    const value = separator < 0 ? '' : line.slice(separator + 1).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || Object.hasOwn(values, key))
      throw new Error(`Linha ${index + 1} inválida em ${file}.`);
    values[key] = value;
  }
  return values;
}
