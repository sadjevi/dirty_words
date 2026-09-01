const Database = require('better-sqlite3');
const path = require('path');

// Fichier SQLite persistant. IMPORTANT en production : héberger sur une
// plateforme avec disque persistant (Render, Railway, Fly.io, VPS...).
// Les plateformes 100% serverless (Vercel, Netlify Functions) réinitialisent
// le système de fichiers entre les requêtes : le compteur ne survivrait pas.
const db = new Database(path.join(__dirname, 'data.sqlite'));

db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    amount INTEGER NOT NULL,
    stripe_session_id TEXT UNIQUE,
    visitor_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migration douce : si la base existait déjà sans la colonne visitor_id, on l'ajoute.
const existingCols = db.prepare('PRAGMA table_info(payments)').all();
if (!existingCols.some((c) => c.name === 'visitor_id')) {
  db.exec('ALTER TABLE payments ADD COLUMN visitor_id TEXT');
}

// Retourne la date du jour au format YYYY-MM-DD, dans le fuseau Europe/Paris.
function todayParis() {
  const fmt = new Intl.DateTimeFormat('fr-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date()); // fr-CA => format YYYY-MM-DD
}

// Nombre de paiements DÉJÀ confirmés (payés) AUJOURD'HUI par ce visiteur précis.
function countTodayPaidByVisitor(visitorId) {
  const row = db
    .prepare(
      'SELECT COUNT(*) AS n FROM payments WHERE date = ? AND visitor_id = ?'
    )
    .get(todayParis(), visitorId);
  return row.n;
}

// Calcule le montant du PROCHAIN paiement pour CE visiteur, selon son historique du jour.
// Règle : son 1er paiement du jour => aléatoire parmi [2, 5, 10]
//         à partir de son 2e paiement du jour => 10€ fixe
function computeNextAmount(visitorId) {
  const already = countTodayPaidByVisitor(visitorId);
  if (already === 0) {
    const choices = [2, 5, 10];
    return choices[Math.floor(Math.random() * choices.length)];
  }
  return 10;
}

// Enregistre un paiement confirmé (appelé uniquement depuis le webhook Stripe,
// jamais depuis le navigateur, pour éviter toute triche).
function recordPaidSession(stripeSessionId, amountEuros, visitorId) {
  try {
    db.prepare(
      'INSERT INTO payments (date, amount, stripe_session_id, visitor_id) VALUES (?, ?, ?, ?)'
    ).run(todayParis(), amountEuros, stripeSessionId, visitorId);
    return true;
  } catch (err) {
    // UNIQUE constraint => webhook déjà traité pour cette session (idempotence)
    if (String(err.message).includes('UNIQUE')) return false;
    throw err;
  }
}

function hasSession(stripeSessionId) {
  const row = db
    .prepare('SELECT 1 FROM payments WHERE stripe_session_id = ?')
    .get(stripeSessionId);
  return !!row;
}

module.exports = {
  countTodayPaidByVisitor,
  computeNextAmount,
  recordPaidSession,
  hasSession,
  todayParis,
};
