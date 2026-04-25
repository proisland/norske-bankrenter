#!/usr/bin/env node
'use strict';

/**
 * fetch-rates.js — Henter norske bankrenter via Claude API med web search.
 *
 * Kjøres av GitHub Actions ukentlig. Skriver til data/rates.json.
 * Krever env-variabel ANTHROPIC_API_KEY.
 */

const fs   = require('fs');
const path = require('path');

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL   = 'claude-sonnet-4-5';
const OUTFILE = path.join(__dirname, '..', 'data', 'rates.json');

// Split mortgage banks into two smaller batches to reduce token usage
const BANKS_A = [
  'Bulder Bank', 'Heder Bank', 'Landkreditt Bank', 'Handelsbanken',
  'Storebrand Bank', 'Rogaland Sparebank', 'Sandnes Sparebank',
  'Sparebanken Vest', 'SpareBank 1 SR-Bank', 'KLP Banken',
  'Nordea', 'DNB', 'Instabank', 'BN Bank',
];
const BANKS_B = [
  'SpareBank 1 Østlandet', 'SpareBank 1 SMN', 'SpareBank 1 BV',
  'Sparebanken Sør', 'Sparebanken Møre', 'Sparebank 1 Nord-Norge',
  'Spareskillingsbanken', 'Cultura Bank', 'Komplett Bank',
  'Bank Norwegian', 'Santander Consumer Bank', 'Monobank', 'Sbanken (DNB)',
];

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function askClaude(prompt, maxTokens = 1500) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY mangler');

  const res = await fetch(API_URL, {
    method:  'POST',
    headers: {
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model:      MODEL,
      max_tokens: maxTokens,
      messages:   [{ role: 'user', content: prompt }],
      tools:      [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
    }),
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

/**
 * Robust JSON extraction — tries multiple strategies.
 */
function extractJSON(text) {
  // Strategy 1: strip markdown fences, find first [ or {
  const stripped = text.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '');

  // Try to find JSON array
  const arrMatch = stripped.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try { return JSON.parse(arrMatch[0]); } catch (_) {}
  }
  // Try to find JSON object
  const objMatch = stripped.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try { return JSON.parse(objMatch[0]); } catch (_) {}
  }

  // Strategy 2: find the largest balanced bracket block
  for (const [open, close] of [['[', ']'], ['{', '}']]) {
    let depth = 0, start = -1;
    for (let i = 0; i < stripped.length; i++) {
      if (stripped[i] === open)  { if (depth === 0) start = i; depth++; }
      if (stripped[i] === close) { depth--; if (depth === 0 && start >= 0) {
        try { return JSON.parse(stripped.slice(start, i + 1)); } catch (_) {}
      }}
    }
  }
  return null;
}

function parseRateArray(text, defaultLtvMax = 85) {
  const parsed = extractJSON(text);
  if (!Array.isArray(parsed)) {
    console.error('  Råsvar (første 400 tegn):', text.slice(0, 400));
    return null;
  }
  return parsed
    .filter(r => r && r.bank && typeof r.rate === 'number' && r.rate > 0 && r.rate < 20)
    .map(r => ({
      bank:             String(r.bank),
      rate:             Number(r.rate),
      type:             r.type || 'flytende',
      ltvMax:           r.ltvMax || defaultLtvMax,
      requiresProducts: r.requiresProducts || '',
    }));
}

function mortgagePrompt(banks) {
  return `Finn dagens nominelle flytende boliglånsrente fra disse norske bankene på finansportalen.no eller bankenes egne nettsider: ${banks.join(', ')}.

Svar KUN med et JSON-array (ingen annen tekst):
[{"bank":"<navn>","rate":<prosent>,"type":"flytende","ltvMax":<ltv>,"requiresProducts":"<krav>"}]`;
}

async function fetchMortgageRates() {
  // Fetch in two batches, pause between
  console.log('  Batch A...');
  const textA = await askClaude(mortgagePrompt(BANKS_A), 1200);
  const ratesA = parseRateArray(textA) || [];
  console.log(`  Batch A: ${ratesA.length} renter`);

  console.log('  Venter 35s...');
  await sleep(35000);

  console.log('  Batch B...');
  const textB = await askClaude(mortgagePrompt(BANKS_B), 1200);
  const ratesB = parseRateArray(textB) || [];
  console.log(`  Batch B: ${ratesB.length} renter`);

  // Merge, deduplicate on bank name
  const merged = [...ratesA];
  for (const r of ratesB) {
    if (!merged.find(m => m.bank.toLowerCase() === r.bank.toLowerCase())) {
      merged.push(r);
    }
  }
  return merged;
}

async function fetchCarLoanRates() {
  const prompt = `Finn dagens nominelle flytende billånsrente fra norske banker og finansieringsselskaper (Santander, Nordea Finans, DNB, SpareBank 1, Ya Bank, Instabank, BN Bank) på finansportalen.no eller bankenes nettsider.

Svar KUN med et JSON-array (ingen annen tekst):
[{"bank":"<navn>","rate":<prosent>,"type":"flytende","ltvMax":80,"requiresProducts":"<krav>"}]`;

  const text = await askClaude(prompt, 1000);
  return parseRateArray(text, 80);
}

async function fetchStudentLoanRate() {
  const prompt = `Finn dagens rente på studielån fra Lånekassen på lanekassen.no.

Svar KUN med et JSON-objekt (ingen annen tekst):
{"floatingRate":<prosent>,"fixedRate3y":<prosent eller null>,"fixedRate5y":<prosent eller null>,"fixedRate10y":<prosent eller null>}`;

  const text = await askClaude(prompt, 600);
  const obj  = extractJSON(text);
  if (!obj || typeof obj.floatingRate !== 'number') {
    console.error('  Råsvar:', text.slice(0, 300));
    throw new Error('Kunne ikke tolke Lånekassen-renter');
  }
  return obj;
}

async function main() {
  console.log('=== Henter norske bankrenter (sekvensielt) ===');

  // Load existing data as fallback
  let existing = { mortgage: [], car_loan: [], student_loan: [] };
  try {
    existing = JSON.parse(fs.readFileSync(OUTFILE, 'utf8'));
    console.log(`Eksisterende data: ${existing.mortgage?.length} boliglån, ${existing.car_loan?.length} billån, ${existing.student_loan?.length} studielån`);
  } catch (_) { console.log('Ingen eksisterende data.'); }

  // 1. Mortgage (two batches with internal pause)
  console.log('\n1/3 Boliglånsrenter...');
  let mortgage = [];
  try {
    mortgage = await fetchMortgageRates();
    console.log(`✅ ${mortgage.length} boliglånsrenter`);
  } catch (err) {
    console.error('❌ Boliglån feilet:', err.message);
    mortgage = existing.mortgage || [];
    console.log(`  Beholder ${mortgage.length} eksisterende`);
  }

  console.log('\nVenter 35s...');
  await sleep(35000);

  // 2. Car loans
  console.log('\n2/3 Billånsrenter...');
  let carLoan = [];
  try {
    carLoan = await fetchCarLoanRates();
    if (!carLoan || !carLoan.length) throw new Error('Tomt svar');
    console.log(`✅ ${carLoan.length} billånsrenter`);
  } catch (err) {
    console.error('❌ Billån feilet:', err.message);
    carLoan = existing.car_loan || [];
    console.log(`  Beholder ${carLoan.length} eksisterende`);
  }

  console.log('\nVenter 35s...');
  await sleep(35000);

  // 3. Student loans
  console.log('\n3/3 Lånekassen...');
  const studentRates = [];
  try {
    const student = await fetchStudentLoanRate();
    if (student.floatingRate) studentRates.push({ bank: 'Lånekassen (flytende)', rate: student.floatingRate, type: 'flytende', ltvMax: 100, requiresProducts: '' });
    if (student.fixedRate3y)  studentRates.push({ bank: 'Lånekassen (fast 3 år)',  rate: student.fixedRate3y,  type: 'fast', ltvMax: 100, requiresProducts: '' });
    if (student.fixedRate5y)  studentRates.push({ bank: 'Lånekassen (fast 5 år)',  rate: student.fixedRate5y,  type: 'fast', ltvMax: 100, requiresProducts: '' });
    if (student.fixedRate10y) studentRates.push({ bank: 'Lånekassen (fast 10 år)', rate: student.fixedRate10y, type: 'fast', ltvMax: 100, requiresProducts: '' });
    console.log(`✅ ${studentRates.length} Lånekassen-renter`);
  } catch (err) {
    console.error('❌ Lånekassen feilet:', err.message);
    studentRates.push(...(existing.student_loan || []));
    console.log(`  Beholder ${studentRates.length} eksisterende`);
  }

  // Write output
  const out = {
    updatedAt:    new Date().toISOString(),
    source:       'Claude API web search (weekly)',
    mortgage:     mortgage.sort((a, b) => a.rate - b.rate),
    car_loan:     carLoan.sort((a, b) => a.rate - b.rate),
    student_loan: studentRates,
  };

  fs.mkdirSync(path.dirname(OUTFILE), { recursive: true });
  fs.writeFileSync(OUTFILE, JSON.stringify(out, null, 2) + '\n');
  console.log(`\n✅ Skrevet til ${OUTFILE}`);
  console.log(`   Boliglån: ${out.mortgage.length}, Billån: ${out.car_loan.length}, Studielån: ${out.student_loan.length}`);
}

main().catch(err => {
  console.error('Kritisk feil:', err.message);
  process.exit(1);
});
