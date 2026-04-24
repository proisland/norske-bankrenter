#!/usr/bin/env node
'use strict';

/**
 * fetch-rates.js
 *
 * Called by GitHub Actions daily. Uses Claude API with web search to fetch
 * current Norwegian mortgage, car-loan, and student-loan rates, then writes
 * the result to data/rates.json. The Homey app fetches this file via raw
 * GitHub URL.
 *
 * Requires env var ANTHROPIC_API_KEY.
 */

const fs   = require('fs');
const path = require('path');

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL   = 'claude-sonnet-4-5';
const OUTFILE = path.join(__dirname, '..', 'data', 'rates.json');

const BANKS_MORTGAGE = [
  'Bulder Bank', 'Heder Bank', 'Landkreditt Bank', 'Handelsbanken',
  'Storebrand Bank', 'Rogaland Sparebank', 'Sandnes Sparebank',
  'Sparebanken Vest', 'SpareBank 1 SR-Bank', 'Sbanken (DNB)',
  'KLP Banken', 'Nordea', 'SpareBank 1 Østlandet', 'SpareBank 1 SMN',
  'SpareBank 1 BV', 'Sparebanken Sør', 'Sparebanken Møre', 'DNB',
  'Instabank', 'Sparebank 1 Nord-Norge', 'Spareskillingsbanken',
  'BN Bank', 'Cultura Bank', 'Komplett Bank', 'Bank Norwegian',
  'Santander Consumer Bank', 'Monobank',
];

async function askClaude(prompt, maxTokens = 2048) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY missing');

  const body = {
    model:      MODEL,
    max_tokens: maxTokens,
    messages:   [{ role: 'user', content: prompt }],
    tools:      [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
  };

  const res = await fetch(API_URL, {
    method:  'POST',
    headers: {
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Claude HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();
}

function extractJSON(text) {
  const cleaned = text.replace(/```json\s*|```\s*/g, '').trim();
  const m = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

async function fetchMortgageRates() {
  const prompt = `Du er en finansekspert i Norge. Bruk web search for å finne dagens nominelle flytende boliglånsrente for hver av følgende norske banker. Sjekk bankenes egne nettsider eller finansportalen.no.

Banker: ${BANKS_MORTGAGE.join(', ')}

Returner KUN et JSON-array:

[
  { "bank": "<banknavn>", "rate": <tall i %>, "type": "flytende", "ltvMax": <LTV% eller 85>, "requiresProducts": "<krav eller tom streng>" }
]

Ta med så mange du finner pålitelige tall for. Utelat banker du ikke finner eller er usikker på.`;

  const text = await askClaude(prompt, 2048);
  const arr  = extractJSON(text);
  if (!Array.isArray(arr)) throw new Error('Could not parse mortgage response');
  return arr.filter(r => r && r.bank && typeof r.rate === 'number' && r.rate > 0 && r.rate < 20)
    .map(r => ({
      bank: String(r.bank),
      rate: Number(r.rate),
      type: r.type || 'flytende',
      ltvMax: r.ltvMax || 85,
      requiresProducts: r.requiresProducts || '',
    }));
}

async function fetchCarLoanRates() {
  const prompt = `Du er en finansekspert i Norge. Bruk web search for å finne dagens nominelle flytende billånsrente fra de største norske bankene og finansieringsselskapene (Santander, Nordea Finans, DNB, SpareBank 1, Ya Bank, Instabank, BN Bank, osv.). Standard billån, ikke leasing.

Returner KUN et JSON-array:

[
  { "bank": "<banknavn>", "rate": <tall i %>, "type": "flytende", "ltvMax": 80, "requiresProducts": "<krav eller tom>" }
]`;

  const text = await askClaude(prompt, 2048);
  const arr  = extractJSON(text);
  if (!Array.isArray(arr)) throw new Error('Could not parse car-loan response');
  return arr.filter(r => r && r.bank && typeof r.rate === 'number' && r.rate > 0 && r.rate < 20)
    .map(r => ({
      bank: String(r.bank),
      rate: Number(r.rate),
      type: r.type || 'flytende',
      ltvMax: r.ltvMax || 80,
      requiresProducts: r.requiresProducts || '',
    }));
}

async function fetchStudentLoanRate() {
  const prompt = `Du er en finansekspert i Norge. Bruk web search for å finne dagens rente på studielån hos Lånekassen (flytende og fast). Sjekk lanekassen.no.

Returner KUN et JSON-objekt:

{ "floatingRate": <tall i %>, "fixedRate3y": <tall eller null>, "fixedRate5y": <tall eller null>, "fixedRate10y": <tall eller null>, "asOfDate": "<YYYY-MM-DD>" }`;

  const text = await askClaude(prompt, 800);
  const obj  = extractJSON(text);
  if (!obj || typeof obj.floatingRate !== 'number') throw new Error('Could not parse student loan response');
  return obj;
}

async function main() {
  console.log('Fetching rates via Claude...');
  const [mortgage, carLoan, student] = await Promise.all([
    fetchMortgageRates().catch(err => { console.error('mortgage:', err.message); return []; }),
    fetchCarLoanRates().catch(err => { console.error('car_loan:', err.message); return []; }),
    fetchStudentLoanRate().catch(err => { console.error('student:', err.message); return null; }),
  ]);

  // Build student-loan rate list
  const studentRates = [];
  if (student && student.floatingRate) {
    studentRates.push({ bank: 'Lånekassen (flytende)', rate: student.floatingRate, type: 'flytende', ltvMax: 100, requiresProducts: '' });
    if (student.fixedRate3y)  studentRates.push({ bank: 'Lånekassen (fast 3 år)',  rate: student.fixedRate3y,  type: 'fast', ltvMax: 100, requiresProducts: '' });
    if (student.fixedRate5y)  studentRates.push({ bank: 'Lånekassen (fast 5 år)',  rate: student.fixedRate5y,  type: 'fast', ltvMax: 100, requiresProducts: '' });
    if (student.fixedRate10y) studentRates.push({ bank: 'Lånekassen (fast 10 år)', rate: student.fixedRate10y, type: 'fast', ltvMax: 100, requiresProducts: '' });
  }

  const out = {
    updatedAt: new Date().toISOString(),
    source:    'Claude API web search (weekly)',
    mortgage:  mortgage.sort((a, b) => a.rate - b.rate),
    car_loan:  carLoan.sort((a, b) => a.rate - b.rate),
    student_loan: studentRates,
  };

  // Ensure data/ exists
  fs.mkdirSync(path.dirname(OUTFILE), { recursive: true });
  fs.writeFileSync(OUTFILE, JSON.stringify(out, null, 2) + '\n');

  console.log(`✅ Wrote ${OUTFILE}: ${mortgage.length} mortgage, ${carLoan.length} car, ${studentRates.length} student`);
}

main().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
