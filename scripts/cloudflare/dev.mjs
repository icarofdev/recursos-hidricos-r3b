import './build.mjs';
await import('./dev-api.mjs');
const { frontendServer } = await import('./dev-frontend.mjs');
const port = process.env.HIDRA_E2E_NO_DEV_VARS === '1' ? 18888 : 8788;
await frontendServer(port);
console.log(`Frontend local: http://127.0.0.1:${port}`);
