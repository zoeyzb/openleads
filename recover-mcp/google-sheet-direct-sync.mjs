import { createSign } from "node:crypto";
import { mergeLeadRecords } from "./acquisition-persistence.mjs";
import { campaignLeadSetKey } from "./acquisition-coverage.mjs";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const ASSIGN_HASH = "recover:sheet:assigned:v1";
const COUNT_HASH = "recover:sheet:counts:v1";
const EMAIL_SYNC_HASH = "recover:sheet:email-synced:v2";
const SHEET_RESTORE_CURSOR_HASH = "recover:sheet:leadstore-restore:v1";
const SHEET_RESTORE_BATCH_ROWS = Math.max(500, Math.min(10000, Number(process.env.SHEET_RESTORE_BATCH_ROWS || 5000)));
const RESTORE_PROFILE = {
  industry: "HVAC",
  require_no_website: true,
  require_contact: true,
  require_phone: true,
  require_email: false,
  include_no_website: true,
  min_score: 30,
};

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
      const range = `${quoteTab(tabName)}!A7:Y50006`;
      await request(
        spreadsheetId,
        `/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=OVERWRITE`,
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
    const ranges = [`${quoteTab(tabName)}!A7:A50006`, `${quoteTab(tabName)}!W7:W50006`, `${quoteTab(tabName)}!X7:X50006`];
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

  async function readLeadRows(spreadsheetId, tabName, startRow, endRow) {
    if (endRow < startRow) return [];
    const range = `${quoteTab(tabName)}!A${startRow}:Y${endRow}`;
    const json = await request(
      spreadsheetId,
      `/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`
    );
    return Array.isArray(json?.values) ? json.values : [];
  }

  async function updateEmailCells(spreadsheetId, tabName, updates) {
    for (let i = 0; i < updates.length; i += 500) {
      const chunk = updates.slice(i, i + 500);
      const data = [];
      for (const { row, email, phone } of chunk) {
        data.push({
          range: `${quoteTab(tabName)}!J${row}`,
          majorDimension: "ROWS",
          values: [[email]],
        });
        data.push({
          range: `${quoteTab(tabName)}!N${row}`,
          majorDimension: "ROWS",
          values: [[phone && email ? "Phone + Email" : email ? "Email" : phone ? "Phone" : ""]],
        });
      }
      await request(spreadsheetId, "/values:batchUpdate", {
        method: "POST",
        body: { valueInputOption: "RAW", data },
      });
    }
  }

  return { appendRows, readIdentityColumns, readLeadRows, updateEmailCells };
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

function normalizeLeadText(value = "") {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function validEmails(value = "") {
  const parts = Array.isArray(value) ? value : clean(value).split(/[;,\s]+/);
  return [...new Set(parts
    .map((x) => clean(x).toLowerCase())
    .filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))];
}

function restoredLeadFromSheetRow(row = []) {
  const phone = digits(row[8]);
  const emails = validEmails(row[9]);
  const placeId = clean(row[23]);
  const website = clean(row[24]);
  return {
    name: clean(row[1]),
    owner_name: clean(row[2]),
    category: clean(row[3]),
    address: clean(row[4]),
    city: clean(row[5]),
    region: clean(row[6]),
    postal_code: clean(row[7]),
    phone,
    emails,
    google_maps_url: clean(row[10]),
    review_rating: clean(row[11]),
    review_count: clean(row[12]),
    acquisition_id: clean(row[22]),
    place_id: placeId,
    website,
    industry: "HVAC",
    campaign_scope: campaignLeadSetKey(RESTORE_PROFILE),
    source: "google_sheet_historical_restore",
    persisted_at: new Date().toISOString(),
    qualification: {
      source: "google_sheet_historical_restore",
      strict_core_home_service: true,
      no_owned_website: !website,
      contactable: Boolean(phone || emails.length),
      historical_restore: true,
    },
  };
}

function restoredLeadKey(lead = {}) {
  const placeId = clean(lead.place_id);
  if (placeId) return `place:${placeId}`;
  const address = normalizeLeadText(lead.address);
  const name = normalizeLeadText(lead.name);
  if (address && name) return `nameaddr:${normalizeLeadText(`${lead.name}|${lead.address}`)}`;
  const phone = digits(lead.phone);
  if (phone) return `phone:${phone.slice(-10)}`;
  return "";
}

async function restoreHistoricalSheetLeads({ redis, client, slots, counts }) {
  const scopeSet = campaignLeadSetKey(RESTORE_PROFILE);
  const cursors = await redis.hGetAll(SHEET_RESTORE_CURSOR_HASH);
  let scanned = 0, restored = 0, merged = 0, emailsRecovered = 0, invalid = 0;
  const progress = [];

  for (const slot of slots) {
    const total = Math.max(0, Number(counts.get(slot.key) || 0));
    if (!total) continue;

    const offset = Math.max(0, Number(cursors?.[slot.key] || 0));
    if (offset >= total) continue;

    const take = Math.min(SHEET_RESTORE_BATCH_ROWS, total - offset);
    const startRow = 7 + offset;
    const endRow = startRow + take - 1;
    const rows = await client.readLeadRows(slot.spreadsheetId, slot.tabName, startRow, endRow);
    if (!rows.length) {
      await redis.hSet(SHEET_RESTORE_CURSOR_HASH, slot.key, String(total));
      progress.push({ tab: slot.tabName, offset, total, read: 0, done: true });
      continue;
    }

    const parsed = [];
    for (const row of rows) {
      scanned++;
      const lead = restoredLeadFromSheetRow(row);
      const key = restoredLeadKey(lead);
      // Active Recover qualified sheets are phone-first/no-website inventory.
      // Do not resurrect rows that no longer satisfy the campaign's minimum
      // contactability or that have become owned-website leads.
      if (!key || !lead.name || !lead.phone || lead.website) {
        invalid++;
        continue;
      }
      parsed.push({ key, lead });
    }

    if (parsed.length) {
      const keys = parsed.map((x) => x.key);
      const existing = await redis.hmGet("recover:leadstore:qualified", keys);
      const hsetEntries = [];
      const phoneIndexEntries = [];
      const identities = [];
      for (let i = 0; i < parsed.length; i++) {
        const { key, lead } = parsed[i];
        let prior = {};
        if (existing?.[i]) {
          try { prior = JSON.parse(existing[i]) || {}; } catch {}
        }
        const beforeEmails = validEmails(prior?.emails || prior?.email || "");
        const combined = mergeLeadRecords(prior, lead);
        const afterEmails = validEmails(combined?.emails || combined?.email || "");
        if (afterEmails.length > beforeEmails.length) emailsRecovered += afterEmails.length - beforeEmails.length;
        if (existing?.[i]) merged++; else restored++;
        hsetEntries.push(key, JSON.stringify(combined));
        identities.push(key);
        const phone = digits(combined.phone).slice(-10);
        if (phone) phoneIndexEntries.push(phone, key);
      }
      if (hsetEntries.length) await redis.hSet("recover:leadstore:qualified", hsetEntries);
      if (phoneIndexEntries.length) await redis.hSet("recover:leadstore:phone-index", phoneIndexEntries);
      if (identities.length) await redis.sAdd(scopeSet, identities);
    }

    const nextOffset = Math.min(total, offset + rows.length);
    await redis.hSet(SHEET_RESTORE_CURSOR_HASH, slot.key, String(nextOffset));
    progress.push({ tab: slot.tabName, offset: nextOffset, total, read: rows.length, done: nextOffset >= total });
  }

  if (scanned || restored || merged || emailsRecovered) {
    console.log(JSON.stringify({
      event: "google_sheet_historical_restore",
      scanned, restored, merged, emailsRecovered, invalid, progress,
    }));
  }
  return { scanned, restored, merged, emailsRecovered, invalid, progress };
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
      if (identity) assignments[identity] = JSON.stringify({ key: slot.key, row: i + 7 });
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
      const emailSynced = await redis.hGetAll(EMAIL_SYNC_HASH);
      const counts = await loadCounts(redis, slots);
      const restore = await restoreHistoricalSheetLeads({ redis, client, slots, counts });
      const leads = await getQualifiedLeads(redis);
      const slotByKey = new Map(slots.map(slot => [slot.key, slot]));

      const emailUpdatesBySlot = new Map();
      const emailSyncWrites = {};
      for (const lead of leads) {
        const identity = leadIdentity(lead);
        const email = leadEmails(lead)[0] || "";
        const phone = digits(lead?.phone);
        if (!email || emailSynced?.[identity] === email || !assigned?.[identity]) continue;
        let assignment;
        try { assignment = JSON.parse(assigned[identity]); } catch { continue; }
        const slot = slotByKey.get(assignment?.key);
        const row = Number(assignment?.row || 0);
        if (!slot || row < 7) continue;
        const list = emailUpdatesBySlot.get(slot.key) || [];
        list.push({ row, email, phone });
        emailUpdatesBySlot.set(slot.key, list);
        emailSyncWrites[identity] = email;
      }

      let emailUpdated = 0;
      for (const [key, updates] of emailUpdatesBySlot) {
        const slot = slotByKey.get(key);
        if (!slot || !updates.length) continue;
        await client.updateEmailCells(slot.spreadsheetId, slot.tabName, updates);
        emailUpdated += updates.length;
      }
      if (Object.keys(emailSyncWrites).length) await redis.hSet(EMAIL_SYNC_HASH, emailSyncWrites);

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
          mapped[batch[i].identity] = JSON.stringify({ key: slot.key, row: used + i + 7 });
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
        restored_from_sheet: restore.restored,
        merged_from_sheet: restore.merged,
        emails_recovered_from_sheet: restore.emailsRecovered,
        email_updated: emailUpdated,
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
