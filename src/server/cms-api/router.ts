import type { SupabaseClient } from '@supabase/supabase-js';
import { errorResponse } from './http';

export interface HandlerContext {
  actorEmail: string;
  requestId: string;
  supabase: SupabaseClient;
}

export type RouteHandler = (
  req: Request,
  env: CloudflareEnv,
  params: Record<string, string>,
  ctx: HandlerContext,
) => Promise<Response>;

export interface RouteDef {
  method: string;
  path: string;
  handler: RouteHandler;
}

interface CompiledRoute extends RouteDef {
  pattern: RegExp;
  paramNames: string[];
}

function compile(path: string): { pattern: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const source = path.replace(/\{(\w+)\}/g, (_match, name: string) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  return { pattern: new RegExp(`^${source}$`), paramNames };
}

export function createRouter(routes: RouteDef[]) {
  const compiled: CompiledRoute[] = routes.map((route) => ({ ...route, ...compile(route.path) }));

  return async function dispatch(req: Request, env: CloudflareEnv, ctx: HandlerContext): Promise<Response> {
    const url = new URL(req.url);
    let pathMatched = false;

    for (const route of compiled) {
      const match = route.pattern.exec(url.pathname);
      if (!match) continue;
      pathMatched = true;
      if (route.method !== req.method) continue;

      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1]);
      });
      return route.handler(req, env, params, ctx);
    }

    if (pathMatched) {
      return errorResponse('NOT_FOUND', 'Method not allowed for this path.', 404, ctx.requestId);
    }
    return errorResponse('NOT_IMPLEMENTED', 'Unknown or not-yet-implemented route.', 404, ctx.requestId);
  };
}
