import {randomBytes} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
// Nunca lê .env legado e nunca imprime secrets. Não sobrescreve arquivo existente.
try {
 await writeFile('.dev.vars', `SESSION_SECRET=${randomBytes(32).toString('base64url')}\nPASSWORD_PEPPER=${randomBytes(32).toString('base64url')}\n`, {flag:'wx', mode:0o600});
 console.log('Secrets locais novos gravados em .dev.vars (ignorado no Git).');
} catch (error) { if (error.code !== 'EEXIST') throw error; }
