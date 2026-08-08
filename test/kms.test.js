import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptSecret, decryptSecret } from '../src/crypto/kms.js';

process.env.ACAILY_MASTER_KEY = 'a'.repeat(64); // 32 bytes hex

test('信封加密可往返解密', () => {
  const secret = 'sk-1234567890abcdef';
  const env = encryptSecret(secret);
  assert.equal(decryptSecret(env), secret);
});

test('密文结构包含信封字段', () => {
  const env = encryptSecret('hello');
  assert.equal(env.v, 1);
  assert.ok(env.wrappedDek && env.wIv && env.wTag && env.iv && env.tag && env.ct);
  assert.equal(typeof env.ct, 'string');
});

test('相同明文两次加密结果不同（随机 IV/DEK）', () => {
  const a = encryptSecret('same');
  const b = encryptSecret('same');
  assert.notEqual(a.ct, b.ct);
  assert.equal(decryptSecret(a), 'same');
  assert.equal(decryptSecret(b), 'same');
});

test('篡改密文会被 GCM auth tag 拒绝', () => {
  const env = encryptSecret('tamper-me');
  // 翻转最后一个 base64 字符的一位
  const ct = Buffer.from(env.ct, 'base64');
  ct[ct.length - 1] ^= 0x01;
  env.ct = ct.toString('base64');
  assert.throws(() => decryptSecret(env), /auth|tag/i);
});
