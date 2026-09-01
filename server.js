require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const Stripe = require('stripe');
const db = require('./db');

const {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  DOMAIN, // ex: https://gros-mots.up.railway.app  (sans slash final)
  TICKET_SECRET, // chaîne aléatoire longue, voir .env.example
  PORT = 3000,
} = process.env;

if (!STRIPE_SECRET_KEY) {
  console.error('❌ STRIPE_SECRET_KEY manquant dans .env');
  process.exit(1);
}
if (!TICKET_SECRET) {
  console.error('❌ TICKET_SECRET manquant dans .env');
  process.exit(1);
}

const stripe = new Stripe(STRIPE_SECRET_KEY);
const app = express();

app.use('/public', express.static(__dirname + '/public'));

// ---------- "Ticket" signé anti-triche ----------
// Le montant est calculé et signé côté serveur sur /pay, puis revérifié sur
// /checkout. Impossible pour un visiteur de modifier le montant affiché.
function signTicket(amount) {
  const payload = `${amount}.${Date.now()}`;
  const sig = crypto
    .createHmac('sha256', TICKET_SECRET)
    .update(payload)
    .digest('hex');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

function verifyTicket(ticket, maxAgeMs = 5 * 60 * 1000) {
  try {
    const decoded = Buffer.from(ticket, 'base64url').toString('utf8');
    const [amountStr, tsStr, sig] = decoded.split('.');
    const payload = `${amountStr}.${tsStr}`;
    const expected = crypto
      .createHmac('sha256', TICKET_SECRET)
      .update(payload)
      .digest('hex');
    if (
      !crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))
    ) {
      return null;
    }
    const age = Date.now() - Number(tsStr);
    if (age > maxAgeMs) return null;
    return Number(amountStr);
  } catch {
    return null;
  }
}

// ---------- Templates HTML ----------
const layout = (body) => `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Caisse à Gros Mots 🤬</title>
  <link rel="stylesheet" href="/public/style.css" />
</head>
<body>${body}</body>
</html>`;

app.get('/', (req, res) => {
  res.send(
    layout(`
    <main class="card">
      <div class="emoji">🤬</div>
      <h1>Caisse à Gros Mots</h1>
      <p class="subtitle">Tu as dit un gros mot ? Flashe le QR code affiché et paie ton amende !</p>
      <a class="btn" href="/pay">Simuler un flash du QR code</a>
      <p class="fine-print">1er gros mot de la journée : montant surprise (2, 5 ou 10€). Dès le 2e : 10€ fixe.</p>
    </main>
  `)
  );
});

// Page "verdict" affichée juste après le scan du QR code.
app.get('/pay', (req, res) => {
  const amount = db.computeNextAmount();
  const nth = db.countTodayPaid() + 1;
  const ticket = signTicket(amount);

  const bigLine =
    nth === 1
      ? `Premier gros mot du jour... le sort en a décidé :`
      : `Encore un gros mot aujourd'hui (n°${nth}) ? Cette fois, pas de chance :`;

  res.send(
    layout(`
    <main class="card reveal">
      <div class="emoji spin">🎲</div>
      <h1>Verdict !</h1>
      <p class="subtitle">${bigLine}</p>
      <div class="amount">${amount}€</div>
      <form method="POST" action="/checkout">
        <input type="hidden" name="ticket" value="${ticket}" />
        <button class="btn" type="submit">💳 Payer ${amount}€ maintenant</button>
      </form>
      <p class="fine-print">Carte bancaire, Apple Pay et Google Pay acceptés.</p>
    </main>
  `)
  );
});

app.use(express.urlencoded({ extended: false }));

// Crée la session Stripe Checkout à partir du montant SIGNÉ (jamais du montant brut envoyé par le client).
app.post('/checkout', async (req, res) => {
  const amount = verifyTicket(req.body.ticket);
  if (!amount) {
    return res
      .status(400)
      .send(layout(`<main class="card"><h1>Oups</h1><p>Ce lien a expiré, reflashe le QR code.</p><a class="btn" href="/pay">Réessayer</a></main>`));
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'], // Apple Pay / Google Pay apparaissent automatiquement sur Stripe Checkout hébergé
    line_items: [
      {
        price_data: {
          currency: 'eur',
          product_data: {
            name: `Amende Gros Mot 🤬`,
          },
          unit_amount: amount * 100,
        },
        quantity: 1,
      },
    ],
    success_url: `${DOMAIN}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${DOMAIN}/cancel`,
  });

  res.redirect(303, session.url);
});

app.get('/success', async (req, res) => {
  const sessionId = req.query.session_id;
  let amount = null;
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status === 'paid') {
      amount = session.amount_total / 100;
    }
  } catch {
    // ignore, on affiche un message générique
  }
  res.send(
    layout(`
    <main class="card">
      <div class="emoji">✅</div>
      <h1>Payé !</h1>
      <p class="subtitle">${amount ? `Amende de ${amount}€ réglée.` : 'Paiement confirmé.'} Merci, et essaie de te tenir un peu quand même 😄</p>
      <a class="btn" href="/">Retour à l'accueil</a>
    </main>
  `)
  );
});

app.get('/cancel', (req, res) => {
  res.send(
    layout(`
    <main class="card">
      <div class="emoji">🙅</div>
      <h1>Paiement annulé</h1>
      <p class="subtitle">Tu t'en tires cette fois... mais le QR code n'oublie pas.</p>
      <a class="btn" href="/pay">Reflasher / Réessayer</a>
    </main>
  `)
  );
});

// ---------- Webhook Stripe : seule source de vérité pour valider un paiement ----------
// Doit recevoir le BODY BRUT (pas de express.json avant cette route).
app.post(
  '/webhook/stripe',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers['stripe-signature'],
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('⚠️ Signature webhook invalide:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.payment_status === 'paid') {
        const amount = session.amount_total / 100;
        const added = db.recordPaidSession(session.id, amount);
        if (added) {
          console.log(`💰 Paiement confirmé: ${amount}€ (session ${session.id})`);
        }
      }
    }

    res.json({ received: true });
  }
);

app.listen(PORT, () => {
  console.log(`🤬 Caisse à Gros Mots lancée sur http://localhost:${PORT}`);
});
