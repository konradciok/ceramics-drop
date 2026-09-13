import type { RouteDef } from '../router';
import { jsonResponse } from '../http';
import { CMS_API_CONTRACT_VERSION } from '../contract';

export const sessionRoute: RouteDef = {
  method: 'GET',
  path: '/v1/session',
  handler: async (_req, env, _params, ctx) => {
    return jsonResponse({
      email: ctx.actorEmail,
      environment: env.CMS_API_ENVIRONMENT === 'integration' ? 'integration' : 'production',
      contractVersion: CMS_API_CONTRACT_VERSION,
      writesEnabled: true,
    });
  },
};
