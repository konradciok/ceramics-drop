import type { RouteDef } from '../router';
import { jsonResponse } from '../http';
import { CMS_API_CONTRACT_VERSION } from '../contract';

const CERAMIC_CATEGORIES = [
  'kubki', 'wazony', 'wazony-srednie', 'wazony-duze', 'talerzyki',
  'talerze-srednie', 'talerze-duze', 'duze-michy', 'miski-falowane',
] as const;

export const capabilitiesRoute: RouteDef = {
  method: 'GET',
  path: '/v1/capabilities',
  handler: async () => {
    return jsonResponse({
      contractVersion: CMS_API_CONTRACT_VERSION,
      productTypes: ['ceramic', 'print'],
      productStatuses: ['draft', 'active', 'hidden', 'archived'],
      ceramicCategories: CERAMIC_CATEGORIES,
      printSizes: ['30x40', '50x70', '70x100'],
      printFrameColours: ['black', 'natural', 'brown'],
      printMountAvailable: true,
      maxUploadBytes: 104_857_600,
      maxMegapixels: 160,
      currencies: ['pln', 'eur', 'gbp'],
    });
  },
};
