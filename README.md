# 🤬 Caisse à Gros Mots

App web ludique : on scanne un QR code, l'app tire au sort une amende
(2€, 5€ ou 10€) pour le 1er gros mot de la journée, puis fixe 10€ à partir
du 2e. Paiement via Stripe Checkout (carte, Apple Pay, Google Pay).

## Comment ça marche

1. Tu imprimes/affiches **un seul QR code statique** qui pointe vers `https://tondomaine.com/pay`.
2. Quelqu'un dit un gros mot → il flashe le QR code avec son téléphone.
3. La page affiche le montant tiré au sort (calculé et **signé côté serveur**, impossible à trafiquer).
4. Il clique sur "Payer" → redirigé vers **Stripe Checkout** (carte / Apple Pay / Google Pay selon son appareil).
5. Une fois le paiement confirmé par Stripe (via **webhook**), le compteur du jour est incrémenté.
6. Le lendemain (minuit, heure de Paris), le compteur repart à zéro.

Le compteur est **global** (peu importe qui paie) : c'est le nombre de gros mots payés dans la journée, pas par personne.

## 1. Installation

```bash
npm install
cp .env.example .env
```

Remplis `.env` :
- `STRIPE_SECRET_KEY` : clé secrète Stripe (mode test pour commencer)
- `TICKET_SECRET` : génère-en une avec `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `DOMAIN` : `http://localhost:3000` en local

## 2. Tester en local

```bash
npm start
```
Ouvre `http://localhost:3000`.

Pour tester le webhook en local, installe le [Stripe CLI](https://stripe.com/docs/stripe-cli) puis :
```bash
stripe listen --forward-to localhost:3000/webhook/stripe
```
Il t'affiche un `whsec_...` à mettre dans `.env` (`STRIPE_WEBHOOK_SECRET`).

## 3. Apple Pay / Google Pay : rien à faire !

Stripe Checkout est **hébergé sur le domaine de Stripe** : Apple Pay et Google Pay
apparaissent automatiquement si l'appareil du visiteur les supporte, sans
vérification de domaine ni configuration supplémentaire. Il suffit d'avoir
`payment_method_types: ['card']`, déjà fait dans `server.js`.

(Si un jour tu passes à un bouton de paiement intégré directement sur ta page,
ce serait différent — mais ce n'est pas le cas ici.)

## 4. Déploiement en production

⚠️ Important : ce projet stocke le compteur du jour dans un fichier SQLite
(`data.sqlite`). Il faut donc un hébergeur avec **disque persistant** :
- ✅ Railway, Render, Fly.io, un VPS classique
- ❌ Vercel / Netlify Functions (serverless, système de fichiers non persistant)

Étapes générales (exemple avec Railway ou Render) :
1. Pousse ce dossier sur un repo GitHub.
2. Connecte le repo à Railway/Render, déploie.
3. Renseigne les variables d'environnement (`STRIPE_SECRET_KEY`, `TICKET_SECRET`, `DOMAIN` = ton URL publique).
4. Dans le **Dashboard Stripe > Webhooks**, ajoute un endpoint : `https://tondomaine.com/webhook/stripe`, événement `checkout.session.completed`. Récupère le `whsec_...` généré et mets-le dans `STRIPE_WEBHOOK_SECRET`.
5. Repasse en clé Stripe **live** (`sk_live_...`) quand tu es prêt à encaisser pour de vrai.

## 5. Générer le QR code

```bash
npm run generate-qr
```
Génère `qr-code.png`, à imprimer et coller là où les gros mots sont dits.
Il pointe vers `/pay` : il ne change jamais, même si les montants derrière évoluent.

## Personnalisation rapide

- Montants du 1er tirage : dans `db.js`, fonction `computeNextAmount` (`[2, 5, 10]`).
- Seuil "à partir du 2e paiement" : même fonction, condition `already === 0`.
- Textes / emojis / couleurs : `server.js` (templates HTML) et `public/style.css`.
