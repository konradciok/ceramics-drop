import type { SupabaseClient } from '@supabase/supabase-js';
import { verifyCmsAccess } from './access';
import { errorResponse, newRequestId } from './http';
import { createRouter, type RouteDef } from './router';
import { sessionRoute } from './handlers/session';
import { capabilitiesRoute } from './handlers/capabilities';
import { productsListRoute } from './handlers/products-list';
import { productsGetRoute } from './handlers/products-get';
import { productsCreateRoute } from './handlers/products-create';
import { productsSaveRoute } from './handlers/products-save';
import { productsDuplicateRoute } from './handlers/products-duplicate';
import { publicationGetRoute, publicationPostRoute } from './handlers/publication';
import { availabilityRoute } from './handlers/availability';
import { proofDecisionRoute } from './handlers/proofs';
import { auditRoute } from './handlers/audit';
import { previewsRoute } from './handlers/previews';

// Later tasks append their RouteDef exports to this array. Keep it a plain
// array literal (not a function) so each task's diff is a one-line addition.
const routes: RouteDef[] = [
  sessionRoute,
  capabilitiesRoute,
  productsListRoute,
  productsGetRoute,
  productsCreateRoute,
  productsSaveRoute,
  productsDuplicateRoute,
  publicationGetRoute,
  publicationPostRoute,
  availabilityRoute,
  proofDecisionRoute,
  auditRoute,
  previewsRoute,
];

const dispatch = createRouter(routes);

export type CmsApiDeps = {
  makeSupabase: (env: CloudflareEnv) => SupabaseClient;
};

export async function handleCmsApiRequest(request: Request, env: CloudflareEnv, deps: CmsApiDeps): Promise<Response> {
  const requestId = newRequestId();
  const access = await verifyCmsAccess(request, env);

  if (!access.ok) {
    const message =
      access.status === 401
        ? 'Missing or invalid Access token.'
        : access.status === 403
          ? 'Not an authorized owner.'
          : 'Not found.';
    const code = access.status === 401 ? 'UNAUTHORIZED' : access.status === 403 ? 'FORBIDDEN' : 'NOT_FOUND';
    return errorResponse(code, message, access.status, requestId);
  }

  const supabase = deps.makeSupabase(env);
  try {
    return await dispatch(request, env, { actorEmail: access.email, requestId, supabase });
  } catch (err) {
    console.error(`[cms-api] ${requestId} unhandled error:`, err);
    return errorResponse('INTERNAL_ERROR', 'Unexpected server error.', 500, requestId);
  }
}
