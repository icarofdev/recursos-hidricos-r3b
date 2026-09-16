import {before, after, beforeEach, test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {createHash, randomBytes} from 'node:crypto';
import {Miniflare, Response as MFResponse, Log, LogLevel} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';

const digest = value => createHash('sha256').update(value).digest('hex');
const password = 'Senha-de-teste-8472';
const base = 'https://hidra.test';
const seconds = () => Math.floor(Date.now()/1000);
let mf, db, sent = [], mailStatus = 201, ipCounter = 0;
const keys = {SESSION_SECRET: randomBytes(32).toString('base64url'), PASSWORD_PEPPER: randomBytes(32).toString('base64url'), BREVO_API_KEY: randomBytes(32).toString('base64url')};
const bindings = {...keys, APP_ENV:'production', APP_URL:base, MAIL_MODE:'brevo', MONITORIE_MODE:'unconfigured',
 BREVO_SENDER_EMAIL:'sender@example.test', BREVO_SENDER_NAME:'Hidra testes', INGEST_ENABLED:'true', MONITORIE_CACHE_SECONDS:'60'};
function options(overrides={}) {
 return {modules:true, scriptPath:'dist/_worker.js', compatibilityDate:'2026-03-01', d1Databases:{DB:'test-only'},
  bindings:{...bindings,...overrides}, log:new Log(LogLevel.NONE),
  serviceBindings:{ASSETS: () => new MFResponse('asset')},
  outboundService:async request => {
   assert.equal(request.url, 'https://api.brevo.com/v3/smtp/email', 'Qualquer rede externa não prevista é proibida no teste');
   assert.equal(request.headers.get('api-key'),keys.BREVO_API_KEY);
   assert.equal(request.method,'POST');
   sent.push(await request.json());
   return new MFResponse('{}',{status:mailStatus,headers:{'Content-Type':'application/json'}});
  }
 };
}
async function configure(overrides={}) {
 await mf.setOptions(options(overrides));
 db=await mf.getD1Database('DB');
}
before(async () => {
 mf=new Miniflare(options()); db=await mf.getD1Database('DB');
 const migrations=(await readdir('cloudflare/migrations')).filter(f=>f.endsWith('.sql')).sort();
 for (const file of migrations) await db.batch(unstable_splitSqlQuery(await readFile(`cloudflare/migrations/${file}`,'utf8')).map(q=>db.prepare(q)));
});
after(async () => {await mf?.dispose();});
beforeEach(async () => {
 sent=[]; mailStatus=201;
  await db.batch(['audit_logs','activation_codes','smwa_readings','smwu_readings','reservoirs','devices','password_reset_tokens','sessions','users','rate_limits','settings'].map(table=>db.prepare(`DELETE FROM ${table}`)));
});

function browser(origin=base) {
 let cookie='',csrf=''; const ip=`198.51.100.${++ipCounter}`;
 return {
  get cookie(){return cookie;}, get csrf(){return csrf;}, origin, ip,
  async request(path, {method='GET',data,headers={},capture=true}={}) {
   const response=await mf.dispatchFetch(origin+path,{method,redirect:'manual',headers:{
    Cookie:cookie, Origin:origin, 'CF-Connecting-IP':ip,
    ...(data!==undefined ? {'Content-Type':'application/json','X-CSRF-Token':csrf}:{}),...headers},
    ...(data===undefined?{}:{body:JSON.stringify(data)})});
   if (capture) for (const value of response.headers.getSetCookie()) cookie=value.split(';')[0];
   return response;
  },
  async init(){const res=await this.request('/api/auth/csrf'); assert.equal(res.status,200); csrf=(await res.json()).csrf_token;},
  async register(email=`u${ipCounter}@example.test`,name='Pessoa de teste') {
   await this.init(); const res=await this.request('/api/auth/register',{method:'POST',data:{name,email,password,password_confirmation:password}});
   const payload=await res.json(); assert.equal(res.status,201,JSON.stringify(payload)); csrf=payload.csrf_token; return payload.user;
  },
  async login(email, remember=false, pass=password, next='/') {
   await this.init(); const res=await this.request('/api/auth/login',{method:'POST',data:{email,password:pass,remember,next}});
   const payload=await res.json(); if(payload.csrf_token) csrf=payload.csrf_token; return {res,payload};
  }
 };
}
async function provision(id=1,source='local',code=randomBytes(24).toString('base64url').toUpperCase()) {
 const time=seconds();
 await db.prepare(`INSERT INTO devices(id,device_code,source,external_id,pairing_code_hash,pairing_expires_at,created_at,updated_at)
 VALUES (?,?,?,?,?,?,?,?)`).bind(id,`DEVICE-${id}`,source,source==='local'?null:`external-${id}`,digest(code),time+3600,time,time).run();
 return code;
}
async function connect(client,code,name='Caixa principal') {
 const res=await client.request('/api/devices/connect',{method:'POST',data:{pairing_code:code,reservoir_name:name}});
 const payload=await res.json(); assert.equal(res.status,201,JSON.stringify(payload)); return payload.data;
}
async function waitFor(predicate) {
 for(let i=0;i<80;i++){if(await predicate())return; await new Promise(r=>setTimeout(r,25));}
 throw new Error('Operação assíncrona não terminou');
}
async function issueReset(client,email) {
 const res=await client.request('/api/auth/forgot-password',{method:'POST',data:{email}}); assert.equal(res.status,200);
 await waitFor(()=>sent.length>0);
 return new URL(sent.at(-1).textContent.match(/https:\/\/[^\s]+/)[0]).searchParams.get('token');
}

test('migrations inicializam D1 vazio e as cinco páginas mantêm o design',async()=>{
 const client=browser();
 assert.equal((await client.request('/api/health')).status,200);
 const root=await client.request('/');
 assert.equal(root.status,302);
 assert.equal(root.headers.get('Location'), base+'/');
 for(const page of ['/login','/cadastro','/esqueci-senha','/redefinir-senha']){
  const res=await client.request(page);
  assert.equal(res.status,302);
  assert.equal(res.headers.get('Location'), base+page);
 }
 for(const file of ['index.html','login.html','register.html','forgot-password.html','reset-password.html']){
  const html=await readFile('dist/frontend/'+file,'utf8');
  assert.ok(html.includes('auth-layout') || html.includes('dashboard-content'));
  assert.doesNotMatch(html,/<\?|\{\{|api\/[^"\s]+\.php/);
 }
 const tables=(await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).results.map(r=>r.name);
 for(const table of ['users','sessions','password_reset_tokens','rate_limits','devices','reservoirs','smwu_readings','settings']) assert.ok(tables.includes(table));
});
test('cadastro, hash com salt/pepper, cookie seguro, CSRF e logout',async()=>{
 const client=browser(); await client.init(); const anonymous=client.cookie;
 const user=await client.register('pessoa@example.test','<script>Nome</script>');
 assert.notEqual(client.cookie,anonymous);
 const row=await db.prepare('SELECT * FROM users WHERE id=?').bind(user.id).first();
 assert.match(row.password_hash,/^pbkdf2-sha256-pepper\$v1\$100000\$/); assert.ok(!row.password_hash.includes(password));
 const duplicate=browser(); const user2=await duplicate.register('pessoa2@example.test');
 const row2=await db.prepare('SELECT password_hash FROM users WHERE id=?').bind(user2.id).first(); assert.notEqual(row.password_hash,row2.password_hash);
 const meRes=await client.request('/api/auth/me'); assert.equal(meRes.status,200);
 const me=await meRes.json(); assert.equal(me.user.name,'<script>Nome</script>');
 const page=await client.request('/'); assert.equal(page.status,302); assert.equal(page.headers.get('Location'),base+'/');
 assert.match(page.headers.get('Content-Security-Policy'),/frame-ancestors 'none'/); assert.equal(page.headers.get('Cache-Control'),'no-store');
 assert.equal((await client.request('/api/auth/me',{headers:{Cookie:anonymous},capture:false})).status,401);
 assert.equal((await client.request('/api/auth/logout',{method:'POST',data:{},headers:{'X-CSRF-Token':'wrong'}})).status,419);
 const old=client.cookie;
 const logout=await client.request('/api/auth/logout',{method:'POST',data:{}}); assert.equal(logout.status,200);
 assert.match(logout.headers.get('set-cookie'),/HttpOnly/); assert.match(logout.headers.get('set-cookie'),/Secure/); assert.match(logout.headers.get('set-cookie'),/SameSite=Lax/);
 assert.equal((await client.request('/api/auth/me',{headers:{Cookie:old}})).status,401);
});
test('login lembrado, redirects seguros e bloqueio de origem externa',async()=>{
 const client=browser(); await client.register('login@example.test');
 const login=browser(); const {res,payload}=await login.login('LOGIN@example.test',true,password,'//evil.example');
 assert.equal(res.status,200); assert.equal(payload.redirect,'/'); assert.match(res.headers.get('set-cookie'),/Max-Age=2592000/);
 assert.equal((await login.request('/api/auth/logout',{method:'POST',data:{},headers:{Origin:'https://evil.example'}})).status,403);
 assert.equal((await browser().login('login@example.test',false,'wrong')).res.status,401);
 const basic=await browser().login('login@example.test'); assert.equal(basic.res.status,200); assert.doesNotMatch(basic.res.headers.get('set-cookie'),/Max-Age/);
});
test('sessões expiram por inatividade, limite absoluto e giram após 15 minutos',async()=>{
 const client=browser(); await client.register(); const old=client.cookie;
 await db.prepare('UPDATE sessions SET rotated_at=?').bind(seconds()-901).run();
 const rotated=await client.request('/api/auth/me'); assert.equal(rotated.status,200); assert.notEqual(client.cookie,old);
 assert.equal((await client.request('/api/auth/me',{headers:{Cookie:old},capture:false})).status,200);
 await db.prepare('UPDATE sessions SET previous_until=?').bind(seconds()-1).run();
 assert.equal((await client.request('/api/auth/me',{headers:{Cookie:old},capture:false})).status,401);
 await db.prepare('UPDATE sessions SET last_seen=?').bind(seconds()-7201).run();
 assert.equal((await client.request('/api/auth/me')).status,401);
 const next=browser(); await next.register(); await db.prepare('UPDATE sessions SET expires_at=?').bind(seconds()-1).run();
 assert.equal((await next.request('/api/auth/me')).status,401);
});
test('APIs privadas rejeitam anônimos; métodos e entradas são validados',async()=>{
 const client=browser();
 for(const route of ['/api/auth/me','/api/reservoirs','/api/device/current','/api/device/history','/api/device/status','/api/device/alerts','/api/device/snapshot'])
  assert.equal((await client.request(route)).status,401,route);
 await client.register();
 assert.equal((await client.request('/api/reservoirs',{method:'POST',data:{}})).status,405);
 assert.equal((await client.request('/api/devices/connect',{method:'POST',data:{owner_user_id:1}})).status,422);
 assert.equal((await client.request('/api/device/current?reservoir_id=1%20OR%201=1')).status,422);
 assert.equal((await client.request('/.env')).status,404);
 assert.equal((await client.request('/__telemetry-cache/anything')).status,404);
});
test('logout concorrente à rotação revoga também o identificador novo',async()=>{
 const client=browser(); const user=await client.register();
 await db.prepare('UPDATE sessions SET rotated_at=?').bind(seconds()-901).run();
 const old=client.cookie;
 const [rotated,logout]=await Promise.all([
  client.request('/api/auth/me',{capture:false}),
  client.request('/api/auth/logout',{method:'POST',data:{},headers:{Cookie:old},capture:false})
 ]);
 assert.equal(logout.status,200);
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?').bind(user.id).first()).n,0);
 const next=rotated.headers.get('set-cookie')?.split(';')[0];
 if(next) assert.equal((await client.request('/api/auth/me',{headers:{Cookie:next},capture:false})).status,401);
});
test('rate limit de login é compartilhado pelo D1 e retorna Retry-After',async()=>{
 const client=browser(); await client.init();
 for(let i=0;i<10;i++) assert.equal((await client.request('/api/auth/login',{method:'POST',data:{email:'nobody@example.test',password}})).status,401);
 const denied=await client.request('/api/auth/login',{method:'POST',data:{email:'nobody@example.test',password}});
 assert.equal(denied.status,429); assert.ok(Number(denied.headers.get('Retry-After'))>0);
});
test('recuperação usa Brevo simulado, token com hash, URL pública e validade de 20 minutos',async()=>{
 const client=browser(); const user=await client.register('reset@example.test');
 const token=await issueReset(client,user.email); assert.match(token,/^[\w-]{43}$/);
 const entry=await db.prepare('SELECT * FROM password_reset_tokens WHERE user_id=?').bind(user.id).first();
 assert.equal(entry.token_hash,digest(token)); assert.notEqual(entry.token_hash,token); assert.equal(entry.expires_at-entry.created_at,1200);
 assert.match(sent[0].htmlContent,/https:\/\/hidra.test\/redefinir-senha/); assert.doesNotMatch(sent[0].htmlContent,/127\.0\.0\.1/);
 const validation=await client.request(`/api/auth/reset-password?token=${token}`); assert.equal((await validation.json()).valid,true);
 const missing=await client.request('/api/auth/forgot-password',{method:'POST',data:{email:'missing@example.test'}});
 assert.equal(missing.status,200); assert.equal((await missing.json()).success,true);
});
test('reset é de uso único sob concorrência, invalida outros tokens e TODAS as sessões',async()=>{
 const client=browser(); const user=await client.register('reset2@example.test');
 const second=browser(); await second.login(user.email,true);
 const token=await issueReset(client,user.email);
 const other=randomBytes(32).toString('base64url');
 await db.prepare('INSERT INTO password_reset_tokens(token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)').bind(digest(other),user.id,seconds()+1200,seconds()).run();
 const guest1=browser(), guest2=browser(); await guest1.init(); await guest2.init();
 const data={token,password:'Nova-senha-85744',password_confirmation:'Nova-senha-85744'};
 const results=await Promise.all([guest1.request('/api/auth/reset-password',{method:'POST',data}),guest2.request('/api/auth/reset-password',{method:'POST',data})]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,422]);
 assert.equal((await client.request('/api/auth/me')).status,401); assert.equal((await second.request('/api/auth/me')).status,401);
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM password_reset_tokens WHERE user_id=? AND used_at IS NULL').bind(user.id).first()).n,0);
 assert.equal((await browser().login(user.email)).res.status,401);
 assert.equal((await browser().login(user.email,false,'Nova-senha-85744')).res.status,200);
});
test('tokens expirados não redefinem a senha; falha de envio não deixa token utilizável',async()=>{
 const client=browser(); const user=await client.register('expired@example.test'); const token=await issueReset(client,user.email);
 await db.prepare('UPDATE password_reset_tokens SET expires_at=?').bind(seconds()-1).run();
 const check=await client.request(`/api/auth/reset-password?token=${token}`); assert.equal((await check.json()).valid,false);
 assert.equal((await client.request('/api/auth/reset-password',{method:'POST',data:{token,password,password_confirmation:password}})).status,422);
 mailStatus=401; sent=[];
 await client.request('/api/auth/forgot-password',{method:'POST',data:{email:user.email}});
 await waitFor(()=>sent.length===1);
 const failedToken=new URL(sent[0].textContent.match(/https:\/\/[^\s]+/)[0]).searchParams.get('token');
 await waitFor(async()=>!await db.prepare('SELECT 1 FROM password_reset_tokens WHERE token_hash=?').bind(digest(failedToken)).first());
});
test('pareamento atômico, autorização entre usuários, renomeação e histórico preservado',async()=>{
 const a=browser(), b=browser(); await a.register('a@example.test'); await b.register('b@example.test'); const code=await provision();
 const paired=await Promise.all([a.request('/api/devices/connect',{method:'POST',data:{pairing_code:code,reservoir_name:'A'}}),b.request('/api/devices/connect',{method:'POST',data:{pairing_code:code,reservoir_name:'B'}})]);
 assert.deepEqual(paired.map(r=>r.status).sort(),[201,422]);
 const winner=paired[0].status===201?a:b, loser=winner===a?b:a;
 const reservoir=(await (paired[0].status===201?paired[0]:paired[1]).json()).data;
 for(const endpoint of ['current','status','history','alerts','snapshot']) assert.equal((await loser.request(`/api/device/${endpoint}?reservoir_id=${reservoir.id}`)).status,404);
 const renamed=await winner.request('/api/reservoirs/rename',{method:'POST',data:{reservoir_id:reservoir.id,name:'Novo nome'}}); assert.equal((await renamed.json()).data.name,'Novo nome');
 assert.equal((await loser.request('/api/devices/unlink',{method:'POST',data:{reservoir_id:reservoir.id,confirmation:true}})).status,404);
 await db.prepare('INSERT INTO smwu_readings(id,reservoir_id,distancia,nivel,volume,rssi_wifi,created_at) VALUES (1,?,20,80,1000,-50,?)').bind(reservoir.id,seconds()).run();
 assert.equal((await winner.request('/api/device/history?reservoir_id='+reservoir.id+'&hours=721')).status,422);
 assert.equal((await winner.request('/api/devices/unlink',{method:'POST',data:{reservoir_id:reservoir.id,confirmation:true}})).status,200);
 assert.equal((await winner.request('/api/device/history?reservoir_id='+reservoir.id)).status,404);
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM smwu_readings').first()).n,1);
 const nextCode=randomBytes(24).toString('hex').toUpperCase();
 await db.prepare('UPDATE devices SET pairing_code_hash=?,pairing_expires_at=? WHERE id=1').bind(digest(nextCode),seconds()+3600).run();
 const next=await connect(loser,nextCode);
 assert.equal((await (await loser.request('/api/device/history?reservoir_id='+next.id)).json()).count,0);
});
test('Monitorie ausente retorna erro controlado e cache negativo; conta continua acessível',async()=>{
 const client=browser(); await client.register(); const reservoir=await connect(client,await provision(1,'monitorie'));
 const first=await client.request('/api/device/snapshot?reservoir_id='+reservoir.id); assert.equal(first.status,503); assert.equal((await first.json()).error.code,'MONITORIE_NOT_CONFIGURED');
 const second=await client.request('/api/device/snapshot?reservoir_id='+reservoir.id); assert.equal(second.status,503); assert.equal((await second.json()).error.code,'MONITORIE_UNAVAILABLE');
 assert.equal((await client.request('/api/auth/me')).status,200); assert.equal((await client.request('/api/reservoirs')).status,200);
});
test('ingestão exige token por dispositivo e preserva validação do firmware',async()=>{
 const token=randomBytes(32).toString('base64url');
 await configure({DEVICE_TOKENS:JSON.stringify({'1':token})});
 const client=browser(); await client.register(); const reservoir=await connect(client,await provision());
 const data={ID:'1',D:'25.5',NIVEL:'15',VOLUME:'300',RSSI_WIFI:'-61'};
 assert.equal((await client.request('/api/device/ingest',{method:'POST',data})).status,401);
 assert.equal((await client.request('/api/device/ingest?token='+token,{method:'POST',data})).status,401);
 const valid=await client.request('/api/device/ingest',{method:'POST',data,headers:{Authorization:`Bearer ${token}`}}); assert.equal(valid.status,200);
 const snapshot=await (await client.request('/api/device/snapshot?reservoir_id='+reservoir.id)).json(); assert.equal(snapshot.data.nivel,15); assert.equal(snapshot.alerts[0].type,'critical');
 assert.equal((await client.request('/api/device/current.php?reservoir_id='+reservoir.id)).status,200);
 assert.equal((await client.request('/api/device/ingest',{method:'POST',data:{...data,distancia:20},headers:{Authorization:`Bearer ${token}`}})).status,422);
 assert.equal((await client.request('/api/device/ingest',{method:'POST',data:{...data,NIVEL:101},headers:{Authorization:`Bearer ${token}`}})).status,422);
 await configure();
});
test('mocks funcionam somente em desenvolvimento local e snapshot usa cache',async()=>{
 await configure({APP_ENV:'development',MONITORIE_MODE:'mock',MAIL_MODE:'disabled'});
 assert.equal((await mf.dispatchFetch(base+'/login')).status,503);
 const client=browser('http://127.0.0.1'); await client.register(); const reservoir=await connect(client,await provision(1,'mock'));
 const first=await (await client.request('/api/device/snapshot?reservoir_id='+reservoir.id)).json(); assert.equal(first.simulated,true);
 await new Promise(r=>setTimeout(r,1100));
 const second=await (await client.request('/api/device/snapshot?reservoir_id='+reservoir.id)).json(); assert.equal(second.data.timestamp,first.data.timestamp);
 const page=await client.request('/'); assert.equal(page.status,302);
 const frontendHtml=await readFile('dist/frontend/index.html','utf8'); assert.match(frontendHtml,/Demonstração local/);
 await configure();
});
test('URL de recuperação local é rejeitada e modo de e-mail desativado não envia',async()=>{
 await configure({APP_URL:'http://127.0.0.1:8788'});
 const client=browser(); const user=await client.register('local-url@example.test');
 await client.request('/api/auth/forgot-password',{method:'POST',data:{email:user.email}});
 await new Promise(r=>setTimeout(r,150)); assert.equal(sent.length,0);
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM password_reset_tokens').first()).n,0);
 await configure({MAIL_MODE:'disabled'});
 await client.request('/api/auth/forgot-password',{method:'POST',data:{email:user.email}});
 await new Promise(r=>setTimeout(r,150)); assert.equal(sent.length,0);
 await configure();
});
test('compartilhamento Basic preserva leitura e impede mutação/reuso do cookie',async()=>{
 const client=browser(); const user=await client.register('share@example.test');
 const sharePassword=randomBytes(32).toString('base64url');
 await configure({DASHBOARD_SHARE_USERNAME:'viewer',DASHBOARD_SHARE_PASSWORD:sharePassword,DASHBOARD_SHARE_USER_EMAIL:user.email});
 const viewer=browser();
 const challenge=await viewer.request('/'); assert.equal(challenge.status,401); assert.match(challenge.headers.get('WWW-Authenticate'),/Basic/);
 const header={Authorization:'Basic '+Buffer.from('viewer:'+sharePassword).toString('base64')};
 const sharedRes=await viewer.request('/',{headers:header});
 assert.equal(sharedRes.status,302);
 assert.equal(sharedRes.headers.get('Location'),base+'/');
 assert.equal((await viewer.request('/api/reservoirs',{headers:header})).status,200);
 assert.equal((await viewer.request('/api/devices/connect',{method:'POST',data:{},headers:header})).status,403);
 await configure();
 const me=await (await viewer.request('/api/auth/me')).json();
 assert.equal((await viewer.request('/api/devices/connect',{method:'POST',data:{},headers:{'X-CSRF-Token':me.csrf_token}})).status,403);
});
test('artefato de publicação contém apenas frontend e Worker, sem PHP/segredos',async()=>{
 const files=await readdir('dist',{recursive:true});
 for(const path of files){
  assert.doesNotMatch(path,/(?:\.php$|\.env|dev\.vars|\.sql$|vendor\/autoload|node_modules)/);
  if(!/\.(?:js|html|css|json)$/.test(path))continue;
  const text=await readFile('dist/'+path,'utf8');
  assert.doesNotMatch(text,/xkeysib-[A-Za-z0-9-]{20,}/);
  for(const value of Object.values(keys)) assert.ok(!text.includes(value));
  if(!path.includes('worker')) assert.doesNotMatch(text,/\/api\/[\w/-]+\.php|<\?php/);
 }
});

test('perfil admin, restrição de acesso e bloqueio de autopromoção', async () => {
 const client = browser();
 const user = await client.register('normal@example.test', 'Normal User');
 assert.equal(user.role, 'user');
 const me = await (await client.request('/api/auth/me')).json();
 assert.equal(me.user.role, 'user');

 const anon = browser();
 const resAnon = await anon.request('/api/admin/devices');
 assert.equal(resAnon.status, 404);

 const resNormal = await client.request('/api/admin/devices');
 assert.equal(resNormal.status, 404);

 await configure({ INITIAL_ADMIN_EMAIL: 'primeiro-admin@example.test' });
 const adminClient = browser();
 const adminUser = await adminClient.register('primeiro-admin@example.test', 'Admin Bootstrap');
 assert.equal(adminUser.role, 'admin');

 const adminMe = await (await adminClient.request('/api/auth/me')).json();
 assert.equal(adminMe.user.role, 'admin');

 const adminRes = await adminClient.request('/api/admin/devices');
 assert.equal(adminRes.status, 200);
 await configure();
});

test('cadastro administrativo de SM-WU e SM-WA, validação de unicidade e modelo obrigatório', async () => {
 await configure({ INITIAL_ADMIN_EMAIL: 'admin-cad@example.test' });
 const admin = browser();
 await admin.register('admin-cad@example.test', 'Admin');

 const resWU = await admin.request('/api/admin/devices', {
  method: 'POST',
  data: { device_type: 'SM-WU', device_code: 'SMWU-001', external_id: 'mon_wu_1', source: 'monitorie' }
 });
 assert.equal(resWU.status, 201);
 const wu = (await resWU.json()).device;
 assert.equal(wu.device_type, 'SM-WU');
 assert.equal(wu.device_code, 'SMWU-001');

 const resWA = await admin.request('/api/admin/devices', {
  method: 'POST',
  data: { device_type: 'SM-WA', device_code: 'SMWA-002', external_id: 'mon_wa_2', source: 'monitorie' }
 });
 assert.equal(resWA.status, 201);
 const wa = (await resWA.json()).device;
 assert.equal(wa.device_type, 'SM-WA');
 assert.equal(wa.device_code, 'SMWA-002');

 const resInvalidType = await admin.request('/api/admin/devices', {
  method: 'POST',
  data: { device_type: 'OUTRO', device_code: 'DEV-999' }
 });
 assert.equal(resInvalidType.status, 422);

 const resDupCode = await admin.request('/api/admin/devices', {
  method: 'POST',
  data: { device_type: 'SM-WU', device_code: 'SMWU-001' }
 });
 assert.equal(resDupCode.status, 409);

 const resDupExt = await admin.request('/api/admin/devices', {
  method: 'POST',
  data: { device_type: 'SM-WA', device_code: 'SMWA-003', external_id: 'mon_wu_1', source: 'monitorie' }
 });
 assert.equal(resDupExt.status, 409);

 await configure();
});

test('código de ativação puro de uso único, armazenamento apenas de hash e revogação', async () => {
 await configure({ INITIAL_ADMIN_EMAIL: 'admin-code@example.test' });
 const admin = browser();
 await admin.register('admin-code@example.test', 'Admin');

 const resDev = await admin.request('/api/admin/devices', {
  method: 'POST',
  data: { device_type: 'SM-WU', device_code: 'SMWU-CODE-TEST' }
 });
 const devId = (await resDev.json()).device.id;

 const resCode = await admin.request(`/api/admin/devices/${devId}/generate-code`, { method: 'POST', data: {} });
 assert.equal(resCode.status, 200);
 const codePayload = await resCode.json();
 const plainCode = codePayload.activation_code;
 assert.match(plainCode, /^HIDRA-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

 const codeRow = await db.prepare('SELECT * FROM activation_codes WHERE device_id=?').bind(devId).first();
 assert.ok(codeRow);
 assert.equal(codeRow.code_hash, digest(plainCode));
 assert.ok(!JSON.stringify(codeRow).includes(plainCode));

 const devRow = await db.prepare('SELECT pairing_code_hash FROM devices WHERE id=?').bind(devId).first();
 assert.equal(devRow.pairing_code_hash, digest(plainCode));

 const resRevoke = await admin.request(`/api/admin/devices/${devId}/revoke-code`, { method: 'POST', data: {} });
 assert.equal(resRevoke.status, 200);

 const devAfter = await db.prepare('SELECT pairing_code_hash FROM devices WHERE id=?').bind(devId).first();
 assert.equal(devAfter.pairing_code_hash, null);

 const client = browser();
 await client.register('client-rev@example.test', 'Client Rev');
 const resPair = await client.request('/api/devices/validate-pairing', {
  method: 'POST',
  data: { pairing_code: plainCode }
 });
 assert.equal(resPair.status, 422);

 await configure();
});

test('ativação pelo cliente, isolamento completo na transferência e impedimento de alteração silenciosa', async () => {
 await configure({ INITIAL_ADMIN_EMAIL: 'admin-trans@example.test' });
 const admin = browser();
 await admin.register('admin-trans@example.test', 'Admin');

 const resDev = await admin.request('/api/admin/devices', {
  method: 'POST',
  data: { device_type: 'SM-WU', device_code: 'SMWU-FLOW-01', external_id: 'ext_flow_01', source: 'local' }
 });
 const devId = (await resDev.json()).device.id;

 const codeA = (await (await admin.request(`/api/admin/devices/${devId}/generate-code`, { method: 'POST', data: {} })).json()).activation_code;

 const clientA = browser();
 await clientA.register('client-a@example.test', 'Cliente A');
 const pairA = await clientA.request('/api/devices/connect', {
  method: 'POST',
  data: { pairing_code: codeA, reservoir_name: 'Reservatório Cliente A' }
 });
 assert.equal(pairA.status, 201);
 const resIdA = (await pairA.json()).data.id;

 await db.prepare('INSERT INTO smwu_readings(id, reservoir_id, distancia, nivel, volume, rssi_wifi, created_at) VALUES (?, ?, 20, 80, 800, -60, ?)').bind(devId, resIdA, seconds()).run();

 const histA = await (await clientA.request(`/api/device/history?reservoir_id=${resIdA}`)).json();
 assert.equal(histA.data.length, 1);
 assert.equal(histA.data[0].nivel, 80);

 const resSilent = await admin.request(`/api/admin/devices/${devId}/update`, {
  method: 'POST',
  data: { external_id: 'ext_alterado_silenciosamente' }
 });
 assert.equal(resSilent.status, 422);

 const resConfirmed = await admin.request(`/api/admin/devices/${devId}/update`, {
  method: 'POST',
  data: { external_id: 'ext_alterado_confirmado', confirm_linked_modification: true }
 });
 assert.equal(resConfirmed.status, 200);

 const clientB = browser();
 await clientB.register('client-b@example.test', 'Cliente B');
 const pairBAttempt = await clientB.request('/api/devices/connect', {
  method: 'POST',
  data: { pairing_code: codeA, reservoir_name: 'Tentativa B' }
 });
 assert.equal(pairBAttempt.status, 422);

 const resTransfer = await admin.request(`/api/admin/devices/${devId}/transfer`, { method: 'POST', data: {} });
 assert.equal(resTransfer.status, 200);
 const codeB = (await resTransfer.json()).activation_code;

 const pairB = await clientB.request('/api/devices/connect', {
  method: 'POST',
  data: { pairing_code: codeB, reservoir_name: 'Novo Reservatório Cliente B' }
 });
 assert.equal(pairB.status, 201);
 const resIdB = (await pairB.json()).data.id;
 assert.notEqual(resIdA, resIdB);

 const histB = await (await clientB.request(`/api/device/history?reservoir_id=${resIdB}`)).json();
 assert.equal(histB.data.length, 0);

 const attemptSneak = await clientB.request(`/api/device/history?reservoir_id=${resIdA}`);
 assert.equal(attemptSneak.status, 404);

 const audit = await (await admin.request(`/api/admin/audit-logs?device_id=${devId}`)).json();
 const actions = audit.data.map(a => a.action);
 assert.ok(actions.includes('device_created'));
 assert.ok(actions.includes('code_generated'));
 assert.ok(actions.includes('device_activated'));
 assert.ok(actions.includes('device_updated'));
 assert.ok(actions.includes('transfer_initiated'));

 await configure();
});

test('interface do cliente exibe texto de ativação fornecido pelo instalador e modelos SM-WU / SM-WA', async () => {
 const indexHtml = await readFile('web/index.html', 'utf8');
 assert.match(indexHtml, /Código de ativação fornecido pelo instalador/);
 const adminHtml = await readFile('web/admin.html', 'utf8');
 assert.match(adminHtml, /SM-WU/);
 assert.match(adminHtml, /SM-WA/);
});

test('seletor de tema (Automático, Claro, Escuro), assets compartilhados e anti-FOUC em todas as páginas', async () => {
 const themeJs = await readFile('dist/frontend/static/js/theme.js', 'utf8');
 assert.ok(themeJs.includes('hidra_theme'));
 assert.ok(themeJs.includes('prefers-color-scheme'));
 assert.ok(themeJs.includes('data-theme'));

 const themeCss = await readFile('dist/frontend/static/css/theme.css', 'utf8');
 assert.ok(themeCss.includes('[data-theme="light"]'));
 assert.ok(themeCss.includes('[data-theme="dark"]'));
 assert.ok(themeCss.includes('.theme-selector'));

 for (const page of ['index.html', 'login.html', 'register.html', 'forgot-password.html', 'reset-password.html', 'admin.html']) {
  const html = await readFile(`dist/frontend/${page}`, 'utf8');
  assert.ok(html.includes('theme.css'), `${page} deve incluir theme.css`);
  assert.ok(html.includes('theme.js'), `${page} deve incluir theme.js no head`);
  assert.ok(html.includes('theme-selector'), `${page} deve incluir o seletor de tema`);
  assert.ok(html.includes('data-theme-value="auto"'), `${page} deve conter a opção auto`);
  assert.ok(html.includes('data-theme-value="light"'), `${page} deve conter a opção light`);
  assert.ok(html.includes('data-theme-value="dark"'), `${page} deve conter a opção dark`);
 }

 const indexHtml = await readFile('dist/frontend/index.html', 'utf8');
 assert.ok(indexHtml.includes('id="account-modal"'));
 assert.ok(indexHtml.includes('Aparência do sistema'));
 assert.ok(indexHtml.includes('id="configuracoes"'));
});


