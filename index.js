require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

const {
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_VERIFY_TOKEN,
  SHEETY_URL,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  PORT = 3000,
} = process.env;

// -----------------------------------------------------------------
// STATO DELLA CONVERSAZIONE
// Per ogni cliente (numero di telefono) teniamo traccia di dove si
// trova nella conversazione. E' in memoria: se il server si riavvia,
// le conversazioni a meta' si perdono e il cliente riparte da capo.
// Per un piccolo negozio va benissimo; se in futuro serve qualcosa
// di piu' robusto si puo' spostare su un database.
// -----------------------------------------------------------------
const sessioni = new Map();

function nuovaSessione() {
  return { step: 'chiedi_modello', modello: null, taglia: null };
}

// -----------------------------------------------------------------
// 1) VERIFICA DEL WEBHOOK (richiesta da Meta una sola volta, quando
//    colleghi il webhook nel pannello Meta for Developers)
// -----------------------------------------------------------------
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
    console.log('Webhook verificato con successo');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// -----------------------------------------------------------------
// 2) RICEZIONE DEI MESSAGGI (Meta chiama questo endpoint ogni volta
//    che un cliente scrive al numero WhatsApp del negozio)
// -----------------------------------------------------------------
app.post('/webhook', async (req, res) => {
  // Rispondiamo subito 200 a Meta, per non far scadere la richiesta.
  res.sendStatus(200);
  console.log('--- Webhook ricevuto ---', JSON.stringify(req.body));

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const messaggio = change?.value?.messages?.[0];

    if (!messaggio) {
      console.log('Nessun messaggio nel payload (probabile notifica di stato, es. "letto").');
      return;
    }

    const telefonoCliente = messaggio.from; // es. "50588881234"
    const testo = (messaggio.text?.body || '').trim();
    console.log(`Messaggio da ${telefonoCliente}: "${testo}"`);

    await gestisciMessaggio(telefonoCliente, testo);
  } catch (errore) {
    console.error('Errore nella gestione del messaggio:', errore);
  }
});

// -----------------------------------------------------------------
// LOGICA DELLA CONVERSAZIONE
// -----------------------------------------------------------------
async function gestisciMessaggio(telefono, testo) {
  let sessione = sessioni.get(telefono);
  if (!sessione) {
    sessione = nuovaSessione();
    sessioni.set(telefono, sessione);
    await inviaMessaggioWhatsApp(
      telefono,
      '¡Hola! Bienvenido/a. Decime el modelo que te interesa (ej. AGATHA-22) y reviso la disponibilidad al instante.'
    );
    return;
  }

  switch (sessione.step) {
    case 'chiedi_modello': {
      sessione.modello = testo.toUpperCase();
      sessione.step = 'chiedi_taglia';
      await inviaMessaggioWhatsApp(telefono, `Perfecto, ${sessione.modello}. ¿Qué talla necesitás?`);
      break;
    }

    case 'chiedi_taglia': {
      sessione.taglia = testo.replace(',', '.'); // nel caso scrivano 6,5 invece di 6.5
      const risultato = await cercaDisponibilita(sessione.modello, sessione.taglia);

      if (risultato && risultato.quantitàDisponibile > 0) {
        sessione.step = 'chiedi_conferma';
        sessione.trovato = risultato;
        const prezzo = risultato.prezzoAlPaioUSD || risultato['prezzoAlPaio (usd)'];
        await inviaMessaggioWhatsApp(
          telefono,
          `¡Sí, disponible! ${sessione.modello} talla ${sessione.taglia} — precio $${prezzo}.\n\n¿Querés que un vendedor te contacte para completar la compra? Respondé SI o NO.`
        );
      } else {
        sessione.step = 'chiedi_modello';
        await inviaMessaggioWhatsApp(
          telefono,
          `Lo siento, no tenemos el modelo ${sessione.modello} en talla ${sessione.taglia} en este momento. ¿Querés probar con otro modelo? Escribime el nombre.`
        );
      }
      break;
    }

    case 'chiedi_conferma': {
      const risposta = testo.toLowerCase();
      if (risposta.startsWith('s')) {
        await notificaOperatoreTelegram(telefono, sessione.modello, sessione.taglia);
        await inviaMessaggioWhatsApp(
          telefono,
          '¡Perfecto! Un vendedor te va a escribir en breve para completar la compra. ¡Gracias!'
        );
      } else {
        await inviaMessaggioWhatsApp(telefono, '¡Está bien! Si querés consultar otro modelo, escribime el nombre.');
      }
      sessione.step = 'chiedi_modello';
      break;
    }

    default: {
      sessione.step = 'chiedi_modello';
      await inviaMessaggioWhatsApp(telefono, 'Decime el modelo que te interesa.');
    }
  }
}

// -----------------------------------------------------------------
// INTERROGAZIONE DEL DATABASE (Sheety -> Google Sheets)
// -----------------------------------------------------------------
async function cercaDisponibilita(modello, taglia) {
  const url = `${SHEETY_URL}?modello=${encodeURIComponent(modello)}&taglia=${encodeURIComponent(taglia)}`;
  console.log('Interrogo Sheety:', url);
  const risposta = await fetch(url);
  if (!risposta.ok) {
    console.error('Errore Sheety:', risposta.status, await risposta.text());
    return null;
  }
  const dati = await risposta.json();
  console.log('Risposta Sheety:', JSON.stringify(dati));
  const righe = dati.inventario || [];
  return righe[0] || null; // prendiamo la prima corrispondenza
}

// -----------------------------------------------------------------
// INVIO MESSAGGIO WHATSAPP (Graph API di Meta)
// -----------------------------------------------------------------
async function inviaMessaggioWhatsApp(telefono, testo) {
  const url = `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const risposta = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: telefono,
      type: 'text',
      text: { body: testo },
    }),
  });
  const corpo = await risposta.text();
  if (!risposta.ok) {
    console.error(`Errore invio WhatsApp (status ${risposta.status}):`, corpo);
  } else {
    console.log('Messaggio WhatsApp inviato correttamente:', corpo);
  }
}

// -----------------------------------------------------------------
// NOTIFICA TELEGRAM ALL'OPERATORE
// -----------------------------------------------------------------
async function notificaOperatoreTelegram(telefonoCliente, modello, taglia) {
  const linkWhatsApp = `https://wa.me/${telefonoCliente}`;
  const testo =
    `🔔 Nuova richiesta disponibile\n` +
    `Modello: ${modello}\n` +
    `Taglia: ${taglia}\n` +
    `Canale: WhatsApp\n\n` +
    `👉 Rispondi al cliente: ${linkWhatsApp}`;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: testo }),
  });
}

app.get('/', (req, res) => res.send('Bot scarpe attivo.'));

app.listen(PORT, () => console.log(`Server in ascolto sulla porta ${PORT}`));
