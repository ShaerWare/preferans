import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { validateInitData } from '../server/telegram.js';

const TOKEN = '123456:TEST';

function sign(fields) {
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const fields = () => ({
  auth_date: String(Math.floor(Date.now() / 1000)),
  start_param: 'abc',
  user: JSON.stringify({ id: 42, first_name: 'Иван', last_name: 'Петров' }),
});

test('принимает подпись Telegram', () => {
  const r = validateInitData(sign(fields()), TOKEN);
  assert.deepEqual(r.user, { id: '42', name: 'Иван Петров', photo: null });
  assert.equal(r.startParam, 'abc');
});

test('отклоняет подделку и старые данные', () => {
  const forged = sign(fields()).replace('abc', 'xyz');
  assert.equal(validateInitData(forged, TOKEN), null);
  assert.equal(validateInitData(sign(fields()), '999:OTHER'), null);
  assert.equal(validateInitData(sign({ ...fields(), auth_date: '1000' }), TOKEN), null);
});
