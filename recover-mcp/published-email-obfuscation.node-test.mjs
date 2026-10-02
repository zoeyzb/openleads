import assert from "node:assert/strict";
import { decodePublishedRot13Emails } from "./published-email-obfuscation.mjs";

assert.equal(
  decodePublishedRot13Emails("Contact: grfg@tznvy.pbz"),
  "Contact: test@gmail.com",
  "ROT13-obfuscated published email should be decoded when the decoded domain has a normal public TLD"
);

assert.equal(
  decodePublishedRot13Emails("Normal: jane@example.com"),
  "Normal: jane@example.com",
  "normal published emails must not be altered"
);

assert.equal(
  decodePublishedRot13Emails("Text with no email"),
  "Text with no email"
);

console.log("published email obfuscation tests passed");
