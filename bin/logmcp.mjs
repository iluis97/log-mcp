#!/usr/bin/env node
import { startServer } from '../src/server.mjs';

startServer()
  .then(() => process.exit(0))
  .catch((err) => {
    process.stderr.write(`[logmcp] 启动失败: ${err?.message ?? err}\n`);
    process.exit(1);
  });
