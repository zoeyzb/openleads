import test from "node:test";
import assert from "node:assert/strict";

import * as smsDeliveryGuard from "./sms-delivery-guard.mjs";
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

test("direct Sheet campaigns do not post results to the Revenue callback", () => {
  assert.equal(
    smsDeliveryGuard.shouldPostSmsResultCallback?.({ campaign_id: "4k-sms-f" }),
    false,
  );
});

test("Revenue-created batches keep posting results to the Revenue callback", () => {
  assert.equal(smsDeliveryGuard.shouldPostSmsResultCallback?.({}), true);
});

test("explicit override permits throttled bulk sending despite registration and historical carrier blocks", () => {
  assert.equal(
    bulkSmsBlockReason({
      configuredPause: false,
      registrationApproved: false,
      carrierBlocked: true,
      unregisteredSendOverride: true,
    }),
    "",
  );
});

test("configured pause still wins over the unregistered-send override", () => {
  assert.equal(
    bulkSmsBlockReason({
      configuredPause: true,
      registrationApproved: false,
      carrierBlocked: true,
      unregisteredSendOverride: true,
    }),
    "configured_pause",
  );
});

test("paused batch resumes only when every active gate is clear", () => {
  assert.equal(smsDeliveryGuard.shouldResumePausedSmsBatch?.({ status: "paused", blockReason: "" }), true);
  assert.equal(
    smsDeliveryGuard.shouldResumePausedSmsBatch?.({ status: "paused", blockReason: "configured_pause" }),
    false,
  );
  assert.equal(smsDeliveryGuard.shouldResumePausedSmsBatch?.({ status: "completed", blockReason: "" }), false);
});

test("override campaign stops when observed delivery failures reach its cutoff", () => {
  assert.equal(
    smsDeliveryGuard.bulkSmsOverrideStopReason?.({
      overrideEnabled: true,
      outboundMessages: 775,
      failureRatePercent: 70,
      cutoffPercent: 70,
    }),
    "delivery_failure_cutoff",
  );
  assert.equal(
    smsDeliveryGuard.bulkSmsOverrideStopReason?.({
      overrideEnabled: true,
      outboundMessages: 775,
      failureRatePercent: 69.9,
      cutoffPercent: 70,
    }),
    "",
  );
});
