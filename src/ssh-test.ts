import { Client as SSHClient } from 'ssh2';
import { createHash } from 'crypto';

export interface SshTestResult {
  result: string;
  latency_ms: number | null;
  host_key_fingerprint: string | null;
  message: string;
}

export function testSSHConnection(
  host: string,
  port: number,
  username: string,
  privateKeyPem: string,
): Promise<SshTestResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    let hostKeyFP: string | null = null;
    let settled = false;

    const settle = (val: SshTestResult) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch {}
      resolve(val);
    };

    const timer = setTimeout(() => {
      settle({ result: 'timeout', latency_ms: null, host_key_fingerprint: null, message: 'Connection timed out after 15 seconds.' });
    }, 15_000);

    const conn = new SSHClient();

    conn.on('ready', () => {
      const latency = Date.now() - start;
      conn.exec('echo CLAWDFATHER_OK', (err, stream) => {
        if (err) {
          clearTimeout(timer);
          settle({ result: 'ok', latency_ms: latency, host_key_fingerprint: hostKeyFP, message: 'SSH connection successful.' });
          return;
        }
        stream.on('close', () => {
          clearTimeout(timer);
          settle({ result: 'ok', latency_ms: latency, host_key_fingerprint: hostKeyFP, message: 'SSH connection successful.' });
        });
        stream.on('data', () => {});
        stream.stderr.on('data', () => {});
      });
    });

    conn.on('error', (err: Error & { level?: string }) => {
      clearTimeout(timer);
      const msg = err.message || 'Connection failed.';
      if (msg.includes('ECONNREFUSED')) {
        settle({ result: 'failed', latency_ms: null, host_key_fingerprint: null, message: 'Connection refused. SSH may not be running on this port.' });
      } else if (msg.includes('ENOTFOUND') || msg.includes('getaddrinfo')) {
        settle({ result: 'failed', latency_ms: null, host_key_fingerprint: null, message: 'Cannot resolve hostname.' });
      } else if (msg.includes('ETIMEDOUT')) {
        settle({ result: 'timeout', latency_ms: null, host_key_fingerprint: null, message: 'Connection timed out.' });
      } else if (err.level === 'client-authentication') {
        settle({ result: 'failed', latency_ms: null, host_key_fingerprint: hostKeyFP, message: 'Authentication failed. The server rejected your key.' });
      } else {
        settle({ result: 'failed', latency_ms: null, host_key_fingerprint: hostKeyFP, message: msg });
      }
    });

    conn.connect({
      host,
      port,
      username,
      privateKey: privateKeyPem,
      readyTimeout: 15_000,
      hostVerifier: (key: Buffer) => {
        const hash = createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
        hostKeyFP = `SHA256:${hash}`;
        return true;
      },
    });
  });
}
