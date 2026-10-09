import { localRuntime } from './local-runtime.mjs';
const port = process.env.HIDRA_E2E_NO_DEV_VARS === '1' ? 18887 : 8787;
const { mf } = await localRuntime({ port });
await mf.ready;
console.log(`API local: http://127.0.0.1:${port} (sem rede externa)`);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    await mf.dispose();
    process.exit(0);
  });
