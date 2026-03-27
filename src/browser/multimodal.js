'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const OPENAI_URL = process.env.OPENAI_URL || 'https://api.openai.com/v1/responses';
const VISION_MODEL = process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || 'gpt-5-mini';
const POST_VISION_DIR = path.join(__dirname, '..', '..', 'logs', 'post_vision');

function normalizeText(text = '') {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function uniqueStrings(values = []) {
  const seen = new Set();
  const items = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push(normalized);
  }
  return items;
}

function detectLeadSignals(text = '') {
  const normalized = String(text || '').toLowerCase();
  const signals = [];
  const rules = [
    ['reimbursement', /\breimburse(?:ment|ments)?\b/],
    ['lost inventory', /\blost inventory\b|\binventory loss\b/],
    ['missing units', /\bmissing units?\b|\breceived less than shipped\b|\bchecked in fewer units\b|\breceived \d+ out of \d+\b/],
    ['inventory discrepancy', /\binventory discrepanc(?:y|ies)\b|\breceiving discrepanc(?:y|ies)\b/],
    ['high fees', /\bfees?\s+(?:are\s+)?too high\b|\bfee error\b|\bovercharging fees\b|\bfees are killing\b/],
    ['settlement confusion', /\bsettlement\b.*\b(confus|wrong|low|off|understand)\b|\bunderstand this settlement report\b/],
    ['payout confusion', /\bpayout\b.*\b(low|wrong|off|confus|expected)\b|\bpayout seems low\b/],
    ['profit leakage', /\blow profit\b|\bprofit leak(?:age)?\b|\bmargins?\s+(?:dropped|low|lower)\b|\bmoney is disappearing\b/],
    ['return losses', /\breturn(?:s)?\b.*\b(loss|profit|fee)\b/],
    ['amazon dashboard screenshot', /\bseller central\b|\bsettlement report\b|\bmanage fba inventory\b|\bfee preview\b|\breimbursements?\b/],
  ];

  for (const [label, pattern] of rules) {
    if (pattern.test(normalized)) {
      signals.push(label);
    }
  }

  return uniqueStrings(signals);
}

function mergePostReading({
  author = '',
  textFromDom = '',
  textFromVisibleFallback = '',
  textFromImages = '',
  visualSummary = '',
  attachedImagesCount = 0,
  existingSignals = [],
} = {}) {
  const mergedSignals = uniqueStrings([
    ...existingSignals,
    ...detectLeadSignals([
      textFromDom,
      textFromVisibleFallback,
      textFromImages,
      visualSummary,
    ].filter(Boolean).join('\n')),
  ]);

  const mergedText = uniqueStrings([
    textFromDom,
    textFromVisibleFallback,
    textFromImages,
    visualSummary,
  ]).join('\n').trim();

  const domLen = normalizeText(textFromDom).length;
  const fallbackLen = normalizeText(textFromVisibleFallback).length;
  const imageLen = normalizeText(textFromImages).length;
  const summaryLen = normalizeText(visualSummary).length;

  let confidenceScore = 0.2;
  if (domLen >= 40) {
    confidenceScore = 0.95;
  } else if (fallbackLen >= 40) {
    confidenceScore = 0.8;
  } else if (imageLen >= 20 || summaryLen >= 20) {
    confidenceScore = 0.72;
  } else if (attachedImagesCount > 0 || mergedSignals.length > 0) {
    confidenceScore = 0.6;
  } else if (mergedText.length >= 12) {
    confidenceScore = 0.5;
  }

  return {
    author: normalizeText(author),
    text_from_dom: normalizeText(textFromDom),
    text_from_visible_fallback: normalizeText(textFromVisibleFallback),
    text_from_images: normalizeText(textFromImages),
    visual_summary: normalizeText(visualSummary),
    merged_text: mergedText,
    confidence_score: Number(confidenceScore.toFixed(2)),
    lead_signals_matched: mergedSignals,
  };
}

async function ensureVisionDir() {
  await fs.mkdir(POST_VISION_DIR, { recursive: true });
}

async function imagePathToDataUrl(imagePath = '') {
  const buffer = await fs.readFile(imagePath);
  const ext = path.extname(imagePath).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg'
    ? 'image/jpeg'
    : ext === '.webp'
      ? 'image/webp'
      : 'image/png';
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

function parseJsonObject(raw = '') {
  const text = String(raw || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const match = candidate.match(/\{[\s\S]*\}/);
  if (!match) {
    return null;
  }
  try {
    return JSON.parse(match[0]);
  } catch (_error) {
    try {
      return JSON.parse(match[0].replace(/'/g, '"'));
    } catch (_secondError) {
      return null;
    }
  }
}

async function analyzeImageWithVision(imagePath = '', prompt = '') {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !imagePath) {
    return {
      used: false,
      text: '',
      summary: '',
      signals: [],
      confidence: 0,
      reason: apiKey ? 'missing_image_path' : 'openai_api_key_missing',
    };
  }

  try {
    const imageUrl = await imagePathToDataUrl(imagePath);
    const response = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: prompt || 'Read this social media post screenshot. Extract visible text, summarize the post, and identify Amazon seller money-loss signals.',
              },
              {
                type: 'input_image',
                image_url: imageUrl,
              },
            ],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'post_vision_analysis',
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                extracted_text: { type: 'string' },
                visual_summary: { type: 'string' },
                lead_signals: {
                  type: 'array',
                  items: { type: 'string' },
                },
                confidence: { type: 'number' },
              },
              required: ['extracted_text', 'visual_summary', 'lead_signals', 'confidence'],
            },
          },
        },
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        used: false,
        text: '',
        summary: '',
        signals: [],
        confidence: 0,
        reason: data?.error?.message || `vision_http_${response.status}`,
      };
    }

    const outputText = Array.isArray(data?.output)
      ? data.output
          .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
          .map((item) => item?.text || item?.output_text || '')
          .join('\n')
      : '';
    const parsed = parseJsonObject(outputText) || {};
    return {
      used: true,
      text: normalizeText(parsed.extracted_text || ''),
      summary: normalizeText(parsed.visual_summary || ''),
      signals: uniqueStrings(Array.isArray(parsed.lead_signals) ? parsed.lead_signals : []),
      confidence: Number(parsed.confidence || 0) || 0.6,
      reason: '',
    };
  } catch (error) {
    return {
      used: false,
      text: '',
      summary: '',
      signals: [],
      confidence: 0,
      reason: error.message,
    };
  }
}

function buildVisionFilePath(prefix = 'post', extension = '.png') {
  return path.join(POST_VISION_DIR, `${prefix}_${Date.now()}_${crypto.randomUUID()}${extension}`);
}

module.exports = {
  POST_VISION_DIR,
  analyzeImageWithVision,
  buildVisionFilePath,
  detectLeadSignals,
  ensureVisionDir,
  mergePostReading,
  normalizeText,
  uniqueStrings,
};
