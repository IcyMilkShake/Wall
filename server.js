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

// ─── Step 2: Categorize topics ───────────────────────────────────────────────
async function categorizeTopics(text) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 2000,
    messages: [
      {
        role: "system",
        content: `You are a document understanding tool. Read the text and extract 8-14 of the most important ideas.

For each idea return:
- type: one of: concept, definition, example, warning, quote
- title: 2-5 words, unique
- raw: the key information about this idea in 1-2 sentences from the source

Aim for: 3-4 concepts, 2-3 definitions, 2-3 examples, 1-2 warnings, 1 quote.

Return ONLY a valid JSON array. No markdown, no backticks, no preamble.

Example:
[{"type":"concept","title":"Greenhouse effect","raw":"Gases trap heat in the atmosphere, warming the planet."}]`,
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
Return only the 2 sentences, nothing else.`,
          },
          {
            role: "user",
            content: `Topic: ${topic.title}\nContext: ${topic.raw}`,
          },
        ],
      });

      return {
        type: topic.type,
        title: topic.title,
        summary: response.choices[0].message.content.trim(),
      };
    })
  );

  return summaries;
}

// ─── Route: Upload PDF ────────────────────────────────────────────────────────
app.post("/api/upload", upload.single("pdf"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  try {
    // Step 1: extract
    const text = await extractText(req.file.path);
    if (!text || text.trim().length < 100) {
      return res.status(400).json({ error: "Could not extract text from PDF" });
    }

    // Step 2: categorize
    const topics = await categorizeTopics(text);

    // Step 3: summarize
    const cards = await summarizeCards(topics);

    // Clean up uploaded file
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
    const cards = await summarizeCards(topics);
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
        {
          role: "user",
          content: `Explain: ${title}\nContext: ${summary}`,
        },
      ],
    });

    res.json({ explanation: response.choices[0].message.content.trim() });
  } catch (err) {
    res.status(500).json({ error: "Explain failed: " + err.message });
  }
});

const PORT = 8082;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));