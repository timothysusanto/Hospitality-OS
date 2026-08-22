"use strict";

/**
 * walletHandler.js — Credential wallet over WhatsApp (Core OS Phase 2).
 *
 * The whole flow lives in chat, matching how everything else here works:
 *
 *   Worker: [photo of their RSA card]
 *   Bot:    "Looks like an RSA / RCG expiring 15 Mar 2027. Reply YES to save,
 *            or correct me like: rsa 15/03/2027"
 *   Worker: yes
 *   Bot:    "✅ Saved. I'll remind you before it expires."
 *
 *   Worker: wallet          → lists their credentials + expiry status
 *
 * Reading the card photo uses the Anthropic API when ANTHROPIC_API_KEY is set
 * (Railway → Variables); without it the bot simply asks the worker to type
 * the type and expiry, so the feature degrades, never breaks.
 *
 * Photo storage uses Firebase Storage when FIREBASE_STORAGE_BUCKET is set;
 * otherwise only the WhatsApp media ID is kept (Meta retains media ~30 days).
 *
 * KNOWN LIMITATION: drafts are in-memory (same trade-off as pendingActions.js)
 * — a redeploy mid-conversation drops an unconfirmed draft; the worker just
 * sends the photo again.
 */

const { sendText, fetchMediaBinary } = require("./whatsapp");
const { getFirestoreDb } = require("./firebase");
const { CREDENTIAL_TYPES, resolveType } = require("./credentialTypes");

const DRAFT_TTL_MS = 10 * 60 * 1000;
/** @type {Map<string, {data: object, at: number}>} phone → pending draft */
const drafts = new Map();

function setDraft(phone, data) { drafts.set(phone, { data, at: Date.now() }); }
function getDraft(phone) {
  const e = drafts.get(phone);
  if (!e) return null;
  if (Date.now() - e.at > DRAFT_TTL_MS) { drafts.delete(phone); return null; }
  return e.data;
}
function clearDraft(phone) { drafts.delete(phone); }

const typeMenu = () =>
  Object.values(CREDENTIAL_TYPES).map((t) => `${t.aliases[0]} (${t.label})`).join(", ");

// ---------------------------------------------------------------------------
// "wallet" command — list what we hold for this worker
// ---------------------------------------------------------------------------
async function handleWalletCommand(from, staff, tenantId, deps, sendOpts) {
  const db = getFirestoreDb();
  if (!db) {
    await sendText(from, "The credential wallet isn't switched on yet — ask your manager.", sendOpts);
    return;
  }
  const snap = await db.collection("tenants").doc(tenantId).collection("credentials")
    .where("workerPhone", "==", from).get();
  if (snap.empty) {
    await sendText(from,
      `📇 Your wallet is empty, ${staff.name}. Send me a photo of a credential ` +
      `(RSA, visa, White Card…) and I'll file it and remind you before it expires.`, sendOpts);
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const lines = snap.docs.map((d) => {
    const c = d.data();
    if (!c.expiryDate) return `• ${c.label} — no expiry recorded`;
    const days = daysBetween(today, c.expiryDate);
    const flag = days < 0 ? `🔴 EXPIRED ${fmtDate(c.expiryDate)}`
      : days <= 30 ? `🟠 expires ${fmtDate(c.expiryDate)} (${days}d)`
      : `🟢 expires ${fmtDate(c.expiryDate)}`;
    return `• ${c.label} — ${flag}`;
  });
  await sendText(from,
    `📇 Your wallet:\n${lines.join("\n")}\n\nSend a photo of a new or renewed credential to update it.`, sendOpts);
}

// ---------------------------------------------------------------------------
// Incoming photo → draft → confirmation
// ---------------------------------------------------------------------------
async function handleCredentialPhoto(from, staff, image, tenantId, deps, sendOpts) {
  const db = getFirestoreDb();
  if (!db) {
    await sendText(from, "Got the photo — but the wallet isn't switched on yet. Ask your manager.", sendOpts);
    return;
  }
  await sendText(from, "📷 Got it — reading the card…", sendOpts);

  const media = await fetchMediaBinary(image.id, sendOpts);
  let fileUrl = null;
  let extracted = null;
  if (media) {
    fileUrl = await storeImage(tenantId, from, media.buffer, media.mimeType);
    extracted = await aiExtract(media.buffer, media.mimeType);
  }

  const draft = {
    waMediaId: image.id, fileUrl,
    type: extracted?.type || null,
    expiryDate: extracted?.expiryDate || null,
    number: extracted?.number || null,
  };
  setDraft(from, draft);

  if (draft.type && draft.expiryDate) {
    const label = CREDENTIAL_TYPES[draft.type].label;
    await sendText(from,
      `Looks like: *${label}*${draft.number ? `, no. ${draft.number}` : ""}, expiring ${fmtDate(draft.expiryDate)}.\n\n` +
      `Reply *YES* to save, or correct me like: rsa 15/03/2027`, sendOpts);
  } else {
    await sendText(from,
      `I couldn't read it confidently. Tell me what it is and when it expires, like:\n` +
      `rsa 15/03/2027\n\nTypes I know: ${typeMenu()}.`, sendOpts);
  }
}

// ---------------------------------------------------------------------------
// Reply while a draft is pending. Returns false when no draft → router
// carries on to its other handlers, so this can never shadow anything.
// ---------------------------------------------------------------------------
async function handleWalletReply(from, staff, body, tenantId, deps, sendOpts) {
  const draft = getDraft(from);
  if (!draft) return false;

  if (body === "cancel" || body === "no") {
    clearDraft(from);
    await sendText(from, "Okay — nothing saved. Send the photo again any time.", sendOpts);
    return true;
  }

  if (body === "yes" || body === "y") {
    if (draft.type && draft.expiryDate) {
      await saveCredential(from, staff, tenantId, draft, sendOpts);
      return true;
    }
    await sendText(from, `Almost — I still need the type and expiry. Reply like: rsa 15/03/2027\nTypes: ${typeMenu()}.`, sendOpts);
    return true;
  }

  // "rsa 15/03/2027" / "white card 2028-01-31" / "visa 15/03/2027 12345"
  const parsed = parseCorrection(body);
  if (parsed) {
    Object.assign(draft, parsed);
    if (draft.type && draft.expiryDate) {
      await saveCredential(from, staff, tenantId, draft, sendOpts);
    } else {
      setDraft(from, draft);
      await sendText(from, `Got ${draft.type ? CREDENTIAL_TYPES[draft.type].label : "the date"} — still need the ${draft.type ? "expiry date (like 15/03/2027)" : "type (" + typeMenu() + ")"}.`, sendOpts);
    }
    return true;
  }

  await sendText(from,
    `Still filing your last photo. Reply *YES* to save, *NO* to cancel, or correct me like: rsa 15/03/2027`, sendOpts);
  return true;
}

async function saveCredential(from, staff, tenantId, draft, sendOpts) {
  const db = getFirestoreDb();
  const label = CREDENTIAL_TYPES[draft.type].label;
  await db.collection("tenants").doc(tenantId).collection("credentials").add({
    workerId: staff.id || null,
    workerPhone: from,
    workerName: staff.name || null,
    type: draft.type, label,
    number: draft.number || null,
    expiryDate: draft.expiryDate,
    fileUrl: draft.fileUrl || null,
    waMediaId: draft.waMediaId || null,
    source: "whatsapp",
    nudgesSent: {},
    createdAt: new Date().toISOString(),
  });
  clearDraft(from);
  const days = daysBetween(new Date().toISOString().slice(0, 10), draft.expiryDate);
  await sendText(from,
    `✅ Saved: ${label}, expires ${fmtDate(draft.expiryDate)}` +
    (days > 0 ? ` — ${days} days away. I'll remind you before then.` : ` — ⚠ that's already passed. Renew it and send me the new one.`), sendOpts);
}

// ---------------------------------------------------------------------------
// Parsing & extraction
// ---------------------------------------------------------------------------
function parseCorrection(body) {
  const dateM = body.match(/(\d{4})-(\d{2})-(\d{2})|(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  let expiryDate = null;
  if (dateM) {
    expiryDate = dateM[1]
      ? `${dateM[1]}-${dateM[2]}-${dateM[3]}`
      : `${dateM[6]}-${String(dateM[5]).padStart(2, "0")}-${String(dateM[4]).padStart(2, "0")}`; // dd/mm/yyyy (AU)
  }
  const withoutDate = body.replace(dateM ? dateM[0] : "", " ");
  const numberM = withoutDate.match(/\b([A-Za-z]{0,3}\d{4,})\b/);
  const words = withoutDate.replace(numberM ? numberM[0] : "", " ").trim();
  const type = resolveType(words) || resolveType(words.split(/\s+/)[0]);
  if (!type && !expiryDate) return null;
  const out = {};
  if (type) out.type = type;
  if (expiryDate) out.expiryDate = expiryDate;
  if (numberM) out.number = numberM[1];
  return out;
}

/** Read the card with Claude when an API key is configured; null otherwise. */
async function aiExtract(buffer, mimeType) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mimeType, data: buffer.toString("base64") } },
            { type: "text", text:
              `This is a photo of an Australian work credential (RSA/RCG card, visa grant, White Card, ` +
              `police check, NDIS clearance, Food Safety Supervisor certificate, first aid certificate, or driver licence). ` +
              `Respond with ONLY a JSON object, no markdown: {"type": one of ` +
              `${JSON.stringify(Object.keys(CREDENTIAL_TYPES))} or null, "expiryDate": "YYYY-MM-DD" or null ` +
              `(the EXPIRY date, not issue date; if only an issue date exists, null), ` +
              `"number": card/licence number or null, "confidence": "high"|"low"}. ` +
              `If unsure of any field, use null.` },
          ],
        }],
      }),
    });
    const json = await res.json();
    if (!res.ok) { console.error("[wallet-ai]", res.status, JSON.stringify(json).slice(0, 300)); return null; }
    const text = (json.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    if (parsed.confidence === "low") return null;
    if (parsed.type && !CREDENTIAL_TYPES[parsed.type]) parsed.type = null;
    if (parsed.expiryDate && !/^\d{4}-\d{2}-\d{2}$/.test(parsed.expiryDate)) parsed.expiryDate = null;
    return parsed;
  } catch (err) {
    console.error("[wallet-ai] extract failed:", err.message);
    return null;
  }
}

/** Best-effort Firebase Storage upload; null (and no error) when unconfigured. */
async function storeImage(tenantId, phone, buffer, mimeType) {
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
  if (!bucketName) return null;
  try {
    const admin = require("firebase-admin");
    const ext = (mimeType.split("/")[1] || "jpg").split(";")[0];
    const file = admin.storage().bucket(bucketName)
      .file(`credentials/${tenantId}/${phone}/${Date.now()}.${ext}`);
    await file.save(buffer, { contentType: mimeType, resumable: false });
    const [url] = await file.getSignedUrl({ action: "read", expires: "2100-01-01" });
    return url;
  } catch (err) {
    console.warn("[wallet] storage upload skipped:", err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
function daysBetween(fromStr, toStr) {
  return Math.round((new Date(toStr + "T12:00:00") - new Date(fromStr + "T12:00:00")) / 86400000);
}
function fmtDate(ds) {
  return new Date(ds + "T12:00:00").toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

module.exports = { handleWalletCommand, handleWalletReply, handleCredentialPhoto };
