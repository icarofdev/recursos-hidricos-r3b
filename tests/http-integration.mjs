import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const runtime = path.join(root, '.runtime');
const databasePath = path.join(runtime, `http-test-${process.pid}.sqlite`);
const php = process.env.PHP_BINARY || (process.platform === 'win32' ? 'C:\\xampp\\php\\php.exe' : 'php');
const externalBaseUrl = process.env.TEST_BASE_URL || '';
mkdirSync(runtime, { recursive: true });

function expect(condition, message) {
    if (!condition) throw new Error(message);
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            server.close(() => resolve(address.port));
        });
    });
}

function cookieFrom(response, current = '') {
    const values = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter(Boolean);
    const session = values.map(value => value.split(';')[0]).find(value => value.startsWith('HIDRAR3BSESSID='));
    return session || current;
}

function csrfFrom(html) {
    const match = html.match(/<meta name="csrf-token" content="([a-f0-9]{64})">/);
    expect(match, 'Página não expôs um token CSRF válido.');
    return match[1];
}

async function waitForServer(baseUrl) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
            const response = await fetch(`${baseUrl}/health.php`);
            if (response.ok) return;
        } catch { /* servidor ainda inicializando */ }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Servidor HTTP de teste não iniciou.');
}

let server = null;
let serverErrors = '';
let baseUrl = externalBaseUrl;

if (!externalBaseUrl) {
    const initialized = spawnSync(php, [path.join(root, 'tests', 'init-http-db.php'), databasePath], {
        cwd: root,
        encoding: 'utf8'
    });
    if (initialized.status !== 0) {
        throw new Error(`Falha ao criar banco HTTP: ${initialized.error?.message || initialized.stderr || initialized.stdout || 'erro desconhecido'}`);
    }

    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(php, ['-S', `127.0.0.1:${port}`, 'router.php'], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            APP_ENV: 'testing',
            APP_URL: baseUrl,
            APP_KEY: 'http-integration-key-with-more-than-32-characters',
            DB_CONNECTION: 'sqlite',
            DB_SQLITE_PATH: databasePath,
            DEVICE_ALLOWED_IDS: '1',
            DEVICE_TOKEN_SECRET: 'device-test-token',
            PASSWORD_RESET_TTL_MINUTES: '20'
        }
    });
    server.stderr.on('data', chunk => { serverErrors += chunk.toString(); });
}

try {
    await waitForServer(baseUrl);
    let cookie = '';

    const landing = await fetch(`${baseUrl}/`, { redirect: 'manual' });
    expect(landing.status === 302, 'Visitante em / deve ser redirecionado.');
    expect(landing.headers.get('location')?.startsWith('/login'), 'Visitante deve ir para /login.');

    const loginPage = await fetch(`${baseUrl}/login`, { redirect: 'manual' });
    expect(loginPage.status === 200, 'Tela de login deve abrir.');
    cookie = cookieFrom(loginPage, cookie);
    const csrf = csrfFrom(await loginPage.text());

    const register = await fetch(`${baseUrl}/api/auth/register.php`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({
            name: 'Usuário HTTP',
            email: 'http@example.com',
            password: 'SenhaHttp2026',
            password_confirmation: 'SenhaHttp2026'
        })
    });
    expect(register.status === 201, `Cadastro HTTP falhou (${register.status}).`);
    cookie = cookieFrom(register, cookie);
    const registered = await register.json();
    expect(registered.success === true, 'Cadastro deve retornar sucesso.');

    const authenticatedLoginPage = await fetch(`${baseUrl}/login`, { headers: { Cookie: cookie }, redirect: 'manual' });
    expect(authenticatedLoginPage.status === 302 && authenticatedLoginPage.headers.get('location') === '/', 'Usuário autenticado em /login deve ir para a dashboard.');

    const dashboard = await fetch(`${baseUrl}/`, { headers: { Cookie: cookie }, redirect: 'manual' });
    expect(dashboard.status === 200, 'Dashboard privada deve abrir para usuário autenticado.');
    expect((await dashboard.text()).includes('Bem-vindo ao Hidra R3B'), 'Dashboard deve conter onboarding sem dispositivo.');

    const me = await fetch(`${baseUrl}/api/auth/me.php`, { headers: { Cookie: cookie } });
    expect(me.status === 200 && (await me.json()).user.email === 'http@example.com', 'Endpoint de usuário atual deve respeitar a sessão.');

    const logout = await fetch(`${baseUrl}/api/auth/logout.php`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': registered.csrf_token },
        body: '{}'
    });
    expect(logout.status === 200, 'Logout deve encerrar a sessão.');
    cookie = cookieFrom(logout, cookie);

    const protectedAfterLogout = await fetch(`${baseUrl}/api/auth/me.php`, { headers: { Cookie: cookie } });
    expect(protectedAfterLogout.status === 401, 'API privada deve rejeitar sessão encerrada.');

    const loginPageAgain = await fetch(`${baseUrl}/login`);
    cookie = cookieFrom(loginPageAgain, '');
    const csrfAgain = csrfFrom(await loginPageAgain.text());
    const login = await fetch(`${baseUrl}/api/auth/login.php`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfAgain },
        body: JSON.stringify({ email: 'http@example.com', password: 'SenhaHttp2026', remember: true, next: '//evil.example' })
    });
    const loggedIn = await login.json();
    expect(login.status === 200 && loggedIn.redirect === '/', 'Login deve funcionar e bloquear redirecionamento externo.');

    console.log('[OK] HTTP: entrada, rotas protegidas, cadastro, login, sessão e logout');
} finally {
    if (server) {
        server.kill();
        rmSync(databasePath, { force: true });
    }
}

if (/Fatal error|Uncaught/i.test(serverErrors)) {
    throw new Error(`Servidor registrou erro fatal:\n${serverErrors}`);
}
