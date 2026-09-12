import type { RouteDef } from '../router';
import { jsonResponse, errorResponse } from '../http';
import { loadProductResponse } from '../mapping';

const AVAILABILITY_VALUES = ['available', 'sold', 'showroom'] as const;

export const availabilityRoute: RouteDef = {
  method: 'PUT',
  path: '/v1/products/{id}/availability',
  handler: async (req, env, params, ctx) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse('VALIDATION_FAILED', 'Request body must be valid JSON.', 422, ctx.requestId);
    }

    const parsed = body as { expectedRevision?: unknown; availability?: unknown; showroom?: unknown };
    if (
      typeof parsed.expectedRevision !== 'number' ||
      !AVAILABILITY_VALUES.includes(parsed.availability as (typeof AVAILABILITY_VALUES)[number]) ||
      typeof parsed.showroom !== 'boolean'
    ) {
      return errorResponse('VALIDATION_FAILED', 'expectedRevision, availability, and showroom are required.', 422, ctx.requestId);
    }

    const product = await loadProductResponse(ctx.supabase, env, params.id);
    if (!product) {
      return errorResponse('NOT_FOUND', `Product ${params.id} does not exist.`, 404, ctx.requestId);
    }
    if (product.type !== 'ceramic') {
      return errorResponse('VALIDATION_FAILED', 'Availability only applies to ceramic pieces.', 422, ctx.requestId);
    }
    if (product.revision !== parsed.expectedRevision) {
      return errorResponse(
        'REVISION_CONFLICT',
        'Ktoś zapisał nowszą wersję. Przejrzyj zmiany i spróbuj ponownie.',
        409,
        ctx.requestId,
        { currentRevision: product.revision },
      );
    }

    const availability = parsed.availability as (typeof AVAILABILITY_VALUES)[number];
    const pieceAvailability = availability === 'showroom' ? 'available' : availability;
    const showroom = availability === 'showroom' ? true : (parsed.showroom as boolean);

    const { error } = await ctx.supabase.rpc('set_piece_availability_guarded', {
      p_product_id: params.id,
      p_availability: pieceAvailability,
      p_showroom: showroom,
      p_actor_email: ctx.actorEmail,
    });

    if (error) {
      if (error.message?.includes('reservation_active')) {
        return errorResponse(
          'RESERVATION_ACTIVE',
          'Ten egzemplarz jest obecnie zarezerwowany lub sprzedany online — zmiana dostępności jest tu zablokowana.',
          409,
          ctx.requestId,
        );
      }
      throw error;
    }

    const updated = await loadProductResponse(ctx.supabase, env, params.id);
    return jsonResponse(updated);
  },
};
