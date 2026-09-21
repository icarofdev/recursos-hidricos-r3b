import './build.mjs';
await import('./dev-api.mjs');
const { frontendServer } = await import('./dev-frontend.mjs');
await frontendServer();
console.log('Frontend local: http://127.0.0.1:8788');
