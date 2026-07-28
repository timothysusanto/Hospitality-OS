"use strict";

const { sendText } = require("./whatsapp");

/**
 * WhatsApp command for logging food/bev purchases:
 *
 *   spend 420 bidfood      -> $420, supplier "bidfood", dated today
 *   spend 87.50            -> $87.50, no supplier
 *
 * Role-based reply discipline (decisions log — financial data only to
 * owner/manager): everyone gets a minimal confirmation of what THEY logged;
 * only owner/manager replies include the running weekly total.
 */

function mondayOf(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

async function handleSpendCommand(from, staff, body, deps, sendOpts) {
  const { purchasesStore } = deps;
  const rest = body.slice("spend".length).trim();
  const match = rest.match(/^\$?(\d+(?:\.\d{1,2})?)\s*(.*)$/);

  if (!match) {
    await sendText(
      from,
      'To log a delivery: "spend 420 bidfood" (amount, then supplier). The amount is required; the supplier is optional.',
      sendOpts
    );
    return true;
  }

  const amount = Number(match[1]);
  const supplier = match[2].trim() || null;

  if (!isFinite(amount) || amount <= 0 || amount > 1000000) {
    await sendText(from, "That amount doesn't look right — try e.g. \"spend 420 bidfood\".", sendOpts);
    return true;
  }

  const today = new Date().toISOString().slice(0, 10);
  await purchasesStore.add({
    tenantId: staff.tenantId,
    date: today,
    amount,
    supplier,
    source: "whatsapp",
    loggedBy: from,
  });

  let reply = `Logged $${amount.toFixed(2)}${supplier ? ` — ${supplier}` : ""}, today.`;

  // Weekly running total: owner/manager only.
  if (staff.role === "owner" || staff.role === "manager") {
    const weekStart = mondayOf(new Date());
    const all = await purchasesStore.listByTenant(staff.tenantId);
    const weekTotal = all
      .filter((p) => p.date >= weekStart)
      .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
    reply += ` This week's purchases: $${weekTotal.toFixed(2)}.`;
  }

  await sendText(from, reply, sendOpts);
  return true;
}

module.exports = { handleSpendCommand };
