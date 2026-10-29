/**
 * 主机发现：脚本语法 + 分段解析校验（用本地 sh 执行，不依赖 docker/systemd 是否存在）。
 */
import { execFileSync } from 'node:child_process';
import { buildDiscoveryScript, parseDiscovery } from '../src/sources.mjs';

const script = buildDiscoveryScript('docker');
const out = execFileSync('sh', ['-c', script], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const info = parseDiscovery(out);

console.log('OS:', info.os);
console.log('容器:', info.docker.length, info.docker.slice(0, 3).map((d) => d.name).join(','));
console.log('服务:', info.services.length, info.services.slice(0, 5).join(','));
console.log('活跃日志:', info.hotLogs.length, info.hotLogs.slice(0, 3).map((f) => f.file).join(','));
console.log('journald:', info.journald);

for (const key of ['os', 'docker', 'services', 'hotLogs']) {
  if (!(key in info)) throw new Error(`发现结果缺少 ${key}`);
}
if (typeof info.os !== 'string' || !info.os) throw new Error('OS 解析失败');
if (!Array.isArray(info.docker) || !Array.isArray(info.hotLogs)) throw new Error('数组字段类型错误');

// 敏感文件即使出现在发现结果里也必须被过滤
const fake = ['##HOTLOG', '1024|/root/.ssh/id_rsa', '2048|/opt/app/.env', '4096|/var/log/app.log', '##END'].join('\n');
const filtered = parseDiscovery(fake);
if (filtered.hotLogs.some((f) => f.file.includes('.ssh') || f.file.includes('.env'))) throw new Error('敏感路径未被过滤');
if (!filtered.hotLogs.some((f) => f.file === '/var/log/app.log')) throw new Error('正常日志被误过滤');
console.log('敏感路径过滤 ✓');

console.log('\n--- 主机发现校验通过 ---');
