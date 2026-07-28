"use strict";

const { sendText } = require("./whatsapp");

/**
 * WhatsApp commands for casual-staff availability and roster viewing.
 *
 *   avail mon tue fri   -> set recurring weekly availability
 *   avail all           -> available every day
 *   avail none          -> clear recurring availability
 *   avail               -> show current availability
 *   off 3/8             -> one-off unavailable date (day/month)
 *   on 3/8              -> cancel that exception
 *   roster              -> show your published shifts (this week + next)
 *
 * Parsing is deliberately forgiving — staff type these on a phone mid-shift.
 */

const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_LABELS = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const DAY_ALIASES = {
  mon: "mon", monday: "mon",
  tue: "tue", tues: "tue", tuesday: "tue",
  wed: "wed", weds: "wed", wednesday: "wed",
  thu: "thu", thur: "thu", thurs: "thu", thursday: "thu",
  fri: "fri", friday: "fri",
  sat: "sat", saturday: "sat",
  sun: "sun", sunday: "sun",
};

/** "3/8" or "03/08" -> "YYYY-MM-DD" (this year, or next year if already past). */
function parseDayMonth(text) {
  const m = text.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  const now = new Date();
  let year = now.getFullYear();
  const candidate = new Date(year, month - 1, day);
  // If the date has already passed this year, staff almost certainly mean next year.
  if (candidate < new Date(now.getFullYear(), now.getMonth(), now.getDate())) year += 1;
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

function describeAvailability(availability) {
  const days = availability?.days || [];
  const exceptions = (availability?.exceptions || []).filter(
    (e) => e.date >= new Date().toISOString().slice(0, 10)
  );
  const dayPart = days.length
    ? `Available: ${DAY_KEYS.filter((d) => days.includes(d)).map((d) => DAY_LABELS[d]).join(", ")}`
    : "No recurring availability set.";
  const exPart = exceptions.length
    ? `\nUnavailable dates: ${exceptions.map((e) => e.date).join(", ")}`
    : "";
  return dayPart + exPart;
}

/** Handles "avail ..." messages. Returns true if handled. */
async function handleAvailCommand(from, staff, body, deps, sendOpts) {
  const { staffStore } = deps;
  const rest = body.slice("avail".length).trim();

  if (!rest) {
    await sendText(from, describeAvailability(staff.availability), sendOpts);
    return true;
  }

  if (rest === "none") {
    await staffStore.setAvailabilityDays(from, []);
    await sendText(from, "Cleared — you have no recurring availability set now.", sendOpts);
    return true;
  }

  if (rest === "all") {
    await staffStore.setAvailabilityDays(from, [...DAY_KEYS]);
    await sendText(from, "Got it — you're marked available every day of the week.", sendOpts);
    return true;
  }

  const words = rest.split(/[\s,]+/).filter(Boolean);
  const days = [];
  const unknown = [];
  for (const w of words) {
    const key = DAY_ALIASES[w];
    if (key) {
      if (!days.includes(key)) days.push(key);
    } else {
      unknown.push(w);
    }
  }

  if (days.length === 0) {
    await sendText(
      from,
      'I couldn\'t read any days from that. Try e.g. "avail mon tue fri", or "avail all" / "avail none".',
      sendOpts
    );
    return true;
  }

  await staffStore.setAvailabilityDays(from, days);
  const confirmed = DAY_KEYS.filter((d) => days.includes(d)).map((d) => DAY_LABELS[d]).join(", ");
  let reply = `Done — you're available: ${confirmed}.`;
  if (unknown.length) reply += ` (Didn't understand: ${unknown.join(", ")})`;
  await sendText(from, reply, sendOpts);
  return true;
}

/** Handles "off 3/8" and "on 3/8". Returns true if handled. */
async function handleDateException(from, staff, body, deps, sendOpts) {
  const { staffStore } = deps;
  const isOff = body.startsWith("off ");
  const dateText = body.slice(isOff ? 4 : 3).trim();
  const dateIso = parseDayMonth(dateText);

  if (!dateIso) {
    await sendText(from, `I couldn't read that date. Use day/month, e.g. "${isOff ? "off" : "on"} 3/8".`, sendOpts);
    return true;
  }

  await staffStore.setDateException(from, dateIso, !isOff);
  await sendText(
    from,
    isOff
      ? `Noted — you're marked unavailable on ${dateIso}.`
      : `Done — cleared your unavailability for ${dateIso}.`,
    sendOpts
  );
  return true;
}

/** Monday of the week containing `date`, as YYYY-MM-DD. */
function mondayOf(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

const SLOT_LABELS = { AM: "AM", PM: "PM", ALL: "all day" };

/** Handles "roster" — shows this week + next week's published assignments. */
async function handleRosterQuery(from, staff, deps, sendOpts) {
  const { rosterStore } = deps;
  const thisMonday = mondayOf(new Date());
  const nextMonday = mondayOf(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
  const weeks = await rosterStore.getPublishedWeeks(staff.tenantId, [thisMonday, nextMonday]);

  const lines = [];
  for (const week of weeks) {
    for (const [date, dayAssignments] of Object.entries(week.assignments || {})) {
      const slot = dayAssignments[from];
      if (!slot) continue;
      if (date < new Date().toISOString().slice(0, 10)) continue; // past days: skip
      const label = new Date(date + "T00:00:00").toLocaleDateString("en-AU", {
        weekday: "short", day: "numeric", month: "short",
      });
      lines.push({ date, text: `${label} — ${SLOT_LABELS[slot] || slot}` });
    }
  }

  if (lines.length === 0) {
    await sendText(from, "No upcoming published shifts for you yet — check back once your manager publishes the roster.", sendOpts);
    return true;
  }

  lines.sort((a, b) => (a.date < b.date ? -1 : 1));
  await sendText(from, `Your upcoming shifts:\n${lines.map((l) => l.text).join("\n")}`, sendOpts);
  return true;
}

module.exports = { handleAvailCommand, handleDateException, handleRosterQuery, mondayOf, SLOT_LABELS };
