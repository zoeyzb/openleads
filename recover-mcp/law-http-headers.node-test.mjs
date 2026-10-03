import assert from "node:assert/strict";
import { researchRequestHeaders } from "./law-http-headers.mjs";

for(const url of [
  "https://www.lawyers.com/all-legal-issues/chicago/illinois/law-firms/",
  "https://www.lawyer.com/firm/example.html",
  "https://www.martindale.com/organization/example/",
  "https://lawyers.findlaw.com/profile/example",
  "https://www.justia.com/lawyers/example"
]){
  assert.match(researchRequestHeaders(url)["user-agent"],/Chrome\/154/);
}
assert.match(researchRequestHeaders("https://example.com")["user-agent"],/RecoverResearch/);

console.log("law HTTP header tests passed");
