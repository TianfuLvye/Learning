import { createApp } from './app';
import { loadConfig } from './config';

const config = loadConfig();
const { app, events } = createApp(config);
events.watch(config.learnDir);

const server = app.listen(config.port, () => {
  console.log(`\n📚 学习系统后端已启动：http://localhost:${config.port}`);
  console.log(`   学习资料目录：${config.learnDir}`);
  console.log(`   提示词目录：  ${config.promptsDir}`);
  console.log(
    config.ai.apiKey
      ? `   DeepSeek：已配置（模型 ${config.ai.model}）`
      : '   DeepSeek：未配置 API Key —— 阅读与进度功能可用，AI 练习不可用（请在 .env 中设置 DEEPSEEK_API_KEY）',
  );
  if (config.staticDir) console.log(`   前端静态资源：${config.staticDir}`);
});

// 生成练习可能耗时较长
server.requestTimeout = 0;
server.headersTimeout = 65_000;

const shutdown = async () => {
  await events.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
