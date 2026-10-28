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

  const combinedContext = batchResults.map((r, i) =>
    `Batch ${i+1}: ${r.batchSummary}\nTopics: ${(r.keyTopics || []).join(", ")}\nRelationships: ${JSON.stringify(r.relationships || [])}`
  ).join("\n\n");

  const response = await openai.chat.completions.create({
    model: "gpt-6.1-sol",
    max_completion_tokens: complexity >= 4 ? 9000 : 6000,
    response_format: { type: "json_object" }, 
    messages: [
      {
        role: "system",
        content: buildMindmapInstructions(complexity)
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

// ─── Shared prompts

function buildMindmapInstructions(complexity = 3) {
  return `
You are an educational mindmap designer. Turn the provided learning material into a clear, accurate, well-connected mindmap that helps students understand and remember the subject.

Create focused cards rather than copying textbook paragraphs into a few large cards. Always create at least one main card.

COMPLEXITY
The requested complexity is ${complexity}/5.

1: Essential concepts and simple explanations of the fundamentals.
2: Core concepts and important supporting details.
3: Balanced coverage of concepts, explanations, and relationships.
4: Deeper coverage of important mechanisms, distinctions, and implications.
5: Thorough coverage of all important aspects supported by the source, including relevant concepts, distinctions, mechanisms, and relationships.

Higher complexity means broader and deeper coverage, not longer writing on every card. Never invent advanced information just to increase complexity, and do not interpret level 5 as literally covering every possible aspect of the subject.

CARD DESIGN
- Each card must focus on one central idea.
- Prefer multiple focused, connected cards over one card containing several independent ideas.
- Give each card enough explanation for a student to understand its idea without needing to open another card.
- As a flexible guide, many cards will be around 20–45 words, but this is not a word limit. Use fewer words for simple ideas and more when necessary for accurate understanding.
- Most cards should take 1–4 sentences. A complex idea may need more; do not force a sentence count.
- Split distinct concepts, mechanisms, stages, meaningful technical definitions, and examples into separate cards when each deserves independent treatment.
- Do not split a coherent explanation merely to meet a word count or create more cards.
- Avoid filler, long introductions, repeated information, and details that belong in another card.
- There is no fixed maximum number of cards. Cover all important source material at the requested complexity using focused cards and useful connections.
- Keep parent cards broad enough to introduce their branch; child cards should add information rather than repeat it.

CARD-DETAIL EXAMPLES
Too brief for a general learning mindmap:
Title: Acceleration
Raw: How quickly velocity changes over time.

Better:
Title: Acceleration
Raw: Acceleration describes how quickly an object's velocity changes over time. It can involve speeding up, slowing down, or changing direction. It is measured in metres per second squared (m/s²).

If the explanation also needs to cover Newton's Second Law, do not cram that separate idea into the same card:
- Acceleration: explain what acceleration means and how it can appear in motion.
- Acceleration Unit [type: definition]: explain the unit and what it measures.
- Force and Acceleration: explain how net force and mass affect acceleration.

These examples demonstrate the balance between useful explanation and focused cards. Adapt the structure to the actual source; do not copy these examples into unrelated subjects.

TECHNICAL DEFINITIONS
- When the material introduces a meaningful subject-specific technical term that a learner needs to understand, create a separate card defining it. Set type to "definition".
- Give the card a clear title using the term itself and explain it in plain, concise language.
- Connect the definition card to the concept where the term is used.
- Do not create definition cards for ordinary words or terms whose meaning is already fully explained by an existing definition card.
- A definition card's level indicates its place in the hierarchy; its type must remain "definition".

HIERARCHY
Every card must have a clear place in the mindmap.
- Main cards represent major topics or central branches and have no parent connection.
- Sub cards explain important concepts belonging to a main card. Every sub card must connect to its parent main card.
- Detail cards provide focused supporting information belonging to a sub card. Every detail card must connect to its parent sub card.
- Use only the levels "main", "sub", and "detail". Do not create extra hierarchy levels.
- Definition cards may be sub or detail cards depending on where they belong.
- Parent cards should introduce or summarize their branch. Child cards should add information rather than repeat it.

Example hierarchy:
Main: Forces and Motion
  Sub: Newton's Laws
    Detail: Newton's First Law
    Detail: Newton's Second Law
      Detail: Acceleration [type: definition]
      Detail: Net Force [type: definition]
  Sub: Types of Forces
    Detail: Friction
    Detail: Gravity

This is illustrative, not a required number of branches. Choose the structure that fits the source.

MEANINGFUL CONNECTIONS
Use relatedTo for the exact titles of parent cards and any useful cross-links.

Useful cross-links may show:
- Cause and effect.
- Prerequisites or concepts that help explain each other.
- Shared mechanisms.
- Meaningful comparisons.
- Dependencies between stages, components, or results.
- Applications of a principle.
- Part-whole relationships.

For example, Photosynthesis may connect to Cellular Respiration because of their relationship in energy and matter cycling. It may also connect to Light Source if that card exists, because light energy drives photosynthesis.

Do not link cards merely because they discuss the same broad subject. A cross-link should help the learner understand a meaningful relationship.
- Every sub card must include its parent main card.
- Every detail card must include its parent sub card.
- Additional cross-links are optional; include them only when useful.
- Avoid duplicate connections and self-connections.
- Do not add a main card as an extra parent to a detail card unless it is also a genuine, useful cross-link.

ADAPT TO THE MATERIAL
- Processes: represent meaningful stages as separate cards in logical order.
- Classifications: create cards for important categories.
- Comparisons: represent the concepts and their meaningful similarities or differences.
- Theories: include the theory, its major ideas, and important supporting concepts.
- Multiple topics: create distinct branches for distinct topics in the source.
- Do not force a process, comparison, or classification structure when the source does not call for one.

ACCURACY AND LANGUAGE
- Use the provided material as the factual basis. Add only straightforward explanations needed to make the material understandable.
- Do not invent facts, examples, claims, or relationships.
- Preserve important formulas, units, conditions, and distinctions.
- Use the same language as the source unless instructed otherwise.
- Use clear, natural language suitable for a student.
- Be concise without making explanations incomplete.
- If the source is unclear or missing information, do not present unsupported claims as fact.

OUTPUT
Return valid JSON in this structure:
{
  "cards": [
    {
      "level": "main | sub | detail",
      "type": "concept | definition | process | example | other suitable label",
      "title": "Short, specific title",
      "raw": "A clear explanation with enough detail to understand the idea",
      "relatedTo": []
    }
  ]
}

Use exactly "main", "sub", or "detail" for level.
Use meaningful type labels appropriate to each card's purpose.
Every response must contain at least one main card. Main cards must have an empty relatedTo array.
For every other card, relatedTo must contain the exact title of its parent card and any useful cross-linked cards.
Do not include markdown fences or commentary outside the JSON.
`;
}

// ─── Original categorizeTopics (long prompt untouched) ───────────────────────
async function categorizeTopics(text, complexity = 3) {

  const response = await openai.chat.completions.create({
    model: "gpt-6.1-sol",
    max_completion_tokens: complexity >= 4 ? 10000 : 6000,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: buildMindmapInstructions(complexity)
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
    1: `DEPTH 1: Include only the central idea. Use 1-2 short, simple sentences.`,
    2: `DEPTH 2: Include the central idea and one useful clarifying detail. Use 1-2 sentences.`,
    3: `DEPTH 3: Explain the central idea and its key supporting concept or distinction. Explain necessary technical terms in plain words. Use around 2-3 sentences.`,
    4: `DEPTH 4: Include depth 3 plus an important explanation of how, why, or under what conditions the idea works. Use around 2-4 sentences.`,
    5: `DEPTH 5: Give the fullest useful explanation of THIS card, including important mechanisms, conditions, and distinctions that belong to it. Stay concise; do not absorb other cards' content. Use around 3-5 sentences.`
  }[complexity] || `Explain the central idea clearly and preserve its important supporting details.`;

  // Give every summary call the same complete map context.
  // Keep original explanations so the model can distinguish overlapping topics.
  const mindmapContext = topics.map((card, index) => ({
    index,
    level: card.level || "sub",
    type: card.type || "concept",
    title: card.title || "Untitled",
    originalContent: card.raw || card.summary || "",
    relatedTo: Array.isArray(card.relatedTo) ? card.relatedTo : []
  }));

  const mapContextText = JSON.stringify(mindmapContext, null, 2);

  const summaries = await Promise.all(
    topics.map(async (topic, index) => {
      const originalRaw = topic.raw || topic.summary || "";
      const hasFormula = originalRaw.includes("[[formula]]");

      const response = await openai.chat.completions.create({
        model: "gpt-6.1-sol",
        max_completion_tokens: complexity >= 4 ? 700 : 450,
        messages: [
          {
            role: "system",
            content: `You are an educational mindmap editor. You receive the WHOLE mindmap so you can understand how every card fits together. You must rewrite ONLY the designated target card.

REQUESTED COMPLEXITY:
${summaryGuide}

COMPLEXITY IS CONCEPTUAL DEPTH:
- Complexity controls how much useful understanding this card contains, not how many unrelated topics it covers.
- At lower levels, preserve only the central idea and omit deeper details.
- At higher levels, explain more of the target idea's important meaning, conditions, mechanisms, or distinctions.
- Higher complexity must NOT cause this card to explain its children, siblings, or the entire subject.
- Use the requested level consistently. Do not default every level to the same generic summary.

CARD ROLES — FOLLOW THESE STRICTLY:

1. MAIN CARD:
- Introduce the overall subject and give the reader a brief mental picture of what it is about.
- Explain its general purpose, central theme, or why the subject matters, when supported by the source.
- If the subject is a theory or set of laws, briefly introduce what the theory or laws are intended to explain.
- Do NOT explain each child topic individually.
- Do NOT list or summarize all the subtopics that will be explained in separate cards.
- For example, a main card titled "Newton's Laws of Motion" should briefly introduce that these are laws describing how forces relate to motion. It should NOT explain Newton's First, Second, and Third Laws one by one.
- Keep the main card introductory and compact at every complexity level. More complexity may improve the introduction, but must not turn it into a summary of the entire mindmap.

2. SUB CARD:
- Explain the major idea represented by this branch.
- Include enough context to make the idea understandable on its own.
- Do NOT repeat the overall introduction from the main card.
- Do NOT explain all of its own child cards in detail.

3. DETAIL CARD:
- Explain the specific concept, term, mechanism, step, condition, or example named by this card.
- Be specific about that one idea rather than repeating the whole parent explanation.
- Include a definition or example only when relevant and supported by the source.

WHOLE-MINDMAP AWARENESS:
- Read the entire mindmap context before writing the target card.
- Identify the target card's parent, children, siblings, and related cards by their titles and relationships.
- Use this context to decide what belongs in this card and what should be explained elsewhere.
- The whole map is context for understanding, NOT content to copy into the target summary.
- Do not merge cards, rename them, create new cards, or change their relationships.
- Avoid duplication: each card should contribute distinct information to the overall mindmap.
- A parent can briefly introduce a concept that its children explain in depth, but it must not reproduce those explanations.
- Related cards may clarify the target's role, but do not pull their separate subject matter into this summary.
- If a card's original content contains information that clearly belongs to another card, prioritize the target card's own purpose and avoid duplicating the other card. Do not invent replacement facts.

SOURCE ACCURACY:
- Use the original content and full map as context. Do not invent facts, examples, or relationships.
- Preserve important conditions, distinctions, formulas, units, and steps that belong to the target card.
- If information is not supported by the source, leave it out.
- Do not silently change the meaning of the original material.
- Match the language of the source.

WRITING:
- Use simple, natural language suitable for a student with little background knowledge.
- Prefer common words and clear explanations over unnecessarily advanced vocabulary.
- Explain necessary technical terms in plain language when first introduced.
- Avoid filler, repeated points, and textbook-style paragraphs.
- Do not repeat the title as a needless opening.
- Do not force a sentence count if doing so makes the explanation unclear, but respect the intended depth.

FORMULAS:
- If the target card contains a [[formula]]...[[/formula]] block, copy that exact block into the output.
- Never remove or rewrite its LaTeX.
- Never replace a formula block with Unicode math symbols.

FINAL CHECK BEFORE ANSWERING:
1. Am I explaining only the target card?
2. Does the content match its main, sub, or detail role?
3. Am I repeating information that belongs in a child or sibling card?
4. Does the explanation match the requested complexity?
5. Did I preserve source-supported facts and formula blocks?

Return only the revised explanation. No title, label, quotation marks, or commentary.`
          },
          {
            role: "user",
            content: `WHOLE MINDMAP CONTEXT:
${mapContextText}

TARGET CARD INDEX: ${index}

TARGET CARD TO REWRITE:
Title: ${topic.title}
Level: ${topic.level || "sub"}
Type: ${topic.type || "concept"}
Original explanation:
${originalRaw}

Related card titles:
${Array.isArray(topic.relatedTo) ? topic.relatedTo.join(", ") : "none"}

Rewrite ONLY this target card. Use the whole map to understand its role, but do not summarize the other cards.`
          }
        ]
      });

      let summary = (response.choices[0].message.content || "").trim();

      if (!summary || (hasFormula && !summary.includes("[[formula]]"))) {
        summary = originalRaw;
      }

      return {
        level: topic.level || "sub",
        type: topic.type || "concept",
        title: topic.title || "Untitled",
        summary,
        relatedTo: Array.isArray(topic.relatedTo) ? topic.relatedTo : []
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