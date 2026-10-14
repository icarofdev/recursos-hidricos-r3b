import { readFileSync } from 'node:fs';
/** No echo, command-line secret or clipboard logging. Pipes are accepted for automation. */
export async function readSecret(label, max = 16384) {
  if (!process.stdin.isTTY) {
    const value = readFileSync(0, 'utf8').trim();
    if (!value || value.length > max) throw new Error('Entrada inválida.');
    return value;
  }
  process.stderr.write(label + ': ');
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => {
      process.stdin.removeListener('data', input);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write('\n');
      if (error) reject(error);
      else resolve(value.trim());
    };
    const input = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          finish(new Error('Cancelado.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish(value ? null : new Error('Entrada vazia.'));
          return;
        }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ') value += character;
        if (value.length > max) {
          finish(new Error('Entrada maior que o limite.'));
          return;
        }
      }
    };
    process.stdin.on('data', input);
  });
}
