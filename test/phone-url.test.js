import test from 'node:test';
import assert from 'node:assert/strict';
import { phoneUrl } from '../phone-url.js';

const networks = {
  lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
  utun4: [{ family: 'IPv4', address: '10.9.0.2', internal: false }],
  en0: [{ family: 'IPv4', address: '192.168.1.23', internal: false }],
};

test('local desktop address becomes a phone-reachable Wi-Fi URL', () => {
  assert.equal(phoneUrl({ protocol: 'http', host: 'localhost:8080' }, networks), 'http://192.168.1.23:8080');
});

test('an explicit public URL takes priority over the local network', () => {
  assert.equal(phoneUrl({ protocol: 'http', host: 'localhost:8080' }, networks, 'https://feed.example.com/'), 'https://feed.example.com');
});

test('a deployed host stays the public URL', () => {
  assert.equal(phoneUrl({ protocol: 'https', host: 'feed.run.app' }, networks), 'https://feed.run.app');
});

test('without a usable network address, local URL remains visible as unavailable', () => {
  assert.equal(phoneUrl({ protocol: 'http', host: '127.0.0.1:8080' }, { lo0: networks.lo0 }), 'http://127.0.0.1:8080');
});

test('a default-port local address does not acquire an empty port suffix', () => {
  assert.equal(phoneUrl({ protocol: 'http', host: 'localhost' }, networks), 'http://192.168.1.23');
});
