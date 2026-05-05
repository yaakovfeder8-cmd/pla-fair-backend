require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { randomUUID } = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: false }));

const claude = new Anthropic.default({
  apiKey: process.env.ANTHROPIC_KEY,
});

// Conversation memory — keyed by Twilio's CallSid
const conversations = {};
// Task memory — what PLA FAIR is trying to do on each call
const taskByCall = {};
const MAX_TURNS = 15;

// Audio cache
const audioCache = {};
const AUDIO_TTL_MS = 5 * 60 * 1000;

// Inbound = receiving a call
const INBOUND_PROMPT = `You are pla FAIR, a helpful personal phone-call assistant.
You're speaking on a phone call. Keep responses extremely short — 1-2 sentences MAX.
Never use markdown, lists, asterisks, or special characters — your response will be read aloud.
Be warm and direct. Don't pad with unnecessary words.
If the user says goodbye, respond very briefly.`;

// Outbound = WE'RE calling someone on the user's behalf
const OUTBOUND_PROMPT = (task) => `You are pla FAIR, a personal phone-call assistant calling on behalf of Jacob.
Your task: ${task}
You're calling a business or service.

Rules:
- Keep responses EXTREMELY short (1-2 sentences max). Phone calls move fast.
- Never use markdown, lists, asterisks, or special characters.
- Be polite, warm, and professional.
- Always identify yourself as calling on behalf of Jacob if asked.
- If they ask for sensitive info (SSN, full credit card), politely decline.
- When the task is done, thank them and say goodbye.`;

const escapeXml = (s) => s
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

const isGoodbye = (text) => {
  const lower = text.toLowerCase().trim();
  return /\b(goodbye|good bye|bye bye|see ya|that's all|that is all|that's it|i'm done|i am done|hang up|end call|talk to you later|have a good day|have a great day)\b/.test(lower)
    || lower === 'bye'
    || lower === 'thanks bye';
};

async function generateElevenLabsAudio(text) {
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const apiKey = process.env.ELEVENLABS_KEY;

  if (!voiceId || !apiKey) throw new Error('Missing ElevenLabs config');

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        // ⚡ FLASH MODEL — fastest available, ~75ms generation start time
        model_id: 'eleven_flash_v2_5',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    }
  );

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`ElevenLabs ${response.status}: ${errText.slice(0, 200)}`);
  }

  const id = randomUUID();
  audioCache[id] = Buffer.from(await response.arrayBuffer());
  setTimeout(() => { delete audioCache[id]; }, AUDIO_TTL_MS);
  return `${process.env.NGROK_URL}/audio/${id}`;
}

async function speak(text) {
  try {
    const url = await generateElevenLabsAudio(text);
    return `<Play>${url}</Play>`;
  } catch (err) {
    console.error('⚠️  ElevenLabs failed, using Polly fallback:', err.message);
    return `<Say voice="Polly.Joanna">${escapeXml(text)}</Say>`;
  }
}

// ⚡ Faster Gather settings — only wait 1 second for silence (was auto/2s)
const FAST_GATHER = `<Gather input="speech" action="/heard" method="POST" speechTimeout="1" speechModel="experimental_conversations" />`;

// ─── INBOUND CALLS ────────────────────────────────────────────────────────

app.post('/voice', async (req, res) => {
  const callSid = req.body.CallSid;
  console.log('📞 INBOUND call:', callSid);

  conversations[callSid] = [];
  taskByCall[callSid] = null;

  const greeting = await speak('Hello, this is pla FAIR. How can I help?');
  const noInput = await speak("I didn't hear anything. Goodbye.");

  res.set('Content-Type', 'text/xml');
  res.send(`
    <Response>
      ${greeting}
      ${FAST_GATHER}
      ${noInput}
      <Hangup/>
    </Response>
  `);
});

// ─── OUTBOUND CALLS ───────────────────────────────────────────────────────

app.post('/outbound', async (req, res) => {
  const callSid = req.body.CallSid;
  const task = req.query.task || 'Help the user with their request';
  console.log('📞 OUTBOUND call:', callSid);
  console.log('   Task:', task);

  conversations[callSid] = [];
  taskByCall[callSid] = task;

  const opener = `Hi, I'm calling on behalf of Jacob. ${task}. Could you help me?`;
  const openerAudio = await speak(opener);
  conversations[callSid].push({ role: 'assistant', content: opener });

  res.set('Content-Type', 'text/xml');
  res.send(`
    <Response>
      ${openerAudio}
      ${FAST_GATHER}
      <Hangup/>
    </Response>
  `);
});

// ─── SHARED — handles user response ─────────────────────────────────────

app.post('/heard', async (req, res) => {
  const callSid = req.body.CallSid;
  const userSaid = (req.body.SpeechResult || '').trim();
  const task = taskByCall[callSid];
  const isOutbound = !!task;

  console.log(`🗣️  ${isOutbound ? 'CALLEE' : 'USER'}:`, userSaid || '(silence)');

  if (!conversations[callSid]) conversations[callSid] = [];
  const history = conversations[callSid];

  if (userSaid && isGoodbye(userSaid)) {
    console.log('👋 Goodbye detected');
    delete conversations[callSid];
    delete taskByCall[callSid];
    const bye = await speak(isOutbound ? 'Thanks, have a great day!' : 'Take care!');
    res.set('Content-Type', 'text/xml');
    res.send(`<Response>${bye}<Hangup/></Response>`);
    return;
  }

  if (history.length >= MAX_TURNS * 2) {
    console.log('⏱️  Max turns reached');
    delete conversations[callSid];
    delete taskByCall[callSid];
    const bye = await speak("I'll need to call back later. Thanks!");
    res.set('Content-Type', 'text/xml');
    res.send(`<Response>${bye}<Hangup/></Response>`);
    return;
  }

  if (!userSaid) {
    const repeat = await speak("Sorry, I didn't catch that.");
    res.set('Content-Type', 'text/xml');
    res.send(`
      <Response>
        ${repeat}
        ${FAST_GATHER}
        <Hangup/>
      </Response>
    `);
    return;
  }

  history.push({ role: 'user', content: userSaid });
  console.log(`🧠 Asking Claude... (turn ${Math.ceil(history.length / 2)}, ${isOutbound ? 'OUTBOUND' : 'INBOUND'})`);

  let claudeResponse = "Sorry, could you repeat that?";

  try {
    const message = await claude.messages.create({
      model: 'claude-sonnet-4-5',
      // ⚡ Reduced from 200 → 120 — forces shorter responses, faster generation
      max_tokens: 120,
      system: isOutbound ? OUTBOUND_PROMPT(task) : INBOUND_PROMPT,
      messages: history,
    });
    claudeResponse = message.content[0].text;
    history.push({ role: 'assistant', content: claudeResponse });
    console.log('🤖 PLA FAIR:', claudeResponse);
  } catch (err) {
    console.error('Claude error:', err.message);
  }

  const reply = await speak(claudeResponse);

  res.set('Content-Type', 'text/xml');
  res.send(`
    <Response>
      ${reply}
      ${FAST_GATHER}
      <Hangup/>
    </Response>
  `);
});

// Serve cached MP3 audio
app.get('/audio/:id', (req, res) => {
  const buf = audioCache[req.params.id];
  if (!buf) return res.status(404).send('Audio not found');
  res.set('Content-Type', 'audio/mpeg');
  res.set('Content-Length', buf.length);
  res.send(buf);
});

app.get('/', (req, res) => {
  res.send('PLA FAIR server is alive!');
});

app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
  console.log(`🧠 Claude: READY`);
  console.log(`🎙️  ElevenLabs voice: ${process.env.ELEVENLABS_VOICE_ID || 'NOT SET'}`);
  console.log(`📞 Inbound calls: /voice`);
  console.log(`📤 Outbound calls: /outbound`);
  console.log(`⚡ Mode: FAST (flash model, 1s silence, short responses)`);
});