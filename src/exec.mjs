import { spawn } from 'node:child_process';

const STDERR_LIMIT = 64 * 1024;

/**
 * 执行外部命令（不经过 shell），收集输出并限制大小与时长。
 * 只用于固定命令模板 + 校验后的参数，绝不拼接用户输入到 shell。
 */
export function runCommand(file, args, { timeoutMs = 25000, maxBytes = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, stdout: Buffer.alloc(0), stderr: String(err?.message ?? err), killed: false });
      return;
    }

    const out = [];
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    let killed = false;

    const finish = (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8'), killed });
    };

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      outBytes += chunk.length;
      if (outBytes > maxBytes) {
        killed = true;
        child.kill('SIGKILL');
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (errBytes >= STDERR_LIMIT) return;
      errBytes += chunk.length;
      err.push(chunk);
    });
    child.on('error', (e) => finish(-1));
    child.on('close', (code) => finish(code));
  });
}
