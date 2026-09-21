import { createSign } from "node:crypto";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

const COL = Object.freeze({
  MESSAGE: "Z",
  CONSENT: "AA",
  ACTION: "AB",
  STATUS: "AC",
  BATCH_ID: "AD",
  PROVIDER_ID: "AE",
  UPDATED_AT: "AF",
  ERROR: "AG",
});

const clean = (v) => String(v ?? "").trim();
const quoteTab = (name) => "'" + String(name).replace(/'/g, "''") + "'";
const b64url = (value) => Buffer.from(value).toString("base64url");

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

async function serviceAccountToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: SHEETS_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${signer.sign(normalizePrivateKey(serviceAccount.private_key)).toString("base64url")}`;
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`google_oauth_${response.status}`);
  const json = await response.json();
  if (!json?.access_token) throw new Error("google_oauth_missing_token");
  return String(json.access_token);
}

function truthyConsent(value) {
  return /^(true|yes|y|1|consented|opted[ -]?in)$/i.test(clean(value));
}

function readyAction(value) {
  return /^(ready|prepare)$/i.test(clean(value));
}

export function smsSheetSchema() {
  return {
    first_data_row: 7,
    headers: {
      Z: "SMS Message",
      AA: "SMS Consent",
      AB: "SMS Action",
      AC: "SMS Status",
      AD: "SMS Batch ID",
      AE: "Telnyx Message ID",
      AF: "SMS Updated At",
      AG: "SMS Error",
    },
    action_values: ["READY", "PREPARE"],
    consent_values: ["YES", "TRUE", "CONSENTED"],
  };
}

export function createSmsSheetBridge({ serviceAccountJson = "", targetsJson = "" } = {}) {
  const serviceAccount = parseServiceAccount(serviceAccountJson);
  const targets = parseTargets(targetsJson);
  const allowed = new Set();
  for (const target of targets) {
    for (const tab of target.tabs || []) allowed.add(`${target.spreadsheetId}:${tab}`);
  }
  let token = "";
  let tokenAt = 0;
  let basicStatusColumnsPromise = null;

  async function auth() {
    if (!serviceAccount) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not configured");
    if (token && Date.now() - tokenAt < 50 * 60 * 1000) return token;
    token = await serviceAccountToken(serviceAccount);
    tokenAt = Date.now();
    return token;
  }

  function assertAllowed(spreadsheetId, tabName) {
    if (!allowed.has(`${spreadsheetId}:${tabName}`)) {
      throw new Error("SMS sheet target is not in GOOGLE_SHEETS_TARGETS_JSON");
    }
  }

  async function request(spreadsheetId, path, { method = "GET", body } = {}) {
    const response = await fetch(`${SHEETS_API}/${encodeURIComponent(spreadsheetId)}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await auth()}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const text = await response.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!response.ok) throw new Error(`google_sheets_${response.status}_${JSON.stringify(json).slice(0,500)}`);
    return json;
  }

  async function readRows({ spreadsheetId, tabName, startRow, endRow }) {
    assertAllowed(spreadsheetId, tabName);
    const start = Math.max(7, Number(startRow || 7));
    const end = Math.max(start, Number(endRow || start));
    if (end - start + 1 > 5000) throw new Error("SMS sheet range may contain at most 5000 rows");

    const ranges = [
      `${quoteTab(tabName)}!A${start}:A${end}`,
      `${quoteTab(tabName)}!B${start}:B${end}`,
      `${quoteTab(tabName)}!I${start}:I${end}`,
      `${quoteTab(tabName)}!Z${start}:AB${end}`,
    ];
    const qs = new URLSearchParams();
    for (const range of ranges) qs.append("ranges", range);
    qs.set("majorDimension", "ROWS");
    const json = await request(spreadsheetId, `/values:batchGet?${qs}`);
    const vr = json.valueRanges || [];
    const a = vr[0]?.values || [];
    const b = vr[1]?.values || [];
    const i = vr[2]?.values || [];
    const sms = vr[3]?.values || [];
    const count = end - start + 1;
    const rows = [];
    for (let offset = 0; offset < count; offset++) {
      const rowNumber = start + offset;
      const message = clean(sms[offset]?.[0]);
      const consentRaw = clean(sms[offset]?.[1]);
      const action = clean(sms[offset]?.[2]);
      if (!message && !action && !consentRaw) continue;
      rows.push({
        row: rowNumber,
        lead_id: clean(a[offset]?.[0]),
        business_name: clean(b[offset]?.[0]),
        phone: clean(i[offset]?.[0]),
        message,
        consent: truthyConsent(consentRaw),
        consent_raw: consentRaw,
        action,
        ready: readyAction(action),
      });
    }
    return rows;
  }

  async function readBasicRows({ spreadsheetId, tabName, startRow, endRow }) {
    const start = Math.max(1, Number(startRow || 1));
    const end = Math.max(start, Number(endRow || start));
    if (end - start + 1 > 5000) throw new Error("SMS basic range may contain at most 5000 rows");
    const range = `${quoteTab(tabName)}!A${start}:E${end}`;
    const json = await request(spreadsheetId, `/values/${encodeURIComponent(range)}?majorDimension=ROWS`);
    const values = json.values || [];
    const rows = [];
    for (let offset = 0; offset < end - start + 1; offset++) {
      const value = values[offset] || [];
      rows.push({
        row: start + offset,
        phone: clean(value[0]),
        message: clean(value[1]),
        business_name: clean(value[2]),
        helper: clean(value[3]),
        link: clean(value[4]),
      });
    }
    return rows;
  }

  async function resolveBasicStatusColumns(spreadsheetId, tabName) {
    if (!basicStatusColumnsPromise) {
      basicStatusColumnsPromise = (async () => {
        const range = `${quoteTab(tabName)}!A1:Z2`;
        const json = await request(spreadsheetId, `/values/${encodeURIComponent(range)}?majorDimension=ROWS`);
        const header = (json.values?.[0] || []).map(clean);
        const linkIndex = header.findIndex((value) => /^link$/i.test(value));
        const statusIndex = linkIndex >= 0 ? linkIndex + 1 : Math.max(header.length, 5);
        const toCol = (index) => {
          let n = index + 1;
          let out = "";
          while (n > 0) {
            const rem = (n - 1) % 26;
            out = String.fromCharCode(65 + rem) + out;
            n = Math.floor((n - 1) / 26);
          }
          return out;
        };
        return {
          status: toCol(statusIndex),
          provider: toCol(statusIndex + 1),
          updated: toCol(statusIndex + 2),
        };
      })();
    }
    return basicStatusColumnsPromise;
  }

  async function writeBasicReachability(status, metadata = {}, detail = "") {
    const spreadsheetId = clean(metadata.sheet_spreadsheet_id);
    const tabName = clean(metadata.sheet_tab_name);
    const row = Number(metadata.sheet_row || 0);
    if (!spreadsheetId || !tabName || row < 1) return { updated: 0 };
    const value = clean(status).toUpperCase();
    if (!["CHECK","SEND","SKIP"].includes(value)) throw new Error("Reachability must be CHECK, SEND, or SKIP");
    const headerRange = `${quoteTab(tabName)}!I1:I1`;
    const rowRange = `${quoteTab(tabName)}!I${row}:I${row}`;
    await request(spreadsheetId, "/values:batchUpdate", {
      method: "POST",
      body: {
        valueInputOption: "RAW",
        data: [
          { range: headerRange, majorDimension: "ROWS", values: [["Reachability"]] },
          { range: rowRange, majorDimension: "ROWS", values: [[value]] }
        ]
      }
    });
    return { updated: 1, status: value, detail: clean(detail) };
  }

  async function writeBasicSendResult(result, metadata = {}) {
    const spreadsheetId = clean(metadata.sheet_spreadsheet_id);
    const tabName = clean(metadata.sheet_tab_name);
    const row = Number(metadata.sheet_row || 0);
    if (!spreadsheetId || !tabName || row < 1) return { updated: 0 };
    const cols = await resolveBasicStatusColumns(spreadsheetId, tabName);
    const status = result.status === "accepted"
      ? "Sent"
      : result.status === "blocked_not_routable"
        ? "Not Available"
        : result.status === "skipped_suppressed"
          ? "Blocked - Suppressed"
          : "Failed";
    const headerRange = `${quoteTab(tabName)}!${cols.status}1:${cols.updated}1`;
    const rowRange = `${quoteTab(tabName)}!${cols.status}${row}:${cols.updated}${row}`;
    await request(spreadsheetId, "/values:batchUpdate", {
      method: "POST",
      body: {
        valueInputOption: "RAW",
        data: [
          {
            range: headerRange,
            majorDimension: "ROWS",
            values: [["SMS Status", "Telnyx Message ID", "SMS Updated At"]],
          },
          {
            range: rowRange,
            majorDimension: "ROWS",
            values: [[
              status,
              clean(result.telnyx_message_id),
              clean(result.at || new Date().toISOString()),
            ]],
          },
        ],
      },
    });
    return { updated: 1, status };
  }

  async function writeRows({ spreadsheetId, tabName, updates }) {
    assertAllowed(spreadsheetId, tabName);
    if (!Array.isArray(updates) || !updates.length) return { updated: 0 };
    for (let cursor = 0; cursor < updates.length; cursor += 400) {
      const chunk = updates.slice(cursor, cursor + 400);
      await request(spreadsheetId, "/values:batchUpdate", {
        method: "POST",
        body: {
          valueInputOption: "RAW",
          data: chunk.map((u) => ({
            range: `${quoteTab(tabName)}!AC${u.row}:AG${u.row}`,
            majorDimension: "ROWS",
            values: [[
              clean(u.status),
              clean(u.batch_id),
              clean(u.provider_id),
              clean(u.updated_at || new Date().toISOString()),
              clean(u.error),
            ]],
          })),
        },
      });
    }
    return { updated: updates.length };
  }

  async function markBatchQueued(batch) {
    const grouped = new Map();
    for (const recipient of batch?.recipients || []) {
      const meta = recipient?.metadata || {};
      const spreadsheetId = clean(meta.sheet_spreadsheet_id);
      const tabName = clean(meta.sheet_tab_name);
      const row = Number(meta.sheet_row || 0);
      if (!spreadsheetId || !tabName || row < 7) continue;
      const key = `${spreadsheetId}:${tabName}`;
      if (!grouped.has(key)) grouped.set(key, { spreadsheetId, tabName, updates: [] });
      grouped.get(key).updates.push({
        row,
        status: "Queued",
        batch_id: batch.id,
        updated_at: new Date().toISOString(),
      });
    }
    let updated = 0;
    for (const group of grouped.values()) {
      const result = await writeRows(group);
      updated += result.updated;
    }
    return { updated };
  }

  async function writeSendResult(result, metadata = {}) {
    const spreadsheetId = clean(metadata.sheet_spreadsheet_id);
    const tabName = clean(metadata.sheet_tab_name);
    const row = Number(metadata.sheet_row || 0);
    if (!spreadsheetId || !tabName || row < 7) return { updated: 0 };
    const status = result.status === "accepted"
      ? "Accepted by Telnyx"
      : result.status === "skipped_suppressed"
        ? "Blocked - Suppressed"
        : "Failed";
    return writeRows({
      spreadsheetId,
      tabName,
      updates: [{
        row,
        status,
        batch_id: result.batch_id,
        provider_id: result.telnyx_message_id || "",
        updated_at: result.at || new Date().toISOString(),
        error: result.error || "",
      }],
    });
  }

  return {
    configured: Boolean(serviceAccount && allowed.size),
    writer_email: serviceAccount?.client_email || "",
    target_count: allowed.size,
    targets: [...allowed].map((key) => {
      const split = key.indexOf(":");
      return { spreadsheet_id: key.slice(0, split), tab_name: key.slice(split + 1) };
    }),
    schema: smsSheetSchema(),
    readRows,
    readBasicRows,
    writeBasicReachability,
    writeBasicSendResult,
    writeRows,
    markBatchQueued,
    writeSendResult,
  };
}
