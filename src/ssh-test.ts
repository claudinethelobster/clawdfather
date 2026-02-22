import { spawn } from 'child_process';
import { writeFile, unlink, mkdtemp } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

export interface SSHTestResult {
  ok: boolean;
  durationMs: number;
  hostKeyFingerprint?: string;
  errorCode?: 'auth_fail' | 'timeout' | 'refused' | 'unknown';
  errorMessage?: string;
}

export async function testSSHConnection(params: {
  host: string;
  port: number;
  username: string;
  privateKeyPath: string;
  knownHostFingerprint?: string;
  acceptHostKey?: boolean;
  timeoutMs?: number;
}): Promise<SSHTestResult> {
  const timeout = params.timeoutMs ?? 15000;
  const connectTimeout = Math.max(1, Math.floor(timeout / 1000));
  const start = Date.now();

  let knownHostsPath: string | null = null;
  let tempDir: string | null = null;

  try {
    const args = [
      '-o', 'BatchMode=yes',
      '-o', `ConnectTimeout=${connectTimeout}`,
      '-o', 'IdentityFile=' + params.privateKeyPath,
      '-p', String(params.port),
    ];

    if (params.knownHostFingerprint) {
      tempDir = await mkdtemp(join(tmpdir(), 'cf-kh-'));
      knownHostsPath = join(tempDir, 'known_hosts');
      await writeFile(knownHostsPath, `${params.host} ${params.knownHostFingerprint}\n`, { mode: 0o600 });
      args.push('-o', `UserKnownHostsFile=${knownHostsPath}`);
      args.push('-o', 'StrictHostKeyChecking=yes');
    } else if (params.acceptHostKey) {
      args.push('-o', 'StrictHostKeyChecking=accept-new');
    } else {
      args.push('-o', 'StrictHostKeyChecking=accept-new');
    }

    args.push(`${params.username}@${params.host}`, 'exit', '0');

    return await new Promise<SSHTestResult>((resolve) => {
      const proc = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });

      let stderr = '';
      let stdout = '';
      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        resolve({
          ok: false,
          durationMs: Date.now() - start,
          errorCode: 'timeout',
          errorMessage: `Connection timed out after ${timeout}ms`,
        });
      }, timeout);

      proc.on('close', (code) => {
        clearTimeout(timer);
        const durationMs = Date.now() - start;

        let hostKeyFingerprint: string | undefined;
        const fpMatch = stderr.match(/SHA256:[A-Za-z0-9+/=]+/);
        if (fpMatch) hostKeyFingerprint = fpMatch[0];

        if (code === 0) {
          resolve({ ok: true, durationMs, hostKeyFingerprint });
          return;
        }

        let errorCode: SSHTestResult['errorCode'] = 'unknown';
        if (/Permission denied|authentication/i.test(stderr)) {
          errorCode = 'auth_fail';
        } else if (/Connection refused|Network unreachable|No route to host/i.test(stderr)) {
          errorCode = 'refused';
        } else if (/timed?\s*out/i.test(stderr)) {
          errorCode = 'timeout';
        }

        resolve({
          ok: false,
          durationMs,
          hostKeyFingerprint,
          errorCode,
          errorMessage: stderr.trim().split('\n').pop() || `SSH exited with code ${code}`,
        });
      });

      proc.on('error', (err: Error) => {
        clearTimeout(timer);
        resolve({
          ok: false,
          durationMs: Date.now() - start,
          errorCode: 'unknown',
          errorMessage: err.message,
        });
      });
    });
  } finally {
    if (knownHostsPath) unlink(knownHostsPath).catch(() => {});
    if (tempDir) {
      import('fs/promises').then((fs) => fs.rm(tempDir!, { recursive: true })).catch(() => {});
    }
  }
}
