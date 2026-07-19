import { describe, expect, it } from 'vitest';
import { REDACTED, redactString, redactValue } from './redact.js';

describe('redactString', () => {
  it.each([
    ['sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx', REDACTED],
    ['key is sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz ok', `key is ${REDACTED} ok`],
    ['ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', REDACTED],
    ['gho_16C7e42F292c6912E7710c838347Ae178B4a', REDACTED],
    ['github_pat_11ABCDEFG0AbCdEfGhIjKlMn_OpQrStUvWxYz', REDACTED],
    ['AKIAIOSFODNN7EXAMPLE', REDACTED],
    ['Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc', `Authorization: Bearer ${REDACTED}`],
    ['x-api-key: supersecretvalue123', `x-api-key: ${REDACTED}`],
    ['api_key=sk-live-1234567890', `api_key=${REDACTED}`],
    ['{"password": "hunter2hunter2"}', `{"password": "${REDACTED}"}`],
    ['token=abcdef123456', `token=${REDACTED}`],
    ['client_secret: z9y8x7w6v5', `client_secret: ${REDACTED}`],
  ])('redacts %s', (input, expected) => {
    expect(redactString(input)).toBe(expected);
  });

  it.each([
    'just a normal sentence about tokens and passwords',
    'the api_key field is required',
    'ask-123 is not a key',
    'use sk- for short', // too short to be a key
    'password = ?', // placeholder, not a secret
    'tokenize this string please',
    'AWS access keys look like AKIA... (docs text)',
  ])('leaves ordinary text untouched: %s', (input) => {
    expect(redactString(input)).toBe(input);
  });

  it('can be disabled', () => {
    const input = 'api_key=sk-live-1234567890';
    expect(redactString(input, { enabled: false })).toBe(input);
  });
});

describe('redactValue', () => {
  it('recurses into objects and arrays', () => {
    const input = {
      nested: { headers: ['Authorization: Bearer abcdefgh12345678', 'ok'] },
      count: 3,
      flag: true,
      nothing: null,
    };
    const out = redactValue(input);
    expect(out.nested.headers[0]).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(out.nested.headers[1]).toBe('ok');
    expect(out.count).toBe(3);
    expect(out.flag).toBe(true);
    expect(out.nothing).toBeNull();
  });

  it('does not mutate the input', () => {
    const input = { text: 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789' };
    redactValue(input);
    expect(input.text).toBe('ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
  });

  it('can be disabled', () => {
    const input = { text: 'api_key=abcdef123456' };
    expect(redactValue(input, { enabled: false })).toBe(input);
  });
});
