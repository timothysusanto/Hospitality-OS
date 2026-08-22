"use strict";

/**
 * trainingContent.js — Micro-training modules delivered over WhatsApp
 * (Hospitality Edition, Core OS Phase 3).
 *
 * Module 1: Food Safety Basics, in the three most common language needs of
 * an Australian kitchen crew — English, Nepali, Simplified Chinese.
 * Lessons are deliberately short (one WhatsApp message each); the quiz is
 * three questions, pass mark 2. Completion is recorded per worker and shows
 * in their credential wallet.
 *
 * IMPORTANT: translations here are working drafts written for clarity, and
 * should be reviewed by a native speaker before being relied on for formal
 * compliance training — the point of v1 is the delivery rail, not certified
 * courseware.
 */

const MODULES = {
  1: {
    id: 1,
    title: { en: "Food Safety Basics", ne: "खाद्य सुरक्षा आधारभूत", zh: "食品安全基础" },
    passMark: 2,
    lessons: {
      en: [
        "📖 *Food Safety Basics — 1/3: The danger zone*\nBacteria grow fastest between 5°C and 60°C. Keep cold food at 5°C or below, hot food at 60°C or above. Food left in the danger zone for more than 2 hours must be used immediately or thrown out; more than 4 hours — always thrown out.",
        "📖 *2/3: Clean hands, clean surfaces*\nWash hands with soap for 20 seconds: before starting work, after the toilet, after raw meat, after bins or your phone. Sanitise benches and boards between raw and ready-to-eat foods. Never use the same board for raw chicken and salad.",
        "📖 *3/3: Allergens can kill*\nThe big ones: peanuts, tree nuts, egg, milk, fish, shellfish, soy, sesame, gluten, lupin. Never guess — if a customer asks about allergens, check with the chef or the recipe card. A 'tiny bit' can put someone in hospital. When in doubt, say so and check.",
      ],
      ne: [
        "📖 *खाद्य सुरक्षा — १/३: खतरा क्षेत्र (Danger Zone)*\nब्याक्टेरिया ५°C देखि ६०°C बीचमा सबैभन्दा छिटो बढ्छ। चिसो खाना ५°C वा कममा, तातो खाना ६०°C वा बढीमा राख्नुहोस्। खाना २ घण्टाभन्दा बढी खतरा क्षेत्रमा बस्यो भने तुरुन्तै प्रयोग गर्नुहोस् वा फाल्नुहोस्; ४ घण्टाभन्दा बढी भए — सधैं फाल्नुहोस्।",
        "📖 *२/३: सफा हात, सफा सतह*\nसाबुनले २० सेकेन्ड हात धुनुहोस्: काम सुरु गर्नुअघि, शौचालयपछि, काँचो मासु छोएपछि, फोहोर वा मोबाइल छोएपछि। काँचो र पकाएको खानाबीच बेन्च र चपिङ बोर्ड सेनिटाइज गर्नुहोस्। काँचो कुखुरा र सलादका लागि कहिल्यै एउटै बोर्ड प्रयोग नगर्नुहोस्।",
        "📖 *३/३: एलर्जीले ज्यान लिन सक्छ*\nमुख्य एलर्जेन: बदाम, रुखका नट, अण्डा, दूध, माछा, शेलफिस, सोया, तिल, ग्लुटेन, लुपिन। कहिल्यै अनुमान नगर्नुहोस् — ग्राहकले एलर्जेनबारे सोधे शेफ वा रेसिपी कार्डमा जाँच गर्नुहोस्। 'थोरै मात्र' ले पनि कसैलाई अस्पताल पुर्‍याउन सक्छ। शंका लागे भन्नुहोस् र जाँच गर्नुहोस्।",
      ],
      zh: [
        "📖 *食品安全基础 — 1/3：危险温度区*\n细菌在5°C到60°C之间繁殖最快。冷食保持在5°C或以下，热食保持在60°C或以上。食物在危险区超过2小时必须立即使用或丢弃；超过4小时——一律丢弃。",
        "📖 *2/3：清洁双手，清洁台面*\n用肥皂洗手20秒：开工前、上厕所后、接触生肉后、碰过垃圾桶或手机后。在处理生食和即食食品之间要对台面和砧板消毒。切生鸡肉的砧板绝不能用来切沙拉。",
        "📖 *3/3：过敏原可能致命*\n主要过敏原：花生、坚果、鸡蛋、牛奶、鱼、贝类、大豆、芝麻、麸质、羽扇豆。绝不要凭猜测——客人询问过敏原时，向厨师核实或查配方卡。'一点点'也可能让人进医院。有疑问就说明并核实。",
      ],
    },
    quiz: {
      en: [
        { q: "Cold food must be kept at:", a: "5°C or below", b: "10°C or below", c: "Room temperature", correct: "a" },
        { q: "Food left in the danger zone for more than 4 hours:", a: "Reheat it and serve", b: "Always throw it out", c: "Refrigerate it quickly", correct: "b" },
        { q: "A customer asks if a dish contains sesame. You're not sure. You:", a: "Say no — it probably doesn't", b: "Say yes to be safe", c: "Check with the chef or recipe card before answering", correct: "c" },
      ],
      ne: [
        { q: "चिसो खाना कति तापक्रममा राख्नुपर्छ?", a: "५°C वा कम", b: "१०°C वा कम", c: "कोठाको तापक्रम", correct: "a" },
        { q: "खाना ४ घण्टाभन्दा बढी खतरा क्षेत्रमा बस्यो भने:", a: "फेरि तताएर दिने", b: "सधैं फाल्ने", c: "छिटो फ्रिजमा राख्ने", correct: "b" },
        { q: "ग्राहकले खानामा तिल छ कि छैन सोध्नुभयो, तपाईंलाई थाहा छैन। के गर्नुहुन्छ?", a: "छैन होला भन्ने", b: "सुरक्षित हुन 'छ' भन्ने", c: "जवाफ दिनुअघि शेफ वा रेसिपी कार्डमा जाँच गर्ने", correct: "c" },
      ],
      zh: [
        { q: "冷食必须保持在：", a: "5°C或以下", b: "10°C或以下", c: "室温", correct: "a" },
        { q: "食物在危险温度区超过4小时：", a: "重新加热后出餐", b: "一律丢弃", c: "赶快放进冰箱", correct: "b" },
        { q: "客人问菜里有没有芝麻，你不确定。你应该：", a: "说没有——大概没有", b: "为保险起见说有", c: "先向厨师或配方卡核实再回答", correct: "c" },
      ],
    },
  },
};

const LANGS = { en: "English", ne: "नेपाली", zh: "中文" };

module.exports = { MODULES, LANGS };
