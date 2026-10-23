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

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const grpc = require('@grpc/grpc-js');

const charge = require('../charge');

const VISA = '4111111111111111';
const MASTERCARD = '5555555555554444';
const AMEX = '378282246310005';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const now = new Date();
const CURRENT_YEAR = now.getFullYear();
const CURRENT_MONTH = now.getMonth() + 1;

function request (cardOverrides = {}, amount = { currency_code: 'USD', units: 10, nanos: 500000000 }) {
  return {
    amount,
    credit_card: {
      credit_card_number: VISA,
      credit_card_cvv: 123,
      credit_card_expiration_year: CURRENT_YEAR + 1,
      credit_card_expiration_month: CURRENT_MONTH,
      ...cardOverrides
    }
  };
}

function assertInvalidArgument (fn, message) {
  assert.throws(fn, (err) => {
    assert.equal(err.code, grpc.status.INVALID_ARGUMENT);
    if (message instanceof RegExp) {
      assert.match(err.message, message);
    } else {
      assert.equal(err.message, message);
    }
    return true;
  });
}

describe('charge', () => {
  describe('accepted cards', () => {
    it('charges a valid VISA card', () => {
      const res = charge(request({ credit_card_number: VISA }));
      assert.match(res.transaction_id, UUID_V4);
    });

    it('charges a valid MasterCard', () => {
      const res = charge(request({ credit_card_number: MASTERCARD }));
      assert.match(res.transaction_id, UUID_V4);
    });

    it('accepts card numbers formatted with dashes', () => {
      const res = charge(request({ credit_card_number: '4111-1111-1111-1111' }));
      assert.match(res.transaction_id, UUID_V4);
    });

    it('returns a unique transaction id per charge', () => {
      const ids = new Set(Array.from({ length: 20 }, () => charge(request()).transaction_id));
      assert.equal(ids.size, 20);
    });

    it('accepts a card expiring this month', () => {
      const res = charge(request({
        credit_card_expiration_year: CURRENT_YEAR,
        credit_card_expiration_month: CURRENT_MONTH
      }));
      assert.match(res.transaction_id, UUID_V4);
    });

    it('accepts a card expiring in December of the current year', () => {
      const res = charge(request({
        credit_card_expiration_year: CURRENT_YEAR,
        credit_card_expiration_month: 12
      }));
      assert.match(res.transaction_id, UUID_V4);
    });

    it('accepts 64-bit amounts serialized as strings', () => {
      const res = charge(request({}, { currency_code: 'EUR', units: '9007199254740993', nanos: 0 }));
      assert.match(res.transaction_id, UUID_V4);
    });
  });

  describe('invalid cards', () => {
    it('rejects a number that fails the Luhn check', () => {
      assertInvalidArgument(() => charge(request({ credit_card_number: '4111111111111112' })),
        'Credit card info is invalid');
    });

    it('rejects a number that is too short', () => {
      assertInvalidArgument(() => charge(request({ credit_card_number: '4111' })),
        'Credit card info is invalid');
    });

    it('rejects a non-numeric number', () => {
      assertInvalidArgument(() => charge(request({ credit_card_number: 'not-a-card' })),
        'Credit card info is invalid');
    });

    it('rejects an empty number', () => {
      assertInvalidArgument(() => charge(request({ credit_card_number: '' })),
        'Credit card info is invalid');
    });

    it('rejects a missing number', () => {
      assertInvalidArgument(() => charge(request({ credit_card_number: undefined })),
        'Credit card info is invalid');
    });

    it('rejects a request without credit card info', () => {
      assertInvalidArgument(() => charge({ amount: { currency_code: 'USD', units: 1, nanos: 0 }, credit_card: null }),
        'Credit card info is invalid');
    });

    for (const month of [0, 13, -1]) {
      it(`rejects expiration month ${month}`, () => {
        assertInvalidArgument(() => charge(request({
          credit_card_expiration_year: CURRENT_YEAR + 1,
          credit_card_expiration_month: month
        })), 'Credit card info is invalid');
      });
    }

    it('rejects month 13 of last year instead of treating it as January', () => {
      assertInvalidArgument(() => charge(request({
        credit_card_expiration_year: CURRENT_YEAR - 1,
        credit_card_expiration_month: 13
      })), 'Credit card info is invalid');
    });
  });

  describe('missing amount', () => {
    it('rejects a valid card when the amount is missing', () => {
      assertInvalidArgument(() => charge(request({}, null)), 'Charge amount is missing');
    });
  });

  describe('unaccepted cards', () => {
    it('rejects AMEX', () => {
      assertInvalidArgument(() => charge(request({ credit_card_number: AMEX })),
        'Sorry, we cannot process amex credit cards. Only VISA or MasterCard is accepted.');
    });
  });

  describe('expired cards', () => {
    it('rejects a card that expired last year', () => {
      assertInvalidArgument(() => charge(request({
        credit_card_expiration_year: CURRENT_YEAR - 1,
        credit_card_expiration_month: 12
      })), `Your credit card (ending 1111) expired on 12/${CURRENT_YEAR - 1}`);
    });

    it('rejects a card that expired last month', () => {
      const year = CURRENT_MONTH === 1 ? CURRENT_YEAR - 1 : CURRENT_YEAR;
      const month = CURRENT_MONTH === 1 ? 12 : CURRENT_MONTH - 1;
      assertInvalidArgument(() => charge(request({
        credit_card_expiration_year: year,
        credit_card_expiration_month: month
      })), `Your credit card (ending 1111) expired on ${month}/${year}`);
    });

    it('reports the last four digits of a dashed card number', () => {
      assertInvalidArgument(() => charge(request({
        credit_card_number: '5555-5555-5555-4444',
        credit_card_expiration_year: CURRENT_YEAR - 1,
        credit_card_expiration_month: 1
      })), /ending 4444\)/);
    });

    it('rejects a card with no expiration date', () => {
      assertInvalidArgument(() => charge(request({
        credit_card_expiration_year: 0,
        credit_card_expiration_month: 0
      })), /Credit card info is invalid|expired/);
    });
  });

  describe('validation order', () => {
    it('reports an invalid number before the card type', () => {
      assertInvalidArgument(() => charge(request({ credit_card_number: '378282246310006' })),
        'Credit card info is invalid');
    });

    it('reports an unaccepted card type before expiry', () => {
      assertInvalidArgument(() => charge(request({
        credit_card_number: AMEX,
        credit_card_expiration_year: CURRENT_YEAR - 1
      })), /cannot process amex/);
    });
  });
});
