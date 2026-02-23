import type { ServerResponse } from 'http';

export function apiError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  detail?: Record<string, unknown>,
): void {
  const body: Record<string, unknown> = { error: { code, message } };
  if (detail) (body.error as Record<string, unknown>).detail = detail;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function apiOk(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
