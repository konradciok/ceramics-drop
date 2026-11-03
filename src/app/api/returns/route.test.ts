import { describe,expect,it,vi } from 'vitest';
const sideEffects=vi.hoisted(()=>({shipment:vi.fn(),db:vi.fn(),email:vi.fn()}));
vi.mock('@/lib/inpost',()=>({getInPost:sideEffects.shipment}));
vi.mock('@/lib/supabase',()=>({getSupabaseAdmin:sideEffects.db}));
vi.mock('@/lib/email',()=>({emailReturnLabel:sideEffects.email}));
import {POST} from './route';

describe('retired return-label endpoint',()=>{
  it('provides studio instructions without requiring account access or creating a label',async()=>{
    const response=await POST();
    expect(response.status).toBe(410);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({error:'return_labels_retired',contact:'ania@ciok.art',account_required:false,return_address:{streetAddress:'San Pedro Abajo 12',addressCountry:'ES'}});
    expect(sideEffects.shipment).not.toHaveBeenCalled();
    expect(sideEffects.db).not.toHaveBeenCalled();
    expect(sideEffects.email).not.toHaveBeenCalled();
  });
});
