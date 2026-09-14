const LEADSTORE_KEY = "recover:leadstore:qualified";

function hasEmail(lead) {
  if (Array.isArray(lead?.emails)) return lead.emails.some(value => String(value ?? "").trim());
  return Boolean(String(lead?.email ?? lead?.emails ?? "").trim());
}

export function summarizeLeadValues(values, qualifiedTotal = values.length) {
  let parsedRecords = 0;
  let invalidRecords = 0;
  let noWebsite = 0;
  let withPhone = 0;
  let withEmail = 0;
  let contactable = 0;

  for (const value of values) {
    let lead;
    try {
      lead = typeof value === "string" ? JSON.parse(value) : value;
    } catch {
      invalidRecords += 1;
      continue;
    }
    if (!lead || typeof lead !== "object") {
      invalidRecords += 1;
      continue;
    }

    parsedRecords += 1;
    const phone = Boolean(String(lead.phone ?? "").trim());
    const email = hasEmail(lead);
    const websiteMissing = !String(lead.website ?? "").trim();

    if (websiteMissing) noWebsite += 1;
    if (phone) withPhone += 1;
    if (email) withEmail += 1;
    if (phone || email) contactable += 1;
  }

  return {
    qualified_total: Number(qualifiedTotal) || 0,
    parsed_records: parsedRecords,
    invalid_records: invalidRecords,
    no_website: noWebsite,
    with_phone: withPhone,
    with_email: withEmail,
    contactable
  };
}

export async function readLeadstoreStats(redis) {
  const [qualifiedTotal, values] = await Promise.all([
    redis.hLen(LEADSTORE_KEY),
    redis.hVals(LEADSTORE_KEY)
  ]);
  return summarizeLeadValues(values, qualifiedTotal);
}

export { LEADSTORE_KEY };
