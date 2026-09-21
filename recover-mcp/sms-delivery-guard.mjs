export function isCarrierRegistrationError(errorCodes = []) {
  return errorCodes.some((code) => String(code || "").trim() === "40010");
}

export function bulkSmsBlockReason({
  configuredPause = false,
  registrationApproved = false,
  carrierBlocked = false,
  unregisteredSendOverride = false,
} = {}) {
  if (configuredPause) return "configured_pause";
  if (unregisteredSendOverride) return "";
  if (!registrationApproved) return "10dlc_not_approved";
  if (carrierBlocked) return "carrier_registration_blocked";
  return "";
}

export function reachabilityForLookupDecision(decision = "") {
  const normalized = String(decision || "").trim().toUpperCase();
  return ["SEND", "SKIP"].includes(normalized) ? normalized : "CHECK";
}

export function shouldPostSmsResultCallback(metadata = {}) {
  return !String(metadata?.campaign_id || "").trim();
}

export function shouldResumePausedSmsBatch({ status = "", blockReason = "" } = {}) {
  return String(status || "").trim() === "paused" && !String(blockReason || "").trim();
}

export function bulkSmsOverrideStopReason({
  overrideEnabled = false,
  outboundMessages = 0,
  failureRatePercent = 0,
  cutoffPercent = 70,
} = {}) {
  if (!overrideEnabled || Number(outboundMessages) < 20) return "";
  return Number(failureRatePercent) >= Number(cutoffPercent) ? "delivery_failure_cutoff" : "";
}

export function smsDeliveryStatusBucket(status = "") {
  const normalized = String(status || "").trim().toLowerCase();
  if (/fail|undeliver|reject|expire|cancel|error|blocked/.test(normalized)) {
    return { submitted: 0, sent: 0, delivered: 0, failed: 1 };
  }
  if (normalized === "delivered") {
    return { submitted: 0, sent: 1, delivered: 1, failed: 0 };
  }
  if (normalized === "sent") {
    return { submitted: 0, sent: 1, delivered: 0, failed: 0 };
  }
  return { submitted: 1, sent: 0, delivered: 0, failed: 0 };
}
