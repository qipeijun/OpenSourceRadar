import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const { app } = createApp({ config });
await app.listen({ host: '127.0.0.1', port: config.port });
console.log(`OpenSourceRadar 已启动：http://127.0.0.1:${config.port}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  void app.close().then(() => { process.exitCode = 0; }).catch(() => { console.error('本地服务关闭失败'); process.exitCode = 1; });
});
