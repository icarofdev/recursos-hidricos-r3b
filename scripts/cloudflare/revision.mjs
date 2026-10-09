import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

// Explicit public source allowlist: never inspect environment or runtime files.
export async function sourceRevision() {
  const files = ['package.json', 'package-lock.json', 'wrangler.toml', 'vercel.json', '.gitattributes'];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) files.push(file);
    }
  }
  for (const directory of ['cloudflare', 'static', 'web', 'scripts/cloudflare']) await visit(directory);
  const hash = createHash('sha256');
  for (const file of files.sort()) {
    const content = await readFile(file);
    hash.update(`${file}\0${content.length}\0`);
    hash.update(content);
  }
  return hash.digest('hex');
}
