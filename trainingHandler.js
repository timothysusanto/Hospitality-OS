"use strict";

/**
 * trainingHandler.js — Multilingual micro-training over WhatsApp
 * (Hospitality Edition, Core OS Phase 3).
 *
 *   Worker: train           → module list + languages
 *   Worker: train 1 ne      → three lessons arrive in Nepali, then the quiz
 *   Worker: a / b / c       → answers; pass mark 2 of 3
 *   Bot:    🎓 Passed — recorded in your wallet.
 *
 * Completions land in tenants/{t}/trainingRecords and surface in the
 * worker's credential wallet ("wallet" command and the /roster wallet view
 * read the same store via the API).
 *
 * KNOWN LIMITATION: quiz state is in-memory (same trade-off as the wallet
 * drafts) — a redeploy mid-quiz means retaking three questions.
 */

const { sendText } = require("./whatsapp");
const { getFirestoreDb } = require("./firebase");
const { MODULES, LANGS } = require("./trainingContent");

const QUIZ_TTL_MS = 30 * 60 * 1000;
/** @type {Map<string, object>} phone → active quiz */
const quizzes = new Map();

async function handleTrainCommand(from, staff, body, tenantId, deps, sendOpts) {
  const db = getFirestoreDb();
  if (!db) { await sendText(from, "Training isn't switched on yet — ask your manager.", sendOpts); return; }

  const m = body.match(/^train\s+(\d+)\s*([a-z]{2})?$/);
  if (!m) {
    const list = Object.values(MODULES)
      .map((mod) => `${mod.id}. ${mod.title.en} — reply "train ${mod.id} en" | "train ${mod.id} ne" (${LANGS.ne}) | "train ${mod.id} zh" (${LANGS.zh})`)
      .join("\n");
    await sendText(from, `🎓 Training modules:\n${list}`, sendOpts);
    return;
  }

  const mod = MODULES[parseInt(m[1], 10)];
  const lang = m[2] && mod && mod.lessons[m[2]] ? m[2] : "en";
  if (!mod) { await sendText(from, `No module ${m[1]} yet. Text "train" for the list.`, sendOpts); return; }

  // Lessons — one message each, then question 1.
  for (const lesson of mod.lessons[lang]) await sendText(from, lesson, sendOpts);
  quizzes.set(from, { moduleId: mod.id, lang, qIdx: 0, correct: 0, startedAt: Date.now(), byName: staff.name });
  await sendQuestion(from, mod, lang, 0, sendOpts);
}

async function sendQuestion(from, mod, lang, qIdx, sendOpts) {
  const q = mod.quiz[lang][qIdx];
  await sendText(from,
    `❓ ${qIdx + 1}/${mod.quiz[lang].length}: ${q.q}\n\na) ${q.a}\nb) ${q.b}\nc) ${q.c}\n\nReply a, b or c.`, sendOpts);
}

/** Returns true when the message belonged to an active quiz. */
async function handleTrainingReply(from, staff, body, tenantId, deps, sendOpts) {
  const quiz = quizzes.get(from);
  if (!quiz) return false;
  if (Date.now() - quiz.startedAt > QUIZ_TTL_MS) { quizzes.delete(from); return false; }

  if (body === "stop" || body === "cancel") {
    quizzes.delete(from);
    await sendText(from, `Training stopped. Text "train" any time to start again.`, sendOpts);
    return true;
  }
  const ans = body.trim().toLowerCase().replace(/[).]/g, "");
  if (!["a", "b", "c"].includes(ans)) {
    await sendText(from, "Reply just a, b or c (or \"stop\").", sendOpts);
    return true;
  }

  const mod = MODULES[quiz.moduleId];
  const questions = mod.quiz[quiz.lang];
  const q = questions[quiz.qIdx];
  const right = ans === q.correct;
  if (right) quiz.correct++;

  quiz.qIdx++;
  if (quiz.qIdx < questions.length) {
    await sendText(from, right ? "✅ Correct." : `❌ Not quite — the answer was ${q.correct}) ${q[q.correct]}.`, sendOpts);
    await sendQuestion(from, mod, quiz.lang, quiz.qIdx, sendOpts);
    return true;
  }

  // Finished
  quizzes.delete(from);
  const passed = quiz.correct >= mod.passMark;
  const db = getFirestoreDb();
  await db.collection("tenants").doc(tenantId).collection("trainingRecords").add({
    workerId: staff.id || null, workerPhone: from, workerName: staff.name || null,
    moduleId: mod.id, moduleTitle: mod.title.en, lang: quiz.lang,
    score: quiz.correct, outOf: questions.length, passed,
    completedAt: new Date().toISOString(),
  });
  await sendText(from, passed
    ? `🎓 *${mod.title[quiz.lang]}* — passed, ${quiz.correct}/${questions.length}. Recorded against your name — your manager can see it. Nice work, ${firstName(staff.name)}.`
    : `You scored ${quiz.correct}/${questions.length} — pass mark is ${mod.passMark}. Read the lessons again and retake any time: "train ${mod.id} ${quiz.lang}".`, sendOpts);
  return true;
}

function firstName(n) { return (n || "chef").split(" ")[0]; }

module.exports = { handleTrainCommand, handleTrainingReply };
