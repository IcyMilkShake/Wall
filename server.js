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
// ─── Step 2: Categorize topics + relationships ────────────────────────────────
async function categorizeTopics(text) {
  const response = await openai.chat.completions.create({
    model: "gpt-5.4-nano",
    max_completion_tokens: 6000,
    messages: [
      {
        role: "system",
        content: `You are a document understanding tool. Read the text and organize the key ideas into a clear 3-level tree that best helps someone understand the full topic.

Your goal is to cover the material properly without artificial limits:
- If there are many distinct important concepts, create more main cards (4, 5, 6+ is fine).
- If a main concept has many sub-topics, create as many sub cards as needed (15+ is okay if they are distinct and useful).
- If a sub needs many details, create as many detail cards as needed.

Do NOT force everything under few main cards. It is better to have more mains or more subs when the topic has many separate important parts.

Rules:
- Every card must add real value.
- Never repeat information.
- Keep the structure logical.
- Only create genuinely useful cards.

For each card return:
- level: "main", "sub", or "detail"
- type: short 1-word label (concept, process, example, warning, definition, fact, formula, etc.)
- title: 2-5 words, unique
- raw: 1-3 sentences. Use [[formula]]...[[/formula]] for any equations (with proper LaTeX inside).
- relatedTo: array with only the direct parent's title (empty for mains).

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
        model: "gpt-5.4-nano",
        max_completion_tokens: 250,
        messages: [
          {
            role: "system",
            content: `You explain things to someone with zero background knowledge.
Write exactly 2 plain English sentences.

CRITICAL INSTRUCTIONS:
- If the Context contains a [[formula]]...[[/formula]] block, you MUST copy that exact block (tags + LaTeX) into one of the sentences. Never rewrite or remove it.
- You may explain how to use the formula if it makes the explanation clearer.
- Keep everything to exactly 2 sentences. No extra text.

Example of good output for a quadratic formula card:
"The quadratic formula finds the solutions to any equation in the form ax² + bx + c = 0. Plug the coefficients into [[formula]]x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}[[/formula]] to get the two possible values of x."

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

// ─── Trim connections — keep only mutual links or top-3 per card ──────────────
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
    return { ...card, relatedTo: (card.relatedTo || []).filter(t => titleSet.has(t)).slice(0, 2) };
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
    res.json({ cards });
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
      model: "gpt-5.4-nano",
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