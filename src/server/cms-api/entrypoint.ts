import { WorkerEntrypoint } from 'cloudflare:workers';
import { adminSupabaseFromEnv } from '@/lib/admin/clients';
import { handleCmsApiRequest } from './request-handler';

export class CmsApi extends WorkerEntrypoint<CloudflareEnv> {
  async fetch(request: Request): Promise<Response> {
    return handleCmsApiRequest(request, this.env, {
      makeSupabase: (env) => adminSupabaseFromEnv(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY),
    });
  }
}
