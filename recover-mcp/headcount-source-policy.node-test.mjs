import assert from "node:assert/strict";
import { isFirmSpecificDirectoryHeadcountUrl } from "./headcount-source-policy.mjs";

assert.equal(
  isFirmSpecificDirectoryHeadcountUrl("https://www.justia.com/lawyers/ohio/bowling-green"),
  false,
  "Justia city-directory pages list unrelated attorneys and cannot prove one firm's headcount"
);

assert.equal(
  isFirmSpecificDirectoryHeadcountUrl("https://lawyers.justia.com/lawyer/jane-doe-1234567"),
  true,
  "Justia individual lawyer profiles are identity-specific sources"
);

assert.equal(
  isFirmSpecificDirectoryHeadcountUrl("https://www.lawyer.com/firm/example-law-firm.html"),
  true,
  "Lawyer.com firm profiles remain allowed"
);

console.log("headcount source policy tests passed");
