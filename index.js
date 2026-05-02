const express = require('express');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Contact Data ───────────────────────────────────────────────────────────
const contacts = {
  '+919990077856': { name: 'Raghav', marks: 90, segment: 'A' },
  '+917303349491': { name: 'Paarth', marks: 82, segment: 'B' },
  '+919820692913': { name: 'Mohsin', marks: 60, segment: 'C' },
  '+919786236373': { name: 'Vishal', marks: 89, segment: 'A' },
  '+919990919105': { name: 'Riddhi', marks: 99, segment: 'A' },
  '+919313181687': { name: 'Monika', marks: 94, segment: 'A' },
};

// In-memory conversation history (fine for 5-person test)
const conversations = {};

// ─── System Prompt ───────────────────────────────────────────────────────────
function getSystemPrompt(contact) {
  const segmentInfo = {
    A: `high scorer (${contact.marks}% in Class 12). Best suited for top colleges in India or abroad. Loan range ₹25-50L. Lenders: Credila, Avanse, HDFC Credila. Rate: 10.5-11.5%. No collateral up to ₹40L.`,
    B: `mid scorer (${contact.marks}% in Class 12). Suited for India private colleges, management courses, select abroad programs. Loan range ₹8-25L. Lenders: Avanse, ICICI, Auxilo, SBI. Co-applicant with income improves eligibility significantly.`,
    C: `lower scorer (${contact.marks}% in Class 12). Suited for diploma, vocational, BSc, skill courses. Loan range ₹2-8L. Government banks and NBFCs. Eligibility depends more on co-applicant income than marks.`
  };

  return `You are a WhatsApp counsellor for CashKaro EduLoans — India's education loan platform. Your name is Priyam.

You are talking to ${contact.name}, a ${segmentInfo[contact.segment]}

YOUR GOAL: Help ${contact.name} get an education loan. Move the conversation toward them sharing their target course and university, then tell them a counsellor will call shortly.

HOW TO HANDLE DIFFERENT REPLIES:
- YES / interested / tell me more / want to know → Ask which course and city/university they're targeting
- They share a course or university name → Say great, a counsellor will call within 30 minutes. Ask for a convenient time.
- They ask a question about rates, eligibility, process → Answer it briefly and redirect to asking their course
- NO / not interested → Acknowledge gracefully, say the door is open if they change their mind
- STOP / remove me / unsubscribe → Confirm they've been removed, end warmly

STRICT RULES:
- Keep every message under 4 lines. This is WhatsApp, not email.
- No bullet points. No asterisks. No formatting. Plain text only.
- Sound like a helpful friend, not a bank employee.
- Never mention competitor names.
- Never mention internal words like KAM, DSA, BRE, AOP, commission, processing pipeline.
- Never reveal company targets or financials.
- If they write in Malayalam, reply in Malayalam. Otherwise English.
- If the conversation has clearly ended (firm refusal, unsubscribed, or they've agreed to a call), add the word DONE at the very end of your message on a new line so the system can log it.`;
}

// ─── M1 Opening Messages ─────────────────────────────────────────────────────
function getM1(contact) {
  const m1 = {
    A: `Hi ${contact.name}! This is Priyam from CashKaro EduLoans. You scored ${contact.marks}% in Class 12 — that qualifies you for loans up to ₹50L for top colleges in India and abroad, with no collateral needed. Reply YES if you want to see your options.`,
    B: `Hi ${contact.name}! Priyam here from CashKaro EduLoans. You scored ${contact.marks}% in Class 12 — education loans are available for private colleges, management courses, and select abroad programs too. Reply YES to see what you qualify for.`,
    C: `Hi ${contact.name}! This is Priyam from CashKaro EduLoans. Loans aren't only for toppers — with ${contact.marks}% you can still get funding for diploma, vocational, BSc, and skill courses. Reply YES to check your options.`
  };
  return m1[contact.segment];
}

// ─── Send WhatsApp via Twilio ─────────────────────────────────────────────────
async function sendWA(to, message) {
  await twilioClient.messages.create({
    from: `whatsapp:${process.env.TWILIO_SANDBOX_NUMBER}`,
    to: `whatsapp:${to}`,
    body: message
  });
}

// ─── Incoming Message Webhook ─────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const incomingMsg = req.body.Body?.trim();
  const from = req.body.From?.replace('whatsapp:', '');

  console.log(`Incoming from ${from}: ${incomingMsg}`);

  const contact = contacts[from];
  if (!contact) {
    console.log(`Unknown number: ${from}`);
    res.status(200).send('OK');
    return;
  }

  if (!conversations[from]) {
    conversations[from] = [];
  }

  conversations[from].push({ role: 'user', content: incomingMsg });

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: getSystemPrompt(contact),
      messages: conversations[from]
    });

    let reply = response.content[0].text;

    const isDone = reply.includes('DONE');
    reply = reply.replace('DONE', '').trim();

    conversations[from].push({ role: 'assistant', content: reply });

    await sendWA(from, reply);

    if (isDone) {
      console.log(`Journey complete for ${contact.name}`);
    }

  } catch (err) {
    console.error('Claude/Twilio error:', err.message);
    await sendWA(from, `Hi ${contact.name}, a counsellor will reach out to you shortly!`);
  }

  res.status(200).send('OK');
});

// ─── Send M1 to All Contacts ──────────────────────────────────────────────────
app.get('/send-m1', async (req, res) => {
  const results = [];

  for (const [phone, contact] of Object.entries(contacts)) {
    try {
      const msg = getM1(contact);
      await sendWA(phone, msg);

      if (!conversations[phone]) conversations[phone] = [];
      conversations[phone].push({ role: 'assistant', content: msg });

      results.push({ name: contact.name, segment: contact.segment, status: 'sent ✅' });
      console.log(`M1 sent to ${contact.name} (Segment ${contact.segment})`);

      await new Promise(r => setTimeout(r, 1000)); // 1s gap between sends
    } catch (err) {
      results.push({ name: contact.name, status: `failed ❌ — ${err.message}` });
      console.error(`Failed for ${contact.name}:`, err.message);
    }
  }

  res.json({ message: 'M1 send complete', results });
});

// ─── View Conversation Logs ───────────────────────────────────────────────────
app.get('/logs', (req, res) => {
  const logs = {};
  for (const [phone, contact] of Object.entries(contacts)) {
    logs[contact.name] = {
      segment: contact.segment,
      marks: contact.marks,
      messages: conversations[phone] || []
    };
  }
  res.json(logs);
});

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'EduLoans WhatsApp Bot running ✅',
    contacts: Object.values(contacts).map(c => ({
      name: c.name,
      segment: c.segment,
      marks: c.marks,
      messagesSoFar: conversations[Object.keys(contacts).find(k => contacts[k] === c)]?.length || 0
    }))
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot live on port ${PORT}`));
