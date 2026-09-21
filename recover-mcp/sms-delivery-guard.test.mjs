import test from "node:test";
import assert from "node:assert/strict";

import {
  bulkSmsBlockReason,
  isCarrierRegistrationError,
  reachabilityForLookupDecision,
} from "./sms-delivery-guard.mjs";

test("blocks a bulk campaign until 10DLC approval is explicitly enabled", () => {
  assert.equal(
    bulkSmsBlockReason({ configuredPause: false, registrationApproved: false, carrierBlocked: false }),
    "10dlc_not_approved",
  );
});

test("carrier registration error 40010 trips the bulk-send circuit breaker", () => {
  assert.equal(isCarrierRegistrationError(["40010"]), true);
  assert.equal(
    bulkSmsBlockReason({ configuredPause: false, registrationApproved: true, carrierBlocked: true }),
    "carrier_registration_blocked",
  );
});

test("ambiguous lookup failures remain CHECK instead of being mislabeled SKIP", () => {
  assert.equal(reachabilityForLookupDecision("CHECK"), "CHECK");
  assert.equal(reachabilityForLookupDecision("SKIP"), "SKIP");
  assert.equal(reachabilityForLookupDecision("SEND"), "SEND");
});
