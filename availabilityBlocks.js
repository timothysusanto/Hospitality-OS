"use strict";

/**
 * The three blocks that cover the clock — build order step 3 of
 * docs/agencymodelshape.md.
 *
 * Free-typed time ranges fail at scale: too much typing, too many formats.
 * Hotels already cut the day into three shifts, so those are the unit of
 * answer. Staff *answer* in blocks; the system *stores* real times, so
 * matching and reporting stay exact.
 *
 *   AM     06:00–14:00   housekeeping, breakfast, early F&B
 *   PM     14:00–22:00   lunch/dinner service, banquets, evening reception
 *   NIGHT  22:00–06:00   night audit, security, overnight porter
 *
 * No gaps, no overlaps, and the words already mean this to a hotel. A person's
 * week is a subset of 21 cells (7 days × 3 blocks).
 *
 * Everything here is a pure function, so the rules can be tested without a
 * store or a clock.
 */

const BLOCKS = ["AM", "PM", "NIGHT"];

/** Start hour of each block, in local venue time. */
const BLOCK_START_HOUR = { AM: 6, PM: 14, NIGHT: 22 };

const BLOCK_LABEL = { AM: "AM", PM: "PM", NIGHT: "Night" };
const BLOCK_HOURS_LABEL = { AM: "06:00–14:00", PM: "14:00–22:00", NIGHT: "22:00–06:00" };

const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_LABEL = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const DAY_ALIASES = {
  mon: "mon", monday: "mon", m: "mon",
  tue: "tue", tues: "tue", tuesday: "tue",
  wed: "wed", weds: "wed", wednesday: "wed",
  thu: "thu", thur: "thu", thurs: "thu", thursday: "thu",
  fri: "fri", friday: "fri", f: "fri",
  sat: "sat", saturday: "sat",
  sun: "sun", sunday: "sun",
};
const BLOCK_ALIASES = {
  am: "AM", morning: "AM", breakfast: "AM", early: "AM",
  pm: "PM", afternoon: "PM", evening: "PM", dinner: "PM", arvo: "PM",
  night: "NIGHT", nights: "NIGHT", overnight: "NIGHT", nite: "NIGHT",
};

function normalizeBlock(raw) {
  const text = String(raw || "").trim().toLowerCase();
  if (!text) return null;
  if (BLOCK_ALIASES[text]) return BLOCK_ALIASES[text];
  const upper = text.toUpperCase();
  return BLOCKS.includes(upper) ? upper : null;
}

/** Keeps a block list canonical: in AM/PM/NIGHT order, no duplicates, no junk. */
function normalizeBlocks(raw) {
  if (!Array.isArray(raw)) return [];
  const set = new Set();
  for (const item of raw) {
    const block = normalizeBlock(item);
    if (block) set.add(block);
  }
  return BLOCKS.filter((b) => set.has(b));
}

function localDateIso(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Which block a shift belongs to, and which date owns it.
 *
 * The block is decided by the **start** time, not by the span. A 17:00–23:00
 * dinner service is simply PM, even though it runs past 22:00 — that is the
 * design note's own example, and the alternative (a shift belonging to two
 * blocks) makes matching ambiguous for no gain.
 *
 * **A night belongs to the date it starts on.** "Friday night" means Friday
 * into Saturday, because that is what staff mean, so a shift starting at 01:00
 * on Saturday is part of Friday's NIGHT cell. Payroll still splits at midnight;
 * the two are allowed to differ as long as it's deliberate.
 *
 * @param {string|Date} startsAt
 * @returns {{block: "AM"|"PM"|"NIGHT", dateIso: string}}
 */
function blockFor(startsAt) {
  const start = new Date(startsAt);
  const hour = start.getHours();

  if (hour >= BLOCK_START_HOUR.AM && hour < BLOCK_START_HOUR.PM) {
    return { block: "AM", dateIso: localDateIso(start) };
  }
  if (hour >= BLOCK_START_HOUR.PM && hour < BLOCK_START_HOUR.NIGHT) {
    return { block: "PM", dateIso: localDateIso(start) };
  }
  if (hour >= BLOCK_START_HOUR.NIGHT) {
    return { block: "NIGHT", dateIso: localDateIso(start) };
  }

  // Small hours: this is the night that started yesterday.
  const owning = new Date(start.getTime());
  owning.setDate(owning.getDate() - 1);
  return { block: "NIGHT", dateIso: localDateIso(owning) };
}

/** Monday of the week containing `date`, as YYYY-MM-DD. Local time. */
function weekStartOf(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0 = Sunday
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  d.setHours(12, 0, 0, 0);
  return localDateIso(d);
}

/** The seven dates of a week, Monday first. */
function weekDates(weekStart) {
  const base = new Date(`${weekStart}T12:00:00`);
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(base.getTime());
    d.setDate(base.getDate() + i);
    out.push(localDateIso(d));
  }
  return out;
}

/** mon..sun for a date, so a standing pattern can be applied to a real week. */
function dayKeyOf(dateIso) {
  const d = new Date(`${dateIso}T12:00:00`);
  return DAY_KEYS[(d.getDay() + 6) % 7];
}

/**
 * Parses the text shorthand, for the people who like typing:
 *
 *   "mon am pm, wed night, fri all"
 *   "sat sun all"
 *   "mon-fri am"
 *
 * A day with no blocks after it means the whole day ("all"). Returns a
 * `days`-shaped map keyed by day name plus whatever it couldn't read, so the
 * reply can say which words were ignored rather than silently dropping them.
 *
 * @param {string} text
 * @returns {{pattern: Record<string, string[]>, unknown: string[]}}
 */
function parseShorthand(text) {
  const pattern = {};
  const unknown = [];
  // Comma or semicolon separates groups; "mon am pm, wed night".
  const groups = String(text || "").toLowerCase().split(/[,;]+/);

  for (const group of groups) {
    const words = group.trim().split(/[\s]+/).filter(Boolean);
    if (!words.length) continue;

    const days = [];
    const blocks = [];
    for (const word of words) {
      // A range: "mon-fri".
      const range = word.match(/^([a-z]+)-([a-z]+)$/);
      if (range && DAY_ALIASES[range[1]] && DAY_ALIASES[range[2]]) {
        const from = DAY_KEYS.indexOf(DAY_ALIASES[range[1]]);
        const to = DAY_KEYS.indexOf(DAY_ALIASES[range[2]]);
        // Wrapping ranges ("fri-mon") walk forward through the weekend.
        for (let i = 0; i < 7; i++) {
          const index = (from + i) % 7;
          days.push(DAY_KEYS[index]);
          if (index === to) break;
        }
        continue;
      }
      if (DAY_ALIASES[word]) { days.push(DAY_ALIASES[word]); continue; }
      if (word === "all" || word === "any" || word === "whole") { blocks.push(...BLOCKS); continue; }
      const block = normalizeBlock(word);
      if (block) { blocks.push(block); continue; }
      unknown.push(word);
    }

    if (!days.length) {
      // Blocks with no day, e.g. a bare "am" — not enough to act on.
      unknown.push(...words.filter((w) => normalizeBlock(w)));
      continue;
    }
    // "mon" on its own means the whole of Monday.
    const resolved = blocks.length ? normalizeBlocks(blocks) : [...BLOCKS];
    for (const day of days) {
      pattern[day] = normalizeBlocks([...(pattern[day] || []), ...resolved]);
    }
  }

  return { pattern, unknown };
}

/**
 * Turns a day-of-week pattern into a real week's `days` map.
 * @param {Record<string, string[]>} pattern e.g. {mon: ["AM"], tue: ["AM","PM"]}
 * @param {string} weekStart
 */
function expandPattern(pattern, weekStart) {
  const days = {};
  if (!pattern || typeof pattern !== "object") return days;
  for (const dateIso of weekDates(weekStart)) {
    const blocks = normalizeBlocks(pattern[dayKeyOf(dateIso)]);
    if (blocks.length) days[dateIso] = blocks;
  }
  return days;
}

/** The reverse: a week's answer collapsed back to a day-of-week pattern. */
function patternFromDays(days) {
  const pattern = {};
  for (const [dateIso, blocks] of Object.entries(days || {})) {
    const clean = normalizeBlocks(blocks);
    if (clean.length) pattern[dayKeyOf(dateIso)] = clean;
  }
  return pattern;
}

/**
 * Human summary of a week's answer, for the confirm-or-amend ping:
 * "Mon AM, Wed AM/PM, Fri AM".
 */
function describeDays(days) {
  const parts = [];
  for (const dateIso of Object.keys(days || {}).sort()) {
    const blocks = normalizeBlocks(days[dateIso]);
    if (!blocks.length) continue;
    const label = new Date(`${dateIso}T12:00:00`).toLocaleDateString("en-AU", { weekday: "short" });
    parts.push(`${label} ${blocks.map((b) => BLOCK_LABEL[b]).join("/")}`);
  }
  return parts.length ? parts.join(", ") : "nothing";
}

/** Same, for a day-of-week pattern: "Mon–Fri AM" style is not attempted. */
function describePattern(pattern) {
  const parts = [];
  for (const day of DAY_KEYS) {
    const blocks = normalizeBlocks(pattern && pattern[day]);
    if (blocks.length) parts.push(`${DAY_LABEL[day]} ${blocks.map((b) => BLOCK_LABEL[b]).join("/")}`);
  }
  return parts.length ? parts.join(", ") : "nothing";
}

/** "11–17 Aug" for a week, as the weekly ping opens with. */
function describeWeek(weekStart) {
  const dates = weekDates(weekStart);
  const start = new Date(`${dates[0]}T12:00:00`);
  const end = new Date(`${dates[6]}T12:00:00`);
  const sameMonth = start.getMonth() === end.getMonth();
  const startLabel = start.toLocaleDateString("en-AU", sameMonth ? { day: "numeric" } : { day: "numeric", month: "short" });
  const endLabel = end.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
  return `${startLabel}–${endLabel}`;
}

module.exports = {
  BLOCKS,
  BLOCK_LABEL,
  BLOCK_HOURS_LABEL,
  BLOCK_START_HOUR,
  DAY_KEYS,
  DAY_LABEL,
  normalizeBlock,
  normalizeBlocks,
  blockFor,
  weekStartOf,
  weekDates,
  dayKeyOf,
  localDateIso,
  parseShorthand,
  expandPattern,
  patternFromDays,
  describeDays,
  describePattern,
  describeWeek,
};
