import { describe, expect, it } from 'vitest';
import { createGuardrails, generateSync, verifySync } from 'otplib';

describe('OTP legacy secret compatibility', () => {
  it('accepts existing otplib v12 authenticator secrets after the v13 upgrade', () => {
    const legacyV12Secret = 'N4IDGEZJPNYEIRKF';
    const legacyGuardrails = createGuardrails({ MIN_SECRET_BYTES: 10 });
    const token = generateSync({
      secret: legacyV12Secret,
      guardrails: legacyGuardrails
    });

    const result = verifySync({
      secret: legacyV12Secret,
      token,
      epochTolerance: 30,
      guardrails: legacyGuardrails
    });

    expect(result.valid).toBe(true);
  });
});
