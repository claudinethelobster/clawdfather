import type { IncomingMessage, ServerResponse } from 'http';

export type RouteHandler = (req: IncomingMessage, res: ServerResponse, match: RegExpExecArray) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: RouteHandler;
}

export class ApiRouter {
  private routes: Route[] = [];

  add(method: string, pattern: RegExp, handler: RouteHandler): void {
    this.routes.push({ method: method.toUpperCase(), pattern, handler });
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const method = (req.method ?? 'GET').toUpperCase();
    const url = (req.url ?? '/').split('?')[0];

    for (const route of this.routes) {
      if (route.method !== method && route.method !== '*') continue;
      const match = route.pattern.exec(url);
      if (match) {
        await route.handler(req, res, match);
        return true;
      }
    }
    return false;
  }
}
