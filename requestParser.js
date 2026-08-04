"use strict";

const { BLOCK_START_HOUR, DAY_KEYS, localDateIso } = require("./availabilityBlocks");

/**
 * Parsing a hotel's free-text order — build order step 4 of
 * docs/agencymodelshape.md.
 *
 *   "need 3 housekeepers tomorrow 7am"
 *   "2 porters tonight 10pm-6am"
 *   "4 housekeeping fri 7-3"
 *
 * **Free text in, structured confirmation back.** This module only ever produces
 * a *draft*. Nothing here dispatches anybody: the confirm step is the contract,
 * the audit trail, and the guard against sending thirty people because somebody
 * typed "30" when they meant "3:00". See intakeHandler.js for the confirmation.
 *
 * The parser is deliberately conservative. It reports what it could not work out
 * in `missing`, and the caller asks rather than guessing — a wrong guess here
 * costs a hotel a shift and the agency a client.
 */

/** A shift with a start but no stated end. Matches the blocks' own length. */
const DEFAULT_SHIFT_HOURS = 8;

/** Words that mean a role, mapped to the canonical role name. */
const ROLE_WORDS = {
  housekeeper: "housekeeping", housekeepers: "housekeeping", housekeeping: "housekeeping",
  hk: "housekeeping", room: "housekeeping", rooms: "housekeeping", cleaner: "housekeeping",
  cleaners: "housekeeping",
  porter: "porter", porters: "porter", bellhop: "porter", bellman: "porter",
  nightporter: "porter",
  waiter: "food-and-beverage", waiters: "food-and-beverage", waitress: "food-and-beverage",
  fb: "food-and-beverage", "f&b": "food-and-beverage", server: "food-and-beverage",
  servers: "food-and-beverage", banquet: "food-and-beverage", banquets: "food-and-beverage",
  bar: "food-and-beverage", bartender: "food-and-beverage", barista: "food-and-beverage",
  reception: "reception", receptionist: "reception", "front-desk": "reception",
  concierge: "reception", nightaudit: "reception", audit: "reception",
  kitchen: "kitchen", chef: "kitchen", chefs: "kitchen", kp: "kitchen",
  dishwasher: "kitchen", cook: "kitchen",
  security: "security", guard: "security", guards: "security",
};

const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

/** Block names a hotel might use instead of a clock time. */
const BLOCK_WORDS = {
  morning: "AM", breakfast: "AM", am: "AM", early: "AM",
  afternoon: "PM", evening: "PM", dinner: "PM", lunch: "PM", pm: "PM",
  overnight: "NIGHT", night: "NIGHT", nights: "NIGHT",
};

/* ------------------------------------------------------------------- dates */

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * The next occurrence of a weekday, never today. "Friday" said on a Friday means
 * next Friday — a hotel asking on the day would say "today".
 */
function nextWeekday(now, dayKey) {
  const target = DAY_KEYS.indexOf(dayKey);
  const current = (now.getDay() + 6) % 7;
  const ahead = ((target - current) + 7) % 7 || 7;
  return addDays(now, ahead);
}

/**
 * Finds the date being asked for. Returns null when nothing in the text names a
 * day, so the caller can ask instead of assuming today.
 */
function parseDate(text, now) {
  if (/\btoday\b/.test(text) || /\btonight\b/.test(text) || /\bthis (morning|arvo|afternoon|evening)\b/.test(text)) {
    return { date: new Date(now.getTime()), certain: true };
  }
  if (/\btomorrow\b/.test(text) || /\btmrw\b/.test(text) || /\btmr\b/.test(text)) {
    return { date: addDays(now, 1), certain: true };
  }

  // A weekday name, optionally with "next".
  for (const [word, key] of Object.entries({
    mon: "mon", monday: "mon", tue: "tue", tues: "tue", tuesday: "tue",
    wed: "wed", weds: "wed", wednesday: "wed", thu: "thu", thur: "thu",
    thurs: "thu", thursday: "thu", fri: "fri", friday: "fri",
    sat: "sat", saturday: "sat", sun: "sun", sunday: "sun",
  })) {
    if (new RegExp(`\\b${word}\\b`).test(text)) {
      return { date: nextWeekday(now, key), certain: true };
    }
  }

  // A numeric date: 5/8, 05-08, or "5 aug".
  const slash = text.match(/\b(\d{1,2})[\/\-](\d{1,2})\b/);
  if (slash) {
    const day = Number(slash[1]);
    const month = Number(slash[2]);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      let year = now.getFullYear();
      let candidate = new Date(year, month - 1, day, 12, 0, 0);
      // A date already past is next year, not last year.
      if (candidate < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
        candidate = new Date(year + 1, month - 1, day, 12, 0, 0);
      }
      return { date: candidate, certain: true };
    }
  }

  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const named = text.match(/\b(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/);
  if (named) {
    const day = Number(named[1]);
    const month = MONTHS.indexOf(named[2]);
    if (day >= 1 && day <= 31 && month >= 0) {
      let candidate = new Date(now.getFullYear(), month, day, 12, 0, 0);
      if (candidate < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
        candidate = new Date(now.getFullYear() + 1, month, day, 12, 0, 0);
      }
      return { date: candidate, certain: true };
    }
  }

  return null;
}

/* ------------------------------------------------------------------- times */

/** "7am" / "7" / "07:00" / "7.30pm" -> hours as a float, or null. */
function parseClock(raw, meridiemHint) {
  const m = String(raw).match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const minutes = m[2] ? Number(m[2]) : 0;
  const meridiem = (m[3] || meridiemHint || "").toLowerCase();
  if (hour > 24 || minutes > 59) return null;

  if (meridiem === "pm" && hour < 12) hour += 12;
  else if (meridiem === "am" && hour === 12) hour = 0;
  else if (!meridiem) {
    // No am/pm at all. Hotels write "7" for a 7am start and "10" for a 10pm
    // night shift far less often than they write shift times in the working
    // day, so treat a bare 1-5 as afternoon and everything else as stated.
    if (hour >= 1 && hour <= 5) hour += 12;
  }
  return hour + minutes / 60;
}

/**
 * A time range, or a single start.
 * @returns {{startHours: number, endHours: number|null}|null}
 */
function parseTimes(text) {
  // A range: "7am-3pm", "7-3", "22:00 to 06:00".
  const range = text.match(
    /\b(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)\s*(?:-|–|—|to|til|till|until)\s*(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)\b/i
  );
  if (range) {
    const rightMeridiem = (range[2].match(/am|pm/i) || [])[0];
    const startHours = parseClock(range[1].trim(), rightMeridiem);
    const endHours = parseClock(range[2].trim());
    if (startHours != null && endHours != null) return { startHours, endHours };
  }

  // A single time: "7am", "at 7", "from 22:00".
  const single = text.match(/\b(?:at|from)?\s*(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm))\b/i)
    || text.match(/\b(?:at|from)\s+(\d{1,2}(?:[:.]\d{2})?)\b/i);
  if (single) {
    const startHours = parseClock(single[1].trim());
    if (startHours != null) return { startHours, endHours: null };
  }

  // A block word standing in for a time.
  for (const [word, block] of Object.entries(BLOCK_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(text)) {
      return { startHours: BLOCK_START_HOUR[block], endHours: null, fromBlock: block };
    }
  }

  return null;
}

/* ------------------------------------------------------------------- people */

function parseHeadcount(text) {
  // A digit next to a role word, or on its own: "3 housekeepers", "need 3".
  const digits = text.match(/\b(\d{1,2})\s*(?:x|×)?\s*[a-z&]/);
  if (digits) {
    const n = Number(digits[1]);
    // A number that is obviously a clock time is not a headcount. "7am" has
    // already been stripped by the caller before this runs.
    if (n >= 1 && n <= 50) return n;
  }
  for (const [word, n] of Object.entries(NUMBER_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(text)) return n;
  }
  return null;
}

function parseRole(text) {
  for (const [word, role] of Object.entries(ROLE_WORDS)) {
    if (new RegExp(`\\b${word.replace(/[&]/g, "\\&")}\\b`).test(text)) return role;
  }
  return null;
}

/* ------------------------------------------------------------------ the parse */

/**
 * Turns a hotel's message into a draft request.
 *
 * @param {string} message
 * @param {object} params
 * @param {object[]} params.sites      Sites this requester may order for.
 * @param {string} [params.defaultSiteId]  Their own site, when they only have one.
 * @param {Date} [params.now]
 * @returns {{draft: object, missing: string[], confident: boolean}}
 *   `missing` names what a human still has to supply. `confident` is true only
 *   when nothing is missing — and even then the caller must still confirm.
 */
function parseRequest(message, { sites = [], defaultSiteId = null, now = new Date() } = {}) {
  const text = String(message || "").toLowerCase().trim();
  const missing = [];

  // Times first, so their digits can't be mistaken for a headcount.
  const times = parseTimes(text);
  const textWithoutTimes = text
    .replace(/\b\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)\b/gi, " ")
    .replace(/\b\d{1,2}(?:[:.]\d{2})?\s*(?:-|–|—|to|til|till|until)\s*\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?\b/gi, " ")
    .replace(/\b\d{1,2}[\/\-]\d{1,2}\b/g, " ");

  const headcount = parseHeadcount(textWithoutTimes);
  const role = parseRole(text);
  const when = parseDate(text, now);

  // Which building. A requester registered against one site doesn't have to say.
  let siteId = defaultSiteId;
  let siteName = null;
  for (const site of sites) {
    const name = String(site.name || "").toLowerCase();
    const firstWord = name.split(/\s+/)[0];
    if (name && (text.includes(name) || (firstWord.length > 3 && text.includes(firstWord)))) {
      siteId = site.siteId;
      siteName = site.name;
      break;
    }
  }
  if (!siteName && siteId) {
    const match = sites.find((s) => s.siteId === siteId);
    siteName = match ? match.name : null;
  }

  if (!siteId) missing.push("site");
  if (!headcount) missing.push("headcount");
  if (!role) missing.push("role");
  if (!when) missing.push("date");
  if (!times) missing.push("time");

  let startsAt = null;
  let endsAt = null;
  if (when && times) {
    const base = new Date(when.date.getTime());
    base.setHours(0, 0, 0, 0);
    startsAt = new Date(base.getTime() + times.startHours * 3600 * 1000);

    const endHours = times.endHours != null ? times.endHours : times.startHours + DEFAULT_SHIFT_HOURS;
    // An end at or before the start is the next morning: 22:00–06:00.
    const spansMidnight = endHours <= times.startHours;
    endsAt = new Date(base.getTime() + (spansMidnight ? endHours + 24 : endHours) * 3600 * 1000);

    // "tonight 10pm" on a message sent at 23:30 means tonight, not last night.
    if (when.certain && startsAt < now && /\btonight\b|\btoday\b/.test(text)) {
      const bumped = addDays(startsAt, 1);
      // Only bump if it's within a few hours of now — otherwise trust the text.
      if (startsAt.getTime() > now.getTime() - 6 * 3600 * 1000) {
        startsAt = bumped;
        endsAt = addDays(endsAt, 1);
      }
    }
  }

  return {
    draft: {
      siteId,
      siteName,
      role,
      headcount,
      startsAt: startsAt ? startsAt.toISOString() : null,
      endsAt: endsAt ? endsAt.toISOString() : null,
      // Kept for the confirmation message, so a hotel can see we read the day
      // the way they meant it.
      dateIso: when ? localDateIso(when.date) : null,
      inferredEnd: Boolean(times && times.endHours == null),
      fromBlock: (times && times.fromBlock) || null,
    },
    missing,
    confident: missing.length === 0,
  };
}

/** What to ask for, in the words a hotel manager would use. */
const MISSING_PROMPT = {
  site: "which hotel",
  headcount: "how many people",
  role: "what role (housekeeping, porter, F&B, reception, kitchen, security)",
  date: "which day",
  time: "what time",
};

module.exports = {
  parseRequest,
  parseTimes,
  parseDate,
  parseHeadcount,
  parseRole,
  parseClock,
  MISSING_PROMPT,
  ROLE_WORDS,
  DEFAULT_SHIFT_HOURS,
};
