import { createSign } from "node:crypto";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const ASSIGN_HASH = "recover:sheet:assigned:v1";
const COUNT_HASH = "recover:sheet:counts:v1";

const clean = (v) => String(v ?? "").trim();
const digits = (v) => clean(v).replace(/\D+/g, "");
const quoteTab = (name) => `'${String(name).replace(/'/g, "''")}'`;
const b64url = (value) => Buffer.from(value).toString("base64url");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizePrivateKey(value) {
  return String(value || "").replace(/\\n/g, "\n");
}

function parseServiceAccount(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed?.client_email || !parsed?.private_key) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseTargets(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => x?.spreadsheetId && Array.isArray(x?.tabs)) : [];
  } catch {
    return [];
  }
}

async function serviceAccountToken({ clientEmail, privateKey }) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    iss: clientEmail,
    scope: SHEETS_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${signer.sign(normalizePrivateKey(privateKey)).toString("base64url")}`;
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`google_oauth_${response.status}`);
  const json = await response.json();
  if (!json?.access_token) throw new Error("google_oauth_missing_token");
  return String(json.access_token);
}

function createSheetsClient(serviceAccount) {
  let token = "";
  let tokenAt = 0;

  async function auth() {
    if (token && Date.now() - tokenAt < 50 * 60 * 1000) return token;
    token = await serviceAccountToken({
      clientEmail: serviceAccount.client_email,
      privateKey: serviceAccount.private_key,
    });
    tokenAt = Date.now();
    return token;
  }

  async function request(spreadsheetId, path, { method = "GET", body } = {}) {
    const response = await fetch(
      `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${await auth()}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      }
    );
    if (!response.ok) {
      let detail = "";
      try { detail = JSON.stringify(await response.json()).slice(0, 500); } catch {}
      throw new Error(`google_sheets_${response.status}${detail ? `_${detail}` : ""}`);
    }
    if (response.status === 204) return {};
    return response.json();
  }

  async function appendRows(spreadsheetId, tabName, rows) {
    for (let i = 0; i < rows.length; i += 500) {
      const range = `${quoteTab(tabName)}!A:Y`;
      await request(
        spreadsheetId,
        `/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        {
          method: "POST",
          body: {
            range,
            majorDimension: "ROWS",
            values: rows.slice(i, i + 500),
          },
        }
      );
    }
  }

  async function readIdentityColumns(spreadsheetId, tabName) {
    const ranges = [`${quoteTab(tabName)}!A2:A50001`, `${quoteTab(tabName)}!W2:W50001`, `${quoteTab(tabName)}!X2:X50001`];
    const qs = new URLSearchParams();
    for (const range of ranges) qs.append("ranges", range);
    qs.set("majorDimension", "ROWS");
    const json = await request(spreadsheetId, `/values:batchGet?${qs}`);
    return {
      leadIds: json.valueRanges?.[0]?.values || [],
      acquisitionIds: json.valueRanges?.[1]?.values || [],
      placeIds: json.valueRanges?.[2]?.values || [],
    };
  }

  return { appendRows, readIdentityColumns };
}

function leadEmails(lead) {
  if (Array.isArray(lead?.emails)) return lead.emails.map(clean).filter(Boolean);
  return clean(lead?.email || lead?.emails).split(/[;,\s]+/).map(clean).filter(Boolean);
}

function leadIdentity(lead) {
  const placeId = clean(lead?.place_id);
  if (placeId) return `place:${placeId}`;
  const phone = digits(lead?.phone);
  if (phone) return `phone:${phone}`;
  const acquisitionId = clean(lead?.acquisition_id);
  const name = clean(lead?.name || lead?.title).toLowerCase();
  const address = clean(lead?.address).toLowerCase();
  return `fallback:${acquisitionId}:${name}:${address}`;
}

function sheetRow(lead) {
  const phone = digits(lead?.phone);
  const emails = leadEmails(lead);
  const email = emails[0] || "";
  const placeId = clean(lead?.place_id);
  const acquisitionId = clean(lead?.acquisition_id);
  const id = placeId ? `lead:${placeId}` : phone ? `lead:${phone}` : `lead:${acquisitionId}`;
  const contactability = phone && email ? "Phone + Email" : phone ? "Phone" : email ? "Email" : "";
  return [
    id,
    clean(lead?.name || lead?.title),
    "",
    clean(lead?.category || lead?.industry),
    clean(lead?.address),
    clean(lead?.city),
    clean(lead?.region),
    "",
    phone,
    email,
    clean(lead?.google_maps_url),
    clean(lead?.review_rating ?? lead?.rating),
    clean(lead?.review_count ?? lead?.reviews ?? 0),
    contactability,
    "New",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    acquisitionId,
    placeId,
    clean(lead?.website),
  ];
}

function targetSlots(targets) {
  const slots = [];
  for (const target of targets) {
    for (const tab of target.tabs) {
      slots.push({
        spreadsheetId: target.spreadsheetId,
        tabName: String(tab),
        key: `${target.spreadsheetId}:${tab}`,
      });
    }
  }
  return slots;
}

async function bootstrapAssignments({ redis, client, slots }) {
  const existingCount = await redis.hLen(ASSIGN_HASH);
  if (existingCount > 0) return;

  let total = 0;
  for (const slot of slots) {
    const { leadIds, acquisitionIds, placeIds } = await client.readIdentityColumns(slot.spreadsheetId, slot.tabName);
    const max = Math.max(leadIds.length, acquisitionIds.length, placeIds.length);
    let count = 0;
    const assignments = {};
    for (let i = 0; i < max; i++) {
      const leadId = clean(leadIds[i]?.[0]);
      const acq = clean(acquisitionIds[i]?.[0]);
      const place = clean(placeIds[i]?.[0]);
      if (!leadId && !acq && !place) continue;
      count += 1;
      let identity = "";
      if (place) identity = `place:${place}`;
      else {
        const phone = digits(leadId.replace(/^lead:/, ""));
        identity = phone ? `phone:${phone}` : acq ? `fallback:${acq}::` : leadId;
      }
      if (identity) assignments[identity] = JSON.stringify({ key: slot.key, row: i + 2 });
    }
    if (Object.keys(assignments).length) await redis.hSet(ASSIGN_HASH, assignments);
    await redis.hSet(COUNT_HASH, slot.key, String(count));
    total += count;
  }
  console.log(JSON.stringify({ event: "google_sheet_assignment_bootstrap", rows: total }));
}

async function loadCounts(redis, slots) {
  const raw = await redis.hGetAll(COUNT_HASH);
  const counts = new Map();
  for (const slot of slots) counts.set(slot.key, Number(raw?.[slot.key] || 0));
  return counts;
}

function nextSlot(slots, counts, capacity) {
  for (const slot of slots) {
    if ((counts.get(slot.key) || 0) < capacity) return slot;
  }
  return null;
}

export function startQualifiedGoogleSheetSync({
  getRedis,
  getQualifiedLeads,
  enabled = false,
  intervalMs = 60000,
  capacity = 50000,
  targetsJson = "",
  serviceAccountJson = "",
} = {}) {
  if (!enabled) {
    console.log(JSON.stringify({ event: "google_sheet_direct_sync_disabled" }));
    return;
  }

  const serviceAccount = parseServiceAccount(serviceAccountJson);
  const targets = parseTargets(targetsJson);
  if (!serviceAccount || !targets.length) {
    console.error(JSON.stringify({
      event: "google_sheet_direct_sync_not_configured",
      service_account: Boolean(serviceAccount),
      targets: targets.length,
    }));
    return;
  }

  const client = createSheetsClient(serviceAccount);
  const slots = targetSlots(targets);
  let running = false;

  async function syncOnce() {
    if (running) return;
    running = true;
    try {
      const redis = await getRedis();
      await bootstrapAssignments({ redis, client, slots });
      const assigned = await redis.hGetAll(ASSIGN_HASH);
      const counts = await loadCounts(redis, slots);
      const leads = await getQualifiedLeads(redis);

      const unassigned = [];
      for (const lead of leads) {
        const identity = leadIdentity(lead);
        if (!assigned?.[identity]) unassigned.push({ identity, lead });
      }

      unassigned.sort((a, b) =>
        clean(a.lead?.acquisition_location || a.lead?.address).localeCompare(clean(b.lead?.acquisition_location || b.lead?.address)) ||
        clean(a.lead?.name).localeCompare(clean(b.lead?.name))
      );

      let cursor = 0;
      const writes = [];
      while (cursor < unassigned.length) {
        const slot = nextSlot(slots, counts, capacity);
        if (!slot) break;
        const used = counts.get(slot.key) || 0;
        const take = Math.min(capacity - used, unassigned.length - cursor, 500);
        const batch = unassigned.slice(cursor, cursor + take);
        await client.appendRows(slot.spreadsheetId, slot.tabName, batch.map((x) => sheetRow(x.lead)));

        const mapped = {};
        for (let i = 0; i < batch.length; i++) {
          mapped[batch[i].identity] = JSON.stringify({ key: slot.key, row: used + i + 2 });
        }
        if (Object.keys(mapped).length) await redis.hSet(ASSIGN_HASH, mapped);
        counts.set(slot.key, used + batch.length);
        await redis.hSet(COUNT_HASH, slot.key, String(used + batch.length));
        writes.push({ tab: slot.tabName, appended: batch.length, total: used + batch.length });
        cursor += batch.length;
      }

      console.log(JSON.stringify({
        event: "google_sheet_direct_sync",
        qualified_rows: leads.length,
        unassigned: unassigned.length,
        appended: cursor,
        overflow: Math.max(0, unassigned.length - cursor),
        writes,
      }));
    } catch (error) {
      console.error("google_sheet_direct_sync_error", error?.message || error);
    } finally {
      running = false;
    }
  }

  void syncOnce();
  setInterval(() => void syncOnce(), Math.max(30000, Number(intervalMs) || 60000)).unref?.();
}
