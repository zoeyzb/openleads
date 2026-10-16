# Law source qualification — October 16, 2026

## Results from direct Mac source probes
- 9,037 historical source identities (Florida and New York) remain research records, not firmwide-qualified prospects.
- Indiana State Bar public profile probe: 12 requests, 4 readable, 8 HTTP 403; 2 profiles had source-published 2–10 firm/organization size and a business phone, but **both had independently confirmed owned websites** and were excluded from no-website outreach.
- Verified owned-site exclusions: `Rice & Rice, Attorneys at Law, LLC` (`https://www.riceandrice.com/`, supported by matching BBB business profile) and `Adler Attorneys` (`https://www.noblesville-attorney.com/`, 317-773-1974 printed on its website).
- Two-source website search preflight on the Mac remained degraded (0 responsive providers). Never treat an empty or blocked search response as proof of no owned website.
- Retained the existing qualification gates: verified firmwide 2–10 attorneys, business name/phone match, trustworthy independent no-owned-site checks. Email is optional for calling, not for email-specific exports.

## Implemented changes
- Strong published-size sources (`inbar.org`) are processed before Florida-only registered-attorney hints; `pending()` order is deterministic.
- Generic placeholders, obvious non-law employers, and public/government offices no longer consume scarce archive import slots. This only improves staging; it does not promote contacts into qualified output.
- New optional `law_local.structured_search.brave_search` structured API adapter with explicit `BRAVE_SEARCH_API_KEY` opt-in. It replaces the broken Bing leg and still requires a separately functioning provider for absence verification. Network, quota, malformed JSON, and missing-key cases fail closed; code and tests do not contain the key.
- The configured Brave Search API is metered and has a documented $5/month credit allowance at $5/1,000 requests as of October 16; do not assume the user has an account or unlimited free requests.

## Remaining blocking requirements
- No Brave API key present in the current Mac process environment, and DuckDuckGo HTML blocks/does not consistently parse. Code integration is verified in tests, not live website-absence verification.
- A structured search API cannot prove *nonexistence* of a site by itself; negative evidence must be corroborated. The absence classification should remain a conservative screening conclusion, not an absolute guarantee.
- Indiana Bar profile size ranges are self-reported and are not a verified nationwide roster for every firm. Validate with independent firm-specific evidence before sales eligibility.
- The 1,000 firm target cannot be represented as achieved while the genuinely sourced no-website-qualified count is zero. Consider expanding the target to firms with poor websites only if the offer/eligibility requirements change explicitly.
