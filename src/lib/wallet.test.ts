import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUnknownChain } from './wallet';

test('a wallet that has never heard of the network is recognised in every shape seen', () => {
  // MetaMask extension.
  assert.equal(isUnknownChain({ code: 4902, message: 'Unrecognized chain ID "0x279f".' }), true);
  // Wrapped, with the original underneath.
  assert.equal(isUnknownChain({ code: -32603, data: { originalError: { code: 4902 } } }), true);
  assert.equal(isUnknownChain({ code: -32603, cause: { code: 4902 } }), true);
  // Wrapped with no code anywhere, only the sentence.
  assert.equal(
    isUnknownChain({ code: -32603, message: 'Unrecognized chain ID "0x279f". Try adding the chain using wallet_addEthereumChain first.' }),
    true,
  );
  assert.equal(isUnknownChain({ code: -32603, data: { message: 'Chain 0x279f has not been added' } }), true);
});

test('a refusal is not mistaken for a missing network', () => {
  // Adding the network after the player said no would put a second prompt in
  // front of somebody who has just declined the first.
  assert.equal(isUnknownChain({ code: 4001, message: 'User rejected the request.' }), false);
  assert.equal(isUnknownChain({ code: -32603, message: 'Internal JSON-RPC error.' }), false);
  assert.equal(isUnknownChain(new Error('network timeout')), false);
  assert.equal(isUnknownChain(null), false);
});

test('an error that refers to itself does not hang the check', () => {
  const loop: { code: number; cause?: unknown } = { code: -32603 };
  loop.cause = loop;
  assert.equal(isUnknownChain(loop), false);
});
