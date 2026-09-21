import './build.mjs';
import { localRuntime } from './local-runtime.mjs';
import { frontendServer } from './dev-frontend.mjs';

const { mf } = await localRuntime({ port: 8787, monitorie: true });
await mf.ready;
await frontendServer();
console.log('API local MonitorIE: http://127.0.0.1:8787');
console.log('Frontend local: http://127.0.0.1:8788');
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    await mf.dispose();
    process.exit(0);
  });
