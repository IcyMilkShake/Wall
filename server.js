import express from "express";
import cors from "cors";
import multer from "multer";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ dest: "uploads/" });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "/")));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Step 1: Extract text from PDF ───────────────────────────────────────────
async function extractText(filePath) {
  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse(buffer);
  return data.text;
}

// ─── Step 2: Categorize topics + relationships ────────────────────────────────
async function categorizeTopics(text) {
  const response = await openai.chat.completions.create({
    model: "gpt-5.4-mini-2026-03-17",
    max_completion_tokens: 6000,
    messages: [
      {
        role: "system",
        content: `You are a document understanding tool. Read the text and organize the key ideas into a clear 3-level tree that best helps someone understand the full topic.

HARD LIMITS — non-negotiable:
- Maximum 3 main cards. If you produce 4 or more mains, you have failed.
- Every main MUST have at least 2 sub cards attached to it. A main with no subs is not allowed.
- If you feel the urge to make a 4th main, make it a sub of the closest existing main instead.
- Most of your cards should be subs and details, not mains.

Target structure:
- 2–3 main cards (the big themes)
- 2–5 sub cards per main (the key points under each theme)
- 1–3 detail cards per sub, only when a point genuinely needs elaboration
- Total: 10–20 cards is ideal. Hard cap at 25.

Other rules:
- Every card MUST add real value. Never repeat information.
- Keep titles short and clear (2–5 words).
- Use [[formula]]...[[/formula]] with proper LaTeX inside for any equations or formulas.
- relatedTo should contain the direct parent.
  You MAY also add other cards (from any branch) if they have a meaningful relationship that helps understanding.
  Do not add weak or unnecessary connections.

For each card return:
- level: "main", "sub", or "detail"
- type: short 1-word label (concept, process, example, warning, definition, fact, formula, etc.) according to the topic. Try not to create too many types as it may get confusing.
- title: 2-5 words, unique
- raw: 1-3 sentences. Use [[formula]]...[[/formula]] for any equations (with proper LaTeX inside).
- relatedTo: array of related card titles (can include the direct parent + other relevant cards from different branches).

Return ONLY a valid JSON array.`,
      },
      { role: "user", content: text.slice(0, 12000) },
    ],
  });

  // ... (keep your existing robust JSON cleaning + formula restoration code here)
  const raw = response.choices[0].message.content.trim();
  let cleaned = raw.replace(/```json|```/g, '').trim();

  const formulaBlocks = [];
  cleaned = cleaned.replace(/\[\[formula\]\]([\s\S]*?)\[\[\/formula\]\]/g, (_, inner) => {
    const normalized = inner.replace(/\\\\/g, '\\');
    formulaBlocks.push(normalized);
    return `__FORMULA_${formulaBlocks.length - 1}__`;
  });

  let topics;
  try {
    topics = JSON.parse(cleaned);
  } catch (e) {
    const safeJson = cleaned.replace(/"([^"]*)"/g, (m, inner) =>
      '"' + inner.replace(/(?<!\\)\\/g, '\\\\') + '"'
    );
    topics = JSON.parse(safeJson);
  }

  if (Array.isArray(topics)) {
    topics.forEach(card => {
      if (card?.raw?.includes('__FORMULA_')) {
        card.raw = card.raw.replace(/__FORMULA_(\d+)__/g, (_, idx) =>
          `[[formula]]${formulaBlocks[parseInt(idx)] || ''}[[/formula]]`
        );
      }
    });
  }
  return topics;
}
// ─── Step 3: Summarize each card in plain English ────────────────────────────
async function summarizeCards(topics) {
  const summaries = await Promise.all(
    topics.map(async (topic) => {
      const hasFormula = (topic.raw || '').includes('[[formula]]');

      const response = await openai.chat.completions.create({
        model: "gpt-5.4-mini-2026-03-17",
        max_completion_tokens: 250,
        messages: [
          {
            role: "system",
            content: `You explain things to someone with zero background knowledge.
Write exactly 2 plain English sentences.

CRITICAL INSTRUCTIONS:
- If the Context contains a [[formula]]...[[/formula]] block, you MUST copy that exact block (including the [[formula]] and [[/formula]] tags) into one of your sentences. Never remove it or rewrite the LaTeX.
- Never output Unicode math symbols (like α, β, ∣0⟩, etc.). Always keep the original [[formula]] block.
- You may explain how to use the formula if it makes the explanation clearer.
- Keep everything to exactly 2 sentences. No extra text.

Example of good output:
"The qubit can be in a superposition of both states at once. This is written as [[formula]]\\alpha |0\\rangle + \\beta |1\\rangle[[/formula]] and the values of alpha and beta represent the probabilities."

Return only the two sentences.`,
          },
          {
            role: "user",
            content: `Topic: ${topic.title}\nContext: ${topic.raw}\nRelated to: ${Array.isArray(topic.relatedTo) ? topic.relatedTo.join(', ') : 'none'}`,
          },
        ],
      });

      let summary = response.choices[0].message.content.trim();

      if (hasFormula && !summary.includes('[[formula]]')) {
        summary = topic.raw;
      }

      return {
        level: topic.level,
        type: topic.type,
        title: topic.title,
        summary,
        relatedTo: Array.isArray(topic.relatedTo) ? topic.relatedTo.slice(0, 2) : [],
      };
    })
  );

  return summaries;
}


function trimConnections(cards) {
  const titleSet = new Set(cards.map(c => c.title));
  const byTitle = Object.fromEntries(cards.map(c => [c.title, c]));

  return cards.map(card => {
    // main cards have no parent
    if (card.level === 'main') return { ...card, relatedTo: [] };

    // sub cards must link to exactly one main card
    if (card.level === 'sub') {
      const parent = (card.relatedTo || []).find(t => titleSet.has(t) && byTitle[t]?.level === 'main');
      return { ...card, relatedTo: parent ? [parent] : [] };
    }

    // detail cards must link to exactly one sub card
    if (card.level === 'detail') {
      const parent = (card.relatedTo || []).find(t => titleSet.has(t) && byTitle[t]?.level === 'sub');
      return { ...card, relatedTo: parent ? [parent] : [] };
    }

    // fallback
    return { ...card, relatedTo: (card.relatedTo || []).filter(t => titleSet.has(t)).slice(0, 4) };
  });
}


// ─── Route: Upload PDF ────────────────────────────────────────────────────────
app.post("/api/upload", upload.single("pdf"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  try {
    const text = await extractText(req.file.path);
    if (!text || text.trim().length < 100)
      return res.status(400).json({ error: "Could not extract text from PDF" });
    const topics = await categorizeTopics(text);
    const cards = trimConnections(await summarizeCards(topics));
    fs.unlinkSync(req.file.path);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Pipeline failed: " + err.message });
  }
});

// ─── Route: Generate from text ────────────────────────────────────────────────
app.post("/api/generate", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "No text provided" });
  try {
    const topics = await categorizeTopics(text);
    const cards = trimConnections(await summarizeCards(topics));
    res.json({ cards });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Pipeline failed: " + err.message });
  }
});

// ─── Route: Explain a card deeper ────────────────────────────────────────────
app.post("/api/explain", async (req, res) => {
  const { title, summary } = req.body;
  if (!title) return res.status(400).json({ error: "No title provided" });
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-5.4-mini-2026-03-17",
      max_completion_tokens: 400,
      messages: [
        {
          role: "system",
          content: `Explain the topic to someone with zero background knowledge.
Use a real-world analogy. Be conversational, clear, and specific.
Keep it to 3-4 short paragraphs. No markdown, no bullet points.`,
        },
        { role: "user", content: `Explain: ${title}\nContext: ${summary}` },
      ],
    });
    res.json({ explanation: response.choices[0].message.content.trim() });
  } catch (err) {
    res.status(500).json({ error: "Explain failed: " + err.message });
  }
});

const PORT = 8082;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));