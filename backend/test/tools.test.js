import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTool } from '../src/tools.js';

const items = [
  { id: 'a', name: 'Headphones One', price: 100, currency: 'CAD', site: 'Store A' },
  { id: 'b', name: 'Headphones Two', price: 80, currency: 'CAD', site: 'Store B' },
  { id: 'c', name: 'Mystery Item', price: null, currency: 'CAD', site: 'Store A' }
];

test('compare_items identifies price range', () => {
  const result = executeTool('compare_items', {}, items);
  assert.equal(result.count, 3);
  assert.equal(result.priceRange.min.value, 80);
  assert.equal(result.priceRange.max.value, 100);
});

test('organize_items groups by store', () => {
  const result = executeTool('organize_items', { strategy: 'store' }, items);
  assert.deepEqual(result.groups['Store A'], ['a', 'c']);
  assert.deepEqual(result.groups['Store B'], ['b']);
});
