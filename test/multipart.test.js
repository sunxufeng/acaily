import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMultipart } from '../src/server/multipart.js';

function build(parts, boundary) {
  const chunks = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    let disp = `Content-Disposition: form-data; name="${p.name}"`;
    if (p.filename) disp += `; filename="${p.filename}"`;
    chunks.push(Buffer.from(disp + '\r\n'));
    if (p.contentType) chunks.push(Buffer.from(`Content-Type: ${p.contentType}\r\n`));
    chunks.push(Buffer.from('\r\n'));
    chunks.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(String(p.data)));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

test('parseMultipart：单文本字段', () => {
  const buf = build([{ name: 'hello', data: 'world' }], '----X');
  const parts = parseMultipart(buf, '----X');
  assert.equal(parts.length, 1);
  assert.equal(parts[0].name, 'hello');
  assert.equal(parts[0].filename, '');
  assert.equal(parts[0].data.toString('utf8'), 'world');
});

test('parseMultipart：带文件名 + Content-Type', () => {
  const buf = build(
    [
      {
        name: 'file',
        filename: 'a.txt',
        contentType: 'text/plain',
        data: '中文 + ascii',
      },
    ],
    'BOUND',
  );
  const parts = parseMultipart(buf, 'BOUND');
  assert.equal(parts.length, 1);
  assert.equal(parts[0].name, 'file');
  assert.equal(parts[0].filename, 'a.txt');
  assert.equal(parts[0].contentType, 'text/plain');
  assert.equal(parts[0].data.toString('utf8'), '中文 + ascii');
});

test('parseMultipart：多字段（文本 + 文件）', () => {
  const buf = build(
    [
      { name: 'note', data: 'see attached' },
      { name: 'file', filename: 'b.bin', contentType: 'application/octet-stream', data: Buffer.from([0x00, 0x01, 0x02]) },
    ],
    'BND',
  );
  const parts = parseMultipart(buf, 'BND');
  assert.equal(parts.length, 2);
  assert.equal(parts[0].name, 'note');
  assert.equal(parts[0].data.toString('utf8'), 'see attached');
  assert.equal(parts[1].name, 'file');
  assert.deepEqual([...parts[1].data], [0x00, 0x01, 0x02]);
});

test('parseMultipart：空 body 仅终止边界', () => {
  const buf = Buffer.from(`--BND--\r\n`);
  const parts = parseMultipart(buf, 'BND');
  assert.deepEqual(parts, []);
});

test('parseMultipart：二进制文件内容原样保留', () => {
  const original = Buffer.alloc(256);
  for (let i = 0; i < 256; i++) original[i] = i;
  const buf = build([{ name: 'file', filename: 'rand.bin', contentType: 'application/octet-stream', data: original }], 'BB');
  const parts = parseMultipart(buf, 'BB');
  assert.equal(parts.length, 1);
  assert.equal(parts[0].data.length, 256);
  assert.deepEqual([...parts[0].data.subarray(0, 5)], [0, 1, 2, 3, 4]);
  assert.deepEqual([...parts[0].data.subarray(250, 256)], [250, 251, 252, 253, 254, 255]);
});