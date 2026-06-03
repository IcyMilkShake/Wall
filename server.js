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
    model: "gpt-4o-mini",
    max_tokens: 2500,
    messages: [
      {
        role: "system",
        content: `You are a document understanding tool. Read the text and extract 8-14 of the most important ideas. Organize them into a strict 3-level tree:

LEVELS:
- main: 1-2 cards. The single most important overarching concept in the document. Everything else branches from here.
- sub: 3-5 cards. Key ideas that directly branch from a main idea. Each sub card must have exactly one main card as its parent.
- detail: 4-7 cards. Specific facts, examples, or elaborations. Each detail card must have exactly one sub card as its parent.

For each card return:
- level: "main", "sub", or "detail"
- type: a short 1-word label for the kind of idea (e.g. concept, process, example, warning, definition, fact, cause, effect)
- title: 2-5 words, unique — used as the card ID in relatedTo
- raw: 1-2 sentences of key information from the source
- relatedTo: array containing ONLY the title of this card's direct parent. main cards have empty []. sub cards list their 1 parent main. detail cards list their 1 parent sub. Never link sideways or skip levels.

Return ONLY a valid JSON array. No markdown, no backticks, no preamble.

Example for a document about photosynthesis:
[
  {"level":"main","type":"concept","title":"Photosynthesis","raw":"Plants convert sunlight into glucose using water and CO2.","relatedTo":[]},
  {"level":"sub","type":"process","title":"Light Reactions","raw":"Chlorophyll absorbs sunlight and splits water molecules.","relatedTo":["Photosynthesis"]},
  {"level":"sub","type":"process","title":"Calvin Cycle","raw":"CO2 is fixed into glucose using ATP from light reactions.","relatedTo":["Photosynthesis"]},
  {"level":"detail","type":"fact","title":"Oxygen as Byproduct","raw":"Oxygen is released when water molecules are split.","relatedTo":["Light Reactions"]},
  {"level":"detail","type":"fact","title":"Glucose Storage","raw":"Glucose produced is stored as starch or used for energy.","relatedTo":["Calvin Cycle"]}
]`,
      },
      { role: "user", content: text.slice(0, 12000) },
    ],
  });

  const raw = response.choices[0].message.content.trim();
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

// ─── Step 3: Summarize each card in plain English ────────────────────────────
async function summarizeCards(topics) {
  const summaries = await Promise.all(
    topics.map(async (topic) => {
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        max_tokens: 200,
        messages: [
          {
            role: "system",
            content: `You explain things to someone with zero background knowledge.
Write exactly 2 plain English sentences about the topic below.
Be specific and concrete. No jargon. No markdown.
If the topic has related ideas listed, naturally weave in a brief mention of how it connects to one of them — but only if it fits the sentence naturally. Do not force it.
Return only the 2 sentences, nothing else.`,
          },
          {
            role: "user",
            content: `Topic: ${topic.title}\nContext: ${topic.raw}\nRelated to: ${(topic.relatedTo || []).join(', ') || 'none'}`,
          },
        ],
      });

      return {
        level: topic.level,
        type: topic.type,
        title: topic.title,
        summary: response.choices[0].message.content.trim(),
        relatedTo: (topic.relatedTo || []).slice(0, 2), // hard cap at 3
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
      model: "gpt-4o-mini",
      max_tokens: 400,
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