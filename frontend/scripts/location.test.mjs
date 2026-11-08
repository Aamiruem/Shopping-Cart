// Run with: npm test (from frontend/). Pincode lookup and delivery estimates in api/_location.mjs, with India Post
// replaced by a stand-in so the tests never depend on the network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deliveryDays, lookupPincode, PINCODE_RE } from '../../api/_location.mjs';

const indiaPost = (body, ok = true) => async () => ({ ok, status: ok ? 200 : 503, json: async () => body });

test('only real-looking 6-digit pincodes are accepted', () => {
  assert.ok(PINCODE_RE.test('560001'));
  for (const bad of ['060001', '56001', '5600011', 'abcdef', '']) assert.ok(!PINCODE_RE.test(bad), bad);
});

test('delivery estimate gets shorter the closer the pincode is to the warehouse', () => {
  assert.deepEqual(deliveryDays('560034', '560001'), { min: 1, max: 2 }); // same area
  assert.deepEqual(deliveryDays('570001', '560001'), { min: 2, max: 4 }); // same region
  assert.deepEqual(deliveryDays('110001', '560001'), { min: 4, max: 7 }); // across India
  assert.deepEqual(deliveryDays('110001', ''), { min: 3, max: 7 }); // no warehouse set
});

test('a found pincode gives the town, state, areas and whether it is deliverable', async () => {
  const place = await lookupPincode('560001', indiaPost([{ Status: 'Success', PostOffice: [
    { Name: 'Museum Road', District: 'Bangalore ', State: 'Karnataka', DeliveryStatus: 'Non-Delivery' },
    { Name: 'Bangalore GPO', District: 'Bangalore', State: 'Karnataka', DeliveryStatus: 'Delivery' },
  ] }]));
  assert.deepEqual([place.found, place.city, place.state, place.deliverable], [true, 'Bangalore', 'Karnataka', true]);
  assert.deepEqual(place.areas, ['Bangalore GPO', 'Museum Road']);
  assert.ok(place.days.max >= place.days.min);
});

test('an unknown pincode says so', async () => {
  const place = await lookupPincode('999999', indiaPost([{ Status: 'Error', PostOffice: null }]));
  assert.equal(place.found, false);
});

test('if India Post is down, shopping carries on with "unknown"', async () => {
  for (const broken of [indiaPost(null, false), async () => { throw new Error('network down'); }, indiaPost('not json')]) {
    const place = await lookupPincode('560001', broken);
    assert.equal(place.found, null);
    assert.ok(place.days);
  }
});
