import { createClient } from "redis";

const REDIS_URL = process.env.ACQUISITION_REDIS_URL || "";
const TELNYX_API_KEY = process.env.TELNYX_API_KEY || "";
const TELNYX_FROM_NUMBER = process.env.TELNYX_FROM_NUMBER || "";
const POLL_MS = Math.max(250, Number(process.env.SMS_WORKER_POLL_MS || 1000));
const SEND_DELAY_MS = Math.max(0, Number(process.env.SMS_SEND_DELAY_MS || 100));
const BATCH_TTL_SECONDS = 604800;

if (!REDIS_URL) throw new Error("ACQUISITION_REDIS_URL is not configured");
if (!TELNYX_API_KEY) throw new Error("TELNYX_API_KEY is not configured");

const redis = createClient({ url: REDIS_URL });
redis.on("error", err => console.error("SMS Redis error", err));
await redis.connect();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function telnyxSend(to, text) {
  if (!TELNYX_FROM_NUMBER) throw new Error("TELNYX_FROM_NUMBER is not configured");
  const response = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${TELNYX_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      from: TELNYX_FROM_NUMBER,
      to,
      text
    })
  });
  const raw = await response.text();
  let body;
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = { raw }; }
  if (!response.ok) {
    const err = new Error(`Telnyx ${response.status}: ${JSON.stringify(body)}`);
    err.status = response.status;
    throw err;
  }
  return body;
}

async function saveBatch(batch) {
  await redis.set(`recover:sms:batch:${batch.id}`, JSON.stringify(batch), { EX: BATCH_TTL_SECONDS });
}

async function processBatch(batchId) {
  const key = `recover:sms:batch:${batchId}`;
  const raw = await redis.get(key);
  if (!raw) return;
  const batch = JSON.parse(raw);
  if (!["queued","running"].includes(batch.status)) return;

  batch.status = "running";
  batch.started_at ||= new Date().toISOString();
  batch.sent_count ||= 0;
  batch.failed_count ||= 0;
  batch.processed_count ||= 0;
  await saveBatch(batch);

  const recipients = Array.isArray(batch.recipients) ? batch.recipients : [];
  for (let i = batch.processed_count; i < recipients.length; i++) {
    const recipient = recipients[i];
    const suppressed = await redis.sIsMember("recover:sms:suppressed", recipient.phone);
    if (suppressed) {
      const row = {
        index: i,
        phone: recipient.phone,
        status: "skipped_suppressed",
        at: new Date().toISOString()
      };
      await redis.rPush(`recover:sms:batch:${batchId}:results`, JSON.stringify(row));
      batch.processed_count = i + 1;
      await saveBatch(batch);
      continue;
    }

    let recipientFailed = false;
    for (let j = 0; j < recipient.messages.length; j++) {
      const text = recipient.messages[j];
      try {
        const response = await telnyxSend(recipient.phone, text);
        await redis.rPush(`recover:sms:batch:${batchId}:results`, JSON.stringify({
          index: i,
          message_index: j,
          phone: recipient.phone,
          contact_id: recipient.contact_id || "",
          status: "accepted",
          telnyx_message_id: response?.data?.id || null,
          to: response?.data?.to || recipient.phone,
          from: response?.data?.from || TELNYX_FROM_NUMBER,
          at: new Date().toISOString()
        }));
        batch.sent_count += 1;
      } catch (error) {
        recipientFailed = true;
        batch.failed_count += 1;
        await redis.rPush(`recover:sms:batch:${batchId}:results`, JSON.stringify({
          index: i,
          message_index: j,
          phone: recipient.phone,
          contact_id: recipient.contact_id || "",
          status: "failed",
          error: error?.message || "send_failed",
          at: new Date().toISOString()
        }));
      }
      await sleep(SEND_DELAY_MS);
    }

    batch.processed_count = i + 1;
    batch.last_recipient_failed = recipientFailed;
    batch.updated_at = new Date().toISOString();
    await saveBatch(batch);
  }

  batch.status = batch.failed_count > 0 ? "completed_with_errors" : "completed";
  batch.completed_at = new Date().toISOString();
  await saveBatch(batch);
}

console.log("Recover SMS worker started");

while (true) {
  try {
    const item = await redis.brPop("recover:sms:queue", 5);
    if (!item?.element) {
      await sleep(POLL_MS);
      continue;
    }
    await processBatch(item.element);
  } catch (error) {
    console.error("SMS worker loop error", error);
    await sleep(Math.max(POLL_MS, 1000));
  }
}
