import {randomBytes,createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';

const args=process.argv.slice(2);
const demo=args.includes('--demo');
const remote=args.includes('--remote');
function option(name,fallback='') {const i=args.indexOf(name);return i<0?fallback:args[i+1]??fallback;}
const id=Number(option('--id',demo?'1':''));
const source=demo?'mock':option('--source','monitorie');
const external=option('--external-id',demo?'demo-device':'');
if (!Number.isSafeInteger(id)||id<1||!['mock','local','monitorie'].includes(source)||source==='monitorie'&&!external||source==='mock'&&remote) {
 console.error('Uso: npm run dev:seed OU node scripts/cloudflare/provision.mjs --id N --source monitorie --external-id ID [--remote]. Mocks são somente locais.');process.exit(1);
}
const code='HIDRA-'+randomBytes(16).toString('hex').toUpperCase().match(/.{1,8}/g).join('-');
const hash=createHash('sha256').update(code).digest('hex');
const time=Math.floor(Date.now()/1000);
const quoted=value=>"'"+String(value).replaceAll("'","''")+"'";
// O SQL contém apenas hash do pareamento; o código puro é mostrado uma vez.
const sql=`INSERT INTO devices(id,device_code,source,external_id,pairing_code_hash,pairing_expires_at,created_at,updated_at)
VALUES (${id},${quoted(`HIDRA-R3B-${String(id).padStart(6,'0')}`)},${quoted(source)},${external?quoted(external):'NULL'},${quoted(hash)},${time+86400},${time},${time})
ON CONFLICT(id) DO UPDATE SET pairing_code_hash=excluded.pairing_code_hash,pairing_expires_at=excluded.pairing_expires_at,updated_at=excluded.updated_at
WHERE devices.owner_user_id IS NULL AND devices.source=excluded.source AND devices.external_id IS excluded.external_id
RETURNING id;`;
await mkdir('.runtime/cloudflare',{recursive:true});
const file=resolve('.runtime/cloudflare',`provision-${randomBytes(8).toString('hex')}.sql`);
await writeFile(file,sql,{mode:0o600});
const child=spawnSync(process.execPath,['scripts/cloudflare/wrangler.mjs','d1','execute','DB',remote?'--remote':'--local','--file',file,'--json'],{encoding:'utf8',windowsHide:true});
if(child.status!==0){console.error('Provisionamento não concluído. Confira migrations, ID do D1 e login Wrangler.');process.exit(1);}
let returned;
try {returned=JSON.parse(child.stdout);} catch {console.error('Não foi possível confirmar o provisionamento.');process.exit(1);}
if(!returned.some(entry=>entry.results?.some(row=>row.id===id))){console.error('Dispositivo já vinculado ou fonte/identificador diferente. Nenhuma associação foi alterada.');process.exit(1);}
console.log(`${remote?'Dispositivo remoto':'Dispositivo local'} preparado. Código de pareamento (24h; mostrar só ao proprietário):\n${code}`);
