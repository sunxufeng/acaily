import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';

function getMasterKey() {
  const hex = process.env.ACAILY_MASTER_KEY;
  if (!hex) throw new Error('ACAILY_MASTER_KEY 未设置');
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== 32) throw new Error('ACAILY_MASTER_KEY 必须为 32 字节（64 个 hex 字符）');
  return buf;
}

// 信封加密（envelope encryption）：
//   1) 随机生成数据密钥 DEK
//   2) 用 DEK 加密明文（数据层）
//   3) 用主密钥 KEK 包裹 DEK（密钥层）
// 明文永不以明文形式落库；解密时先解开 DEK 再解数据。
export function encryptSecret(plaintext) {
  const kek = getMasterKey();
  const dek = randomBytes(32);
  const iv = randomBytes(12);

  const cipher = createCipheriv(ALGO, dek, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const wiv = randomBytes(12);
  const wCipher = createCipheriv(ALGO, kek, wiv);
  const wrappedDek = Buffer.concat([wCipher.update(dek), wCipher.final()]);
  const wAuthTag = wCipher.getAuthTag();

  return {
    v: 1,
    wrappedDek: wrappedDek.toString('base64'),
    wIv: wiv.toString('base64'),
    wTag: wAuthTag.toString('base64'),
    iv: iv.toString('base64'),
    tag: authTag.toString('base64'),
    ct: ct.toString('base64'),
  };
}

export function decryptSecret(env) {
  const kek = getMasterKey();

  const wiv = Buffer.from(env.wIv, 'base64');
  const wCipher = createDecipheriv(ALGO, kek, wiv);
  wCipher.setAuthTag(Buffer.from(env.wTag, 'base64'));
  const dek = Buffer.concat([
    wCipher.update(Buffer.from(env.wrappedDek, 'base64')),
    wCipher.final(),
  ]);

  const iv = Buffer.from(env.iv, 'base64');
  const cipher = createDecipheriv(ALGO, dek, iv);
  cipher.setAuthTag(Buffer.from(env.tag, 'base64'));
  const pt = Buffer.concat([
    cipher.update(Buffer.from(env.ct, 'base64')),
    cipher.final(),
  ]);
  return pt.toString('utf8');
}
