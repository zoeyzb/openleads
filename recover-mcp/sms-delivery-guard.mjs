export function isCarrierRegistrationError(errorCodes = []) {
  return errorCodes.some((code) => String(code || "").trim() === "40010");
}

export function bulkSmsBlockReason({
  configuredPause = false,
  registrationApproved = false,
  carrierBlocked = false,
} = {}) {
  if (configuredPause) return "configured_pause";
  if (!registrationApproved) return "10dlc_not_approved";
  if (carrierBlocked) return "carrier_registration_blocked";
  return "";
}

export function reachabilityForLookupDecision(decision = "") {
  const normalized = String(decision || "").trim().toUpperCase();
  return ["SEND", "SKIP"].includes(normalized) ? normalized : "CHECK";
}
