import express from "express";
import cors from "cors";
import multer from "multer";
import sharp from 'sharp';
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

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";

// pdfjs expects these browser globals even when you pass your own canvas
globalThis.DOMMatrix = DOMMatrix;
globalThis.ImageData = ImageData;
globalThis.Path2D = Path2D;
async function convertPdfToImages(filePath) {
  const pdfBuffer = fs.readFileSync(filePath);

  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer),
    cMapUrl: "https://unpkg.com/pdfjs-dist@4.10.38/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "https://unpkg.com/pdfjs-dist@4.10.38/standard_fonts/",
    disableWorker: true,
    isEvalSupported: false,
  }).promise;

  const images = [];
  const maxPages = 50;
  const pageCount = Math.min(pdf.numPages, maxPages);

  for (let i = 1; i <= pageCount; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1.5 });

    const canvas = createCanvas(viewport.width, viewport.height);
    const context = canvas.getContext("2d");

    await page.render({
      canvasContext: context,
      viewport,
    }).promise;

    // Shrink before the vision call so base64 payloads stay reasonable
    const png = await sharp(canvas.toBuffer("image/png"))
      .resize({ width: 1280, withoutEnlargement: true })
      .png({ compressionLevel: 8 })
      .toBuffer();

    images.push(png);
    page.cleanup();
  }

  return images;
}

async function analyzeBatchWithVision(imageBuffers, batchIndex, totalBatches) {
  const imageContents = imageBuffers.map(buffer => ({
    type: "image_url",
    image_url: { url: `data:image/png;base64,${buffer.toString("base64")}` }
  }));

  const response = await openai.chat.completions.create({
    model: "gpt-5.4-mini-2026-03-17",
    max_completion_tokens: 4000,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are analyzing batch ${batchIndex + 1} of ${totalBatches} from a slide deck. Return JSON with batchSummary, keyTopics, and relationships.`
      },
      {
        role: "user",
        content: [
          { type: "text", text: `Batch ${batchIndex + 1}/${totalBatches}` },
          ...imageContents
        ]
      }
    ]
  });

  try {
    return JSON.parse(response.choices[0].message.content);
  } catch {
    return { batchSummary: "", keyTopics: [], relationships: [] };
  }
}

async function synthesizeDeckAnalysis(batchResults, complexity) {
  const limits = {
    1: { min: 5, max: 8 },
    2: { min: 8, max: 14 },
    3: { min: 14, max: 20 },
    4: { min: 20, max: 30 },
    5: { min: 30, max: 55 }
  };
  const { min: minCards, max: maxCards } = limits[complexity] || limits[3];

  const combinedContext = batchResults.map((r, i) =>
    `Batch ${i+1}: ${r.batchSummary}\nTopics: ${(r.keyTopics || []).join(", ")}\nRelationships: ${JSON.stringify(r.relationships || [])}`
  ).join("\n\n");

  const response = await openai.chat.completions.create({
    model: "gpt-5.4-mini-2026-03-17",
    max_completion_tokens: complexity >= 4 ? 9000 : 6000,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are a strict document-to-card converter.

CRITICAL CARD COUNT RULE (NON-NEGOTIABLE):
You MUST output between ${minCards} and ${maxCards} cards in total for complexity level ${complexity}.

STRICT RULES:
- Most of your cards should be "sub" and "detail" level. Keep the number of "main" cards low.
- Every card MUST add real value. Never repeat information.
- Use [[formula]]...[[/formula]] with proper LaTeX inside for any equations or formulas.
- relatedTo rules:
  - "main" cards have no relatedTo.
  - "sub" cards must include their parent main in relatedTo.
  - "detail" cards must include their parent "sub" in relatedTo.
- Create cards that show how different parts of the deck relate to each other.

Return ONLY a valid JSON object with this exact structure:
{ "cards": [ array of card objects ] }

Each card object must have:
- level: "main", "sub", or "detail"
- type: short 1-word label, create types that correspond to the content. Avoid creating too many types. Increase its amount by little as complexity increases (1-7 types max).
- title: 2-5 words
- raw: 1-3 sentences (use [[formula]]...[[/formula]] for equations)
- relatedTo: array of related card titles`
      },
      { role: "user", content: `Full deck analysis:\n\n${combinedContext}\n\nGenerate the final cards now.` }
    ]
  });

  try {
    const parsed = JSON.parse(response.choices[0].message.content.replace(/```json|```/g, '').trim());
    return Array.isArray(parsed) ? parsed : (parsed.cards || []);
  } catch {
    return [];
  }
}

// ─── Original categorizeTopics (long prompt untouched) ───────────────────────
async function categorizeTopics(text, complexity = 3) {

  const limits = {
    1: { min: 4,  max: 8 },
    2: { min: 8,  max: 12 },
    3: { min: 12, max: 16 },
    4: { min: 16, max: 24 },
    5: { min: 24, max: 55 }
  };

  const { min: minCards, max: maxCards } = limits[complexity] || limits[3];

  const response = await openai.chat.completions.create({
    model: "gpt-5.4-mini-2026-03-17",
    max_completion_tokens: complexity >= 4 ? 10000 : 6000,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are a strict document-to-card converter.

CRITICAL CARD COUNT RULE (NON-NEGOTIABLE):
You MUST output between ${minCards} and ${maxCards} cards in total for complexity level ${complexity}.
This limit is absolute and non-negotiable.
- If the content seems rich, you MUST consolidate information into fewer cards. Do NOT exceed ${maxCards} cards.
- If the content seems sparse, you MUST still reach at least ${minCards} cards by creating appropriate sub and detail cards.
- Before outputting, count your cards. If outside the range, adjust by removing or adding cards until it fits.

STRICT RULES:
- Most of your cards should be "sub" and "detail" level. Keep the number of "main" cards low.
- Every card MUST add real value. Never repeat information.
- When using technical terms, explain them.
- Keep titles short and clear (2–5 words).
- Use [[formula]]...[[/formula]] with proper LaTeX inside for any equations or formulas.
- relatedTo rules:
  - "main" cards have no relatedTo.
  - "sub" cards must include their parent main in relatedTo. They can also link to 1-2 other relevant "sub" or "detail" cards from different branches.
  - "detail" cards must include their parent "sub" in relatedTo. They should NOT link directly to "main" cards. They can link to 1-2 other relevant "detail" or "sub" cards.
- If the topic involves a process or sequence, create one main card titled "How It Works" (or similar). Its sub cards should be steps in order ("Step 1: ...", etc.).
- When a card covers something with multiple parts, each part MUST get its own sub or detail card.
- Choose the language based on the input text.

Return ONLY a valid JSON object with this exact structure:
{
  "cards": [ array of card objects ]
}

Each card object must have:
- level: "main", "sub", or "detail"
- type: short 1-word label. Do not try to create too many types as it may get confusing.
- title: 2-5 words
- raw: 1-3 sentences (use [[formula]]...[[/formula]] for equations)
- relatedTo: array of related card titles`
      },
      { role: "user", content: text.slice(0, 12000) },
    ],
  });

  const raw = response.choices[0].message.content.trim();
  let cleaned = raw.replace(/```json|```/g, '').trim();

  const formulaBlocks = [];
  cleaned = cleaned.replace(/\[\[formula\]\]([\s\S]*?)\[\[\/formula\]\]/g, (_, inner) => {
    const normalized = inner.replace(/\\\\/g, '\\');
    formulaBlocks.push(normalized);
    return `__FORMULA_${formulaBlocks.length - 1}__`;
  });

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    const safeJson = cleaned.replace(/"([^"]*)"/g, (m, inner) =>
      '"' + inner.replace(/(?<!\\)\\/g, '\\\\') + '"'
    );
    parsed = JSON.parse(safeJson);
  }

  let topics = Array.isArray(parsed) ? parsed : (parsed.cards || []);

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

// ─── summarizeCards, trimConnections, enforceCardLimits (original) ───────────
async function summarizeCards(topics, complexity = 3) {
  const summaryGuide = {
    1: `Write 1-2 very plain sentences. Strip away all jargon. Absolute beginner level.`,
    2: `Write 2 plain English sentences. Simple and clear, no jargon without explanation.`,
    3: `Write 2-3 sentences. Cover the main idea and key parts. Include named components if there are multiple.`,
    4: `Write 3 sentences. Be thorough — cover the main idea, important parts, how they relate, and why they matter.`,
    5: `Write 3-4 sentences. Cover all named parts, how they relate, and key relationships. Be clear and reasonably detailed.`,
  }[complexity] || `Write 2 plain English sentences.`;

  const summaries = await Promise.all(
    topics.map(async (topic) => {
      const hasFormula = (topic.raw || '').includes('[[formula]]');

      const response = await openai.chat.completions.create({
        model: "gpt-5.4-mini-2026-03-17",
        max_completion_tokens: complexity >= 4 ? 400 : 250,
        messages: [
          {
            role: "system",
            content: `You explain things to someone with zero background knowledge.
${summaryGuide}

CRITICAL INSTRUCTIONS:
- If the Context contains a [[formula]]...[[/formula]] block, you MUST copy that exact block (including the [[formula]] and [[/formula]] tags) into one of your sentences. Never remove it or rewrite the LaTeX.
- Never output Unicode math symbols (like α, β, ∣0⟩, etc.). Always keep the original [[formula]] block.
- Choose the language of the output based on the Context. If the Context is in English, write in English. If it's in another language, match that language. Do not use English if the Context is not in English.

Example of good output:
"The qubit can be in a superposition of both states at once. This is written as [[formula]]\\alpha |0\\rangle + \\beta |1\\rangle[[/formula]] and the values of alpha and beta represent the probabilities."

Return only the sentences, no extra text.`,
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
    if (card.level === 'main') return { ...card, relatedTo: [] };

    if (card.level === 'sub') {
      const parentMain = (card.relatedTo || []).find(t => titleSet.has(t) && byTitle[t]?.level === 'main');
      const crossLinks = (card.relatedTo || []).filter(t =>
        titleSet.has(t) &&
        t !== parentMain &&
        byTitle[t]?.level === 'sub' &&
        byTitle[t]?.relatedTo?.[0] !== parentMain
      ).slice(0, 2);

      return { ...card, relatedTo: parentMain ? [parentMain, ...crossLinks] : crossLinks };
    }

    if (card.level === 'detail') {
      const parentSub = (card.relatedTo || []).find(t => titleSet.has(t) && byTitle[t]?.level === 'sub');
      const crossLinks = (card.relatedTo || []).filter(t =>
        titleSet.has(t) &&
        t !== parentSub &&
        (byTitle[t]?.level === 'detail' || byTitle[t]?.level === 'sub')
      ).slice(0, 2);

      return { ...card, relatedTo: parentSub ? [parentSub, ...crossLinks] : crossLinks };
    }

    return { ...card, relatedTo: (card.relatedTo || []).filter(t => titleSet.has(t)).slice(0, 4) };
  });
}

function enforceCardLimits(cards, complexity) {
  const limits = {
    1: { min: 5, max: 8 },
    2: { min: 8, max: 14 },
    3: { min: 14, max: 20 },
    4: { min: 20, max: 30 },
    5: { min: 30, max: 55 }
  };

  const { min, max } = limits[complexity] || limits[3];

  if (cards.length <= max) return cards;

  const mains = cards.filter(c => c.level === 'main');
  const subs = cards.filter(c => c.level === 'sub');
  const details = cards.filter(c => c.level === 'detail');

  let result = [...mains, ...subs];

  for (const d of details) {
    if (result.length >= max) break;
    result.push(d);
  }

  return result.slice(0, max);
}

// ─── Upload Route (Visual) ───────────────────────────────────────────────────
app.post("/api/upload", upload.single("pdf"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const complexity = Math.round(parseFloat(req.body.complexity) || 2);

  try {
    const images = await convertPdfToImages(req.file.path);
    fs.unlinkSync(req.file.path);

    if (images.length === 0) {
      return res.status(400).json({ error: "Could not convert this PDF to images." });
    }

    const BATCH_SIZE = 9;
    const batches = [];
    for (let i = 0; i < images.length; i += BATCH_SIZE) {
      batches.push(images.slice(i, i + BATCH_SIZE));
    }

    const batchResults = [];
    for (let i = 0; i < batches.length; i++) {
      const result = await analyzeBatchWithVision(batches[i], i, batches.length);
      batchResults.push(result);
    }

  let cards = await synthesizeDeckAnalysis(batchResults, complexity);

  if (!cards || cards.length === 0) {
    return res.status(500).json({ error: "The AI couldn't generate cards from this PDF." });
  }

  cards = cards.map(card => ({
    level: card.level || "sub",
    type: card.type || "Topic",
    title: card.title || "Untitled",
    raw: card.raw || card.summary || "",
    summary: card.summary || card.raw || "",
    relatedTo: Array.isArray(card.relatedTo) ? card.relatedTo : [],
  }));

  cards = await summarizeCards(cards, complexity);
  cards = enforceCardLimits(cards, complexity);
  cards = trimConnections(cards);

  res.json({ cards });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to analyze the PDF visually." });
  }
});

// ─── Generate from text (unchanged) ──────────────────────────────────────────
app.post("/api/generate", async (req, res) => {
  const { text, complexity = 2 } = req.body;
  const level = Math.round(complexity);
  if (!text) return res.status(400).json({ error: "No text provided" });
  try {
    const topics = await categorizeTopics(text, level);
    let cards = await summarizeCards(topics, level);
    cards = enforceCardLimits(cards, level);
    cards = trimConnections(cards);
    res.json({ cards });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Pipeline failed: " + err.message });
  }
});

// ─── Explain ─────────────────────────────────────────────────────────────────
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

const PORT = 8080;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));