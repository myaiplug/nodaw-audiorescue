import { describe, it, expect } from 'vitest';
import { mintTokenLogic, consumeTokenLogic } from '../functions/lib/tokens';

describe('tokens', () => {
  it('mints and consumes once', () => {
    const store = new Map<string, string>();
    const token = mintTokenLogic(store, 'upload', 'case_1', 3600);
    expect(consumeTokenLogic(store, 'upload', token)).toBe('case_1');
    expect(consumeTokenLogic(store, 'upload', token)).toBeNull();
  });
});
