import { describe, it, expect } from 'vitest';
import {
  mintTokenLogic,
  consumeTokenLogic,
  parseDownloadTokenPayload,
} from '../functions/lib/tokens';

describe('tokens', () => {
  it('mints and consumes once', () => {
    const store = new Map<string, string>();
    const token = mintTokenLogic(store, 'upload', 'case_1', 3600);
    expect(consumeTokenLogic(store, 'upload', token)).toBe('case_1');
    expect(consumeTokenLogic(store, 'upload', token)).toBeNull();
  });

  it('mints download kind separately from upload', () => {
    const store = new Map<string, string>();
    const payload = JSON.stringify({
      caseId: 'case_1',
      r2Key: 'cases/case_1/rescue.wav',
      filename: 'case_1-rescue.wav',
    });
    const token = mintTokenLogic(store, 'download', payload, 72 * 3600);
    expect(consumeTokenLogic(store, 'upload', token)).toBeNull();
    expect(parseDownloadTokenPayload(consumeTokenLogic(store, 'download', token))).toEqual({
      caseId: 'case_1',
      r2Key: 'cases/case_1/rescue.wav',
      filename: 'case_1-rescue.wav',
      ops: false,
    });
  });
});
