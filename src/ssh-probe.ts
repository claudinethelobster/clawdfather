import * as dns from 'dns';
import * as net from 'net';

export type ProbeStatus = 'connectable' | 'dns_fail' | 'port_fail' | 'ssh_fail';

export interface ProbeResult {
  status: ProbeStatus;
  latencyMs?: number;
  errorDetail?: string;
  resolvedIp?: string;
}

function dnsLookup(host: string): Promise<{ address: string } | { error: string }> {
  return new Promise((resolve) => {
    dns.lookup(host, (err, address) => {
      if (err) resolve({ error: err.message });
      else resolve({ address });
    });
  });
}

export async function probeConnectivity(host: string, port: number, timeoutMs?: number): Promise<ProbeResult> {
  const timeout = timeoutMs ?? 8000;
  const start = Date.now();

  const dnsResult = await dnsLookup(host);
  if ('error' in dnsResult) {
    return { status: 'dns_fail', errorDetail: dnsResult.error };
  }
  const resolvedIp = dnsResult.address;

  return new Promise<ProbeResult>((resolve) => {
    const sock = net.createConnection({ host, port, timeout });
    let resolved = false;
    let banner = '';

    const finish = (result: ProbeResult) => {
      if (resolved) return;
      resolved = true;
      sock.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ status: 'port_fail', errorDetail: 'Connection timed out', resolvedIp });
    }, timeout);

    sock.on('connect', () => {
      sock.setTimeout(3000);
    });

    sock.on('data', (data: Buffer) => {
      banner += data.toString('utf8');
      clearTimeout(timer);
      if (banner.startsWith('SSH-')) {
        finish({
          status: 'connectable',
          latencyMs: Date.now() - start,
          resolvedIp,
        });
      } else if (banner.length >= 256) {
        finish({
          status: 'ssh_fail',
          errorDetail: 'Port is open but not running SSH',
          resolvedIp,
        });
      }
    });

    sock.on('timeout', () => {
      if (banner.length === 0) {
        clearTimeout(timer);
        finish({ status: 'port_fail', errorDetail: 'Connection timed out', resolvedIp });
      }
    });

    sock.on('error', (err: Error) => {
      clearTimeout(timer);
      finish({ status: 'port_fail', errorDetail: err.message, resolvedIp });
    });

    sock.on('end', () => {
      clearTimeout(timer);
      if (!resolved) {
        if (banner.startsWith('SSH-')) {
          finish({ status: 'connectable', latencyMs: Date.now() - start, resolvedIp });
        } else {
          finish({ status: 'ssh_fail', errorDetail: 'Port is open but not running SSH', resolvedIp });
        }
      }
    });
  });
}
