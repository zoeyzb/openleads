import assert from "node:assert/strict";
import { isTexasBarProfileUrl } from "./texas-bar-profile.mjs";

assert.equal(isTexasBarProfileUrl("https://www.texasbar.com/attorneys/member.cfm?id=176781"),true);
assert.equal(isTexasBarProfileUrl("https://www.texasbar.com/AM/Template.cfm?Section=Find_A_Lawyer&template=/Customsource/MemberDirectory/MemberDirectoryDetail.cfm&ContactID=123456"),true);
assert.equal(isTexasBarProfileUrl("https://www.texasbar.com/attorneys/"),false);
assert.equal(isTexasBarProfileUrl("https://example.com/attorneys/member.cfm?id=176781"),false);

console.log("Texas Bar profile URL tests passed");
