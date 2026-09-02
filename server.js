

// Curbside backend — Stripe Connect marketplace server.
//
// What this does:
//   1. Onboards sellers onto Stripe Connect (Express accounts) so money can be
//      split between you (the platform) and them automatically.
//   2. Charges a one-time $20 signup fee that goes straight to you.
//   3. Charges buyers for sold items: the seller keeps a flat $15, and you
//      (the platform) keep everything above that — in a single payment, no
//      manual transfers.
//   4. Listens for Stripe webhooks to confirm payments actually completed
//      before marking anything as paid.
//
// Storage: this demo uses two JSON files on disk (sellers.json, ledger.json)
// so it's easy to read and run locally. Most hosts (Render, Railway, etc.)
// wipe local files on redeploy, so before going live, swap readDB/writeDB
// below for a real database (Postgres is the standard pick with Stripe).

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

const SIGNUP_FEE_CENTS = Math.round(Number(process.env.SIGNUP_FEE_USD || 60) * 100);
// The seller's flat, fixed payout per item sold. Everything above this goes to you.
const SELLER_PAYOUT_CENTS = Math.round(Number(process.env.SELLER_PAYOUT_USD || 15) * 100);
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:4242';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

app.use(cors({ origin: FRONTEND_URL }));

// ---------- tiny JSON-file "database" (swap for real DB before going live) ----------
const SELLERS_FILE = path.join(__dirname, 'sellers.json');
const LEDGER_FILE = path.join(__dirname, 'ledger.json');

function readDB(file) {
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function writeDB(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function getSellers() { return readDB(SELLERS_FILE); }
function saveSellers(d) { writeDB(SELLERS_FILE, d); }
function getLedger() { const d = readDB(LEDGER_FILE); return Array.isArray(d.events) ? d : { events: [] }; }
function saveLedger(d) { writeDB(LEDGER_FILE, d); }

// ---------- 1. Seller onboarding (Stripe Connect Express) ----------
// Call this when a seller wants to register. Creates their connected account
// if it doesn't exist yet, then returns a one-time onboarding link to send
// them to (they enter their bank details directly with Stripe, not with you).
app.post('/api/sellers/:sellerId/onboard', express.json(), async (req, res) => {
  try {
    const { sellerId } = req.params;
    const sellers = getSellers();

    let accountId = sellers[sellerId]?.stripeAccountId;
    if (!accountId) {
      const account = await stripe.accounts.create({ type: 'express' });
      accountId = account.id;
      sellers[sellerId] = { ...(sellers[sellerId] || {}), stripeAccountId: accountId };
      saveSellers(sellers);
    }

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${BACKEND_URL}/api/sellers/${sellerId}/onboard`,
      return_url: `${FRONTEND_URL}?onboarded=1`,
      type: 'account_onboarding',
    });

    res.json({ url: accountLink.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Check whether a seller has finished onboarding and can receive payouts.
app.get('/api/sellers/:sellerId/status', async (req, res) => {
  try {
    const sellers = getSellers();
    const record = sellers[req.params.sellerId];
    if (!record?.stripeAccountId) return res.json({ onboarded: false, signupFeePaid: false });

    const account = await stripe.accounts.retrieve(record.stripeAccountId);
    res.json({
      onboarded: !!account.charges_enabled,
      signupFeePaid: !!record.signupFeePaid,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- 2. One-time $20 signup fee (paid to you, the platform) ----------
app.post('/api/signup-fee/checkout', express.json(), async (req, res) => {
  try {
    const { sellerId } = req.body;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: 'Curbside seller registration' },
          unit_amount: SIGNUP_FEE_CENTS,
        },
        quantity: 1,
      }],
      metadata: { type: 'signup_fee', sellerId },
      success_url: `${FRONTEND_URL}?signup=success`,
      cancel_url: `${FRONTEND_URL}?signup=cancelled`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- 3. Charge a buyer for a sold item (seller keeps a flat $15, you keep the rest) ----------
app.post('/api/sale/checkout', express.json(), async (req, res) => {
  try {
    const { sellerId, listingId, title, priceUsd } = req.body;
    const sellers = getSellers();
    const record = sellers[sellerId];
    if (!record?.stripeAccountId) {
      return res.status(400).json({ error: 'Seller has not completed onboarding yet.' });
    }

    const priceCents = Math.round(Number(priceUsd) * 100);
    if (!priceCents || priceCents <= SELLER_PAYOUT_CENTS) {
      return res.status(400).json({ error: `Item price must be greater than the seller's flat $${SELLER_PAYOUT_CENTS/100} payout.` });
    }

    // The seller receives a flat $15; the platform (you) keeps everything above that.
    const platformCutCents = priceCents - SELLER_PAYOUT_CENTS;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: title || 'Curbside item' },
          unit_amount: priceCents,
        },
        quantity: 1,
      }],
      payment_intent_data: {
        application_fee_amount: platformCutCents,
        transfer_data: { destination: record.stripeAccountId },
      },
      metadata: { type: 'sale', sellerId, listingId, platformCutCents: String(platformCutCents) },
      success_url: `${FRONTEND_URL}?sale=success&listingId=${encodeURIComponent(listingId || '')}`,
      cancel_url: `${FRONTEND_URL}?sale=cancelled`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- 4. Dashboard totals, read from the ledger ----------
app.get('/api/ledger', (req, res) => {
  const ledger = getLedger();
  const signupTotal = ledger.events.filter(e => e.type === 'signup_fee').reduce((s, e) => s + e.amount, 0);
  const saleTotal = ledger.events.filter(e => e.type === 'sale').reduce((s, e) => s + e.amount, 0);
  res.json({ signupTotal, saleTotal, allTime: signupTotal + saleTotal, events: ledger.events });
});

// ---------- 5. Stripe webhook — the source of truth for "did this actually get paid" ----------
// Stripe needs the RAW request body to verify the signature, so this route
// uses express.raw() instead of express.json() (must come before any global
// express.json() middleware for this path).
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { type, sellerId, listingId } = session.metadata || {};

    if (type === 'signup_fee') {
      const sellers = getSellers();
      sellers[sellerId] = { ...(sellers[sellerId] || {}), signupFeePaid: true };
      saveSellers(sellers);

      const ledger = getLedger();
      ledger.events.push({ type: 'signup_fee', amount: SIGNUP_FEE_CENTS / 100, sellerId, at: Date.now() });
      saveLedger(ledger);
    }

    if (type === 'sale') {
      const ledger = getLedger();
      const platformCut = Number(session.metadata.platformCutCents || 0) / 100;
      ledger.events.push({ type: 'sale', amount: platformCut, sellerId, listingId, at: Date.now() });
      saveLedger(ledger);
    }
  }

  res.json({ received: true });
});

// JSON body parsing for every route below/above this line except /webhook
app.use(express.json());

app.get('/', (req, res) => res.send('Curbside backend is running.'));

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Curbside backend listening on port ${PORT}`));
