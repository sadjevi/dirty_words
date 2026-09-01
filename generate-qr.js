require('dotenv').config();
const QRCode = require('qrcode');

const domain = process.env.DOMAIN;
if (!domain) {
  console.error('❌ Ajoute DOMAIN=https://tondomaine.com dans .env avant de générer le QR code.');
  process.exit(1);
}

const url = `${domain}/pay`;

QRCode.toFile('qr-code.png', url, { width: 800, margin: 2 }, (err) => {
  if (err) throw err;
  console.log(`✅ QR code généré : qr-code.png`);
  console.log(`   Il pointe vers : ${url}`);
  console.log(`   Ce QR code est STATIQUE : imprime-le une fois, il ne change jamais.`);
});
