import { localRuntime } from './local-runtime.mjs';
const { mf } = await localRuntime({ port: 8787 });
await mf.ready;
console.log('API local: http://127.0.0.1:8787 (sem rede externa)');
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    await mf.dispose();
    process.exit(0);
  });
