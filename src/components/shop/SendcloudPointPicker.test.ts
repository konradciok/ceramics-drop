import { describe, expect, it, vi } from 'vitest';
import { closePickerOverlay } from './SendcloudPointPicker';

describe('closePickerOverlay', () => {
  it('closes an open overlay', () => {
    const close = vi.fn();
    closePickerOverlay({ close });
    expect(close).toHaveBeenCalledOnce();
  });

  it("swallows the SDK's TypeError when there is no overlay element", () => {
    // What embed.sendcloud.sc's removeServicePointPicker throws when nothing
    // is open — it used to escape an effect cleanup and unmount the cart.
    const close = vi.fn(() => {
      throw new TypeError("Cannot read properties of null (reading 'remove')");
    });
    expect(() => closePickerOverlay({ close })).not.toThrow();
  });

  it('is a no-op when the SDK never loaded', () => {
    expect(() => closePickerOverlay(undefined)).not.toThrow();
  });
});
