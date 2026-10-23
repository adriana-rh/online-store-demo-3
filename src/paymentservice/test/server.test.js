// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const grpc = require('@grpc/grpc-js');

const HipsterShopServer = require('../server');

const PROTO_ROOT = path.join(__dirname, '..', 'proto');
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NEXT_YEAR = new Date().getFullYear() + 1;

function chargeRequest (cardOverrides = {}) {
  return {
    amount: { currency_code: 'USD', units: 42, nanos: 0 },
    credit_card: {
      credit_card_number: '4111111111111111',
      credit_card_cvv: 123,
      credit_card_expiration_year: NEXT_YEAR,
      credit_card_expiration_month: 1,
      ...cardOverrides
    }
  };
}

function callHandler (handler, request) {
  return new Promise((resolve) => {
    handler({ request }, (err, response) => resolve({ err, response }));
  });
}

describe('HipsterShopServer handlers', () => {
  it('ChargeServiceHandler returns a transaction id for a valid card', async () => {
    const { err, response } = await callHandler(HipsterShopServer.ChargeServiceHandler, chargeRequest());
    assert.equal(err, null);
    assert.match(response.transaction_id, UUID_V4);
  });

  it('ChargeServiceHandler passes card errors to the callback', async (t) => {
    t.mock.method(console, 'warn', () => {});
    const { err, response } = await callHandler(HipsterShopServer.ChargeServiceHandler,
      chargeRequest({ credit_card_number: '378282246310005' }));
    assert.equal(response, undefined);
    assert.equal(err.code, grpc.status.INVALID_ARGUMENT);
    assert.match(err.message, /cannot process amex/);
  });

  it('CheckHandler reports SERVING', async () => {
    const { err, response } = await callHandler(HipsterShopServer.CheckHandler, {});
    assert.equal(err, null);
    assert.deepEqual(response, { status: 'SERVING' });
  });
});

describe('HipsterShopServer over gRPC', () => {
  let server;
  let paymentClient;
  let healthClient;

  before(async () => {
    server = new HipsterShopServer(PROTO_ROOT, 0);
    const port = await new Promise((resolve, reject) => {
      server.server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(),
        (err, boundPort) => (err ? reject(err) : resolve(boundPort)));
    });
    const address = `127.0.0.1:${port}`;
    const { PaymentService } = server.packages.hipsterShop.hipstershop;
    const { Health } = server.packages.health.grpc.health.v1;
    paymentClient = new PaymentService(address, grpc.credentials.createInsecure());
    healthClient = new Health(address, grpc.credentials.createInsecure());
  });

  after(() => {
    paymentClient.close();
    healthClient.close();
    server.server.forceShutdown();
  });

  function charge (request) {
    return new Promise((resolve) => {
      paymentClient.charge(request, (err, response) => resolve({ err, response }));
    });
  }

  it('charges a valid card', async () => {
    const { err, response } = await charge(chargeRequest());
    assert.equal(err, null);
    assert.match(response.transaction_id, UUID_V4);
  });

  const invalidRequests = [
    ['an unaccepted card type', chargeRequest({ credit_card_number: '378282246310005' }),
      'Sorry, we cannot process amex credit cards. Only VISA or MasterCard is accepted.'],
    ['an invalid card number', chargeRequest({ credit_card_number: '4111111111111112' }),
      'Credit card info is invalid'],
    ['an empty card number', chargeRequest({ credit_card_number: '' }),
      'Credit card info is invalid'],
    ['an expired card', chargeRequest({ credit_card_expiration_year: NEXT_YEAR - 2 }),
      `Your credit card (ending 1111) expired on 1/${NEXT_YEAR - 2}`],
    ['an invalid expiration month', chargeRequest({ credit_card_expiration_month: 13 }),
      'Credit card info is invalid'],
    ['no credit card', { amount: { currency_code: 'USD', units: 1, nanos: 0 } },
      'Credit card info is invalid'],
    ['no amount', { credit_card: chargeRequest().credit_card },
      'Charge amount is missing']
  ];

  for (const [name, request, details] of invalidRequests) {
    it(`returns INVALID_ARGUMENT for ${name}`, async (t) => {
      t.mock.method(console, 'warn', () => {});
      const { err, response } = await charge(request);
      assert.equal(response, undefined);
      assert.equal(err.code, grpc.status.INVALID_ARGUMENT);
      assert.equal(err.details, details);
    });
  }

  it('answers health checks', async () => {
    const response = await new Promise((resolve, reject) => {
      healthClient.check({ service: '' }, (err, res) => (err ? reject(err) : resolve(res)));
    });
    assert.equal(response.status, 'SERVING');
  });
});
