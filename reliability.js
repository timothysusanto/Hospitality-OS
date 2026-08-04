"use strict";

/**
 * Reliability — the numbers that decide who gets offered a shift first.
 *
 * Data model (docs/agencymodelshape.md):
 *   staff/{phone}.reliability = { offered, accepted, showed, late, noShow,
 *                                medianResponseSec, recentResponseSecs[] }
 *
 * Kept as pure functions over a plain object so both store twins share one
 * definition of what these numbers mean, and so the ranking is testable
 * without a database.
 *
 * **Median response time is the most valuable number in a same-day business.**
 * It is computed from a bounded rolling window rather than a lifetime average:
 * a person who was slow six months ago and is fast now should rank as fast,
 * and an unbounded array on a document read on every blast is a cost problem
 * at 300 staff.
 */

/** How many recent answers feed the median. Enough to be stable, small enough to move. */
const RESPONSE_WINDOW = 20;

function emptyReliability() {
  return {
    offered: 0,
    accepted: 0,
    showed: 0,
    late: 0,
    noShow: 0,
    medianResponseSec: null,
    recentResponseSecs: [],
  };
}

/** Fills in anything missing, so callers never guard on shape. */
function normalizeReliability(raw) {
  const base = emptyReliability();
  if (!raw || typeof raw !== "object") return base;
  const recent = Array.isArray(raw.recentResponseSecs)
    ? raw.recentResponseSecs.filter((n) => Number.isFinite(n) && n >= 0).slice(-RESPONSE_WINDOW)
    : [];
  return {
    offered: Number(raw.offered) || 0,
    accepted: Number(raw.accepted) || 0,
    showed: Number(raw.showed) || 0,
    late: Number(raw.late) || 0,
    noShow: Number(raw.noShow) || 0,
    medianResponseSec: Number.isFinite(raw.medianResponseSec) ? raw.medianResponseSec : medianOf(recent),
    recentResponseSecs: recent,
  };
}

function medianOf(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** An offer went out. Counted even if it's never answered — that's the point. */
function withOfferSent(reliability) {
  const r = normalizeReliability(reliability);
  return { ...r, offered: r.offered + 1 };
}

/**
 * An offer was answered. `responseSec` feeds the median for any real answer,
 * including a decline and including losing the race — all three prove the
 * person reads their messages, which is what the number measures.
 *
 * Expiries must not come through here: a non-response has no response time,
 * and treating it as one would flatter the slow and punish nobody.
 *
 * @param {object} reliability
 * @param {{accepted: boolean, responseSec: number|null}} answer
 */
function withOfferAnswered(reliability, { accepted, responseSec }) {
  const r = normalizeReliability(reliability);
  const recent = Number.isFinite(responseSec) && responseSec >= 0
    ? [...r.recentResponseSecs, responseSec].slice(-RESPONSE_WINDOW)
    : r.recentResponseSecs;
  return {
    ...r,
    accepted: accepted ? r.accepted + 1 : r.accepted,
    recentResponseSecs: recent,
    medianResponseSec: medianOf(recent),
  };
}

/**
 * A shift they accepted has resolved.
 * @param {object} reliability
 * @param {{showed?: boolean, late?: boolean, noShow?: boolean}} result
 */
function withShiftResult(reliability, { showed = false, late = false, noShow = false }) {
  const r = normalizeReliability(reliability);
  return {
    ...r,
    showed: showed ? r.showed + 1 : r.showed,
    late: late ? r.late + 1 : r.late,
    noShow: noShow ? r.noShow + 1 : r.noShow,
  };
}

/** Shows up when they say they will, as a 0–1 rate. Null until they have history. */
function showRate(reliability) {
  const r = normalizeReliability(reliability);
  const resolved = r.showed + r.noShow;
  return resolved ? r.showed / resolved : null;
}

/**
 * Ranking score, higher is better. Used to order wave 1.
 *
 * The two lanes weight this differently on purpose, straight from the design
 * note's table: planned dispatch ranks by reliability because there is time to
 * wait for the right person, and urgent ranks by median response time because
 * a reliable person who answers in three hours cannot fill a 6am gap.
 *
 * Somebody with no history sits mid-table rather than last. A new starter who
 * always ranks below everyone never gets a first shift, and so never gets
 * history — the pool would ossify.
 *
 * @param {object} staff @param {"planned"|"urgent"} lane
 */
function rankScore(staff, lane) {
  const r = normalizeReliability(staff && staff.reliability);
  const show = showRate(r);
  // 0.75 is the assumed show rate for someone unproven: good enough to be
  // tried, not good enough to outrank a demonstrated 100%.
  const showComponent = show == null ? 0.75 : show;
  const noShowPenalty = r.noShow * 0.05;

  if (lane === "urgent") {
    // Fast answers dominate. 600s (10 min, one urgent accept window) scores 0;
    // instant scores 1.
    const median = r.medianResponseSec;
    const speed = median == null ? 0.5 : Math.max(0, 1 - median / 600);
    return speed * 2 + showComponent - noShowPenalty;
  }

  // Planned: reliability first, speed only as a tiebreak.
  const median = r.medianResponseSec;
  const speed = median == null ? 0.5 : Math.max(0, 1 - median / (4 * 60 * 60));
  return showComponent * 2 + speed * 0.25 - noShowPenalty;
}

/** Ranks a staff list best-first for a lane. Stable for equal scores. */
function rankStaff(staffList, lane) {
  return [...staffList]
    .map((staff, index) => ({ staff, index, score: rankScore(staff, lane) }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .map((entry) => entry.staff);
}

module.exports = {
  emptyReliability,
  normalizeReliability,
  withOfferSent,
  withOfferAnswered,
  withShiftResult,
  showRate,
  rankScore,
  rankStaff,
  medianOf,
  RESPONSE_WINDOW,
};
