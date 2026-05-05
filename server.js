require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { randomUUID } = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.urlencoded({ extended: false }));

const claude = new Anthropic.default({
  apiKey: process.env.ANTHROPIC_KEY,
});

// Conversation memory — keyed by Twilio's CallSid
const conversations = {};
// Task memory — what PLA FAIR is trying to do on each call
const taskByCall = {};
const MAX_TURNS = 15;

// Audio cache — generated MP3s, served via /audio/:id
const audioCache = {};
const AUDIO_TTL_MS = 5 * 60 * 1000;

// Inbound = receiving a call (someone calls our number)
const INBOUND_PROMPT = `You are pla FAIR, a helpful personal phone-call assistant.
You're speaking to the user on a phone call. Keep responses conversational, warm, and SHORT (1-3 sentences).
Never use markdown, lists, asterisks, or special characters — your response will be read aloud by text-to-speech.
If the user says goodbye or that they're done, respond briefly and warmly.`;

// Outbound = WE'RE calling someone on the user's behalf
const OUTBOUND_PROMPT = (task) => `You are pla FAIR, a personal phone-call assistant calling on behalf of your user, Jacob.
Your task: ${task}
You're calling a business or service. The person who picks up is likely a customer service rep or an automated phone tree.

Rules:
- Keep responses very SHORT (1-2 sentences max). It's a phone call.
- Never use markdown, lists, asterisks, or special characters — text-to-speech will read this aloud.
- Be polite, warm, and professional. Sound human.
- Always identify yourself as calling on behalf of Jacob if asked.
- If they ask for sensitive info (SSN, full credit card, password), politely decline and say you'll have Jacob handle that part.
- If they ask a question you don't know the answer to, say "I'd need to confirm that with Jacob and call back."
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
        model_id: 'eleven_turbo_v2_5',
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

// ─────────────────────────────────────────────────────────────
// INBOUND CALLS — someone calls OUR Twilio number
// ─────────────────────────────────────────────────────────────

app.post('/voice', async (req, res) => {
  const callSid = req.body.CallSid;
  console.log('📞 INBOUND call:', callSid);

  conversations[callSid] = [];
  taskByCall[callSid] = null; // inbound = no specific task

  const greeting = await speak('Hello, this is pla FAIR. How can I help you today?');
  const noInput = await speak("I didn't hear anything. Goodbye.");

  res.set('Content-Type', 'text/xml');
  res.send(`
    <Response>
      ${greeting}
      <Gather input="speech" action="/heard" method="POST" speechTimeout="auto" speechModel="experimental_conversations" />
      ${noInput}
      <Hangup/>
    </Response>
  `);
});

// ─────────────────────────────────────────────────────────────
// OUTBOUND CALLS — WE call somebody on the user's behalf
// ─────────────────────────────────────────────────────────────

app.post('/outbound', async (req, res) => {
  const callSid = req.body.CallSid;
  const task = req.query.task || 'Help the user with their request';
  console.log('📞 OUTBOUND call:', callSid);
  console.log('   Task:', task);

  conversations[callSid] = [];
  taskByCall[callSid] = task;

  // First thing PLA FAIR says when they pick up
  const opener = `Hi there, I'm calling on behalf of Jacob. ${task}. Could you help me with that?`;
  const openerAudio = await speak(opener);

  // Add the opener to history so Claude knows what was already said
  conversations[callSid].push({ role: 'assistant', content: opener });

  res.set('Content-Type', 'text/xml');
  res.send(`
    <Response>
      ${openerAudio}
      <Gather input="speech" action="/heard" method="POST" speechTimeout="auto" speechModel="experimental_conversations" />
      <Hangup/>
    </Response>
  `);
});

// ─────────────────────────────────────────────────────────────
// SHARED — handles user response in BOTH inbound and outbound calls
// ─────────────────────────────────────────────────────────────

app.post('/heard', async (req, res) => {
  const callSid = req.body.CallSid;
  const userSaid = (req.body.SpeechResult || '').trim();
  const task = taskByCall[callSid];
  const isOutbound = !!task;

  console.log(`🗣️  ${isOutbound ? 'CALLEE' : 'USER'}:`, userSaid || '(silence)');

  if (!conversations[callSid]) conversations[callSid] = [];
  const history = conversations[callSid];

  // Goodbye detection
  if (userSaid && isGoodbye(userSaid)) {
    console.log('👋 Goodbye detected, ending call');
    delete conversations[callSid];
    delete taskByCall[callSid];
    const bye = await speak(isOutbound ? 'Thanks so much, have a great day!' : 'Take care! Goodbye.');
    res.set('Content-Type', 'text/xml');
    res.send(`<Response>${bye}<Hangup/></Response>`);
    return;
  }

  // Max turns safety
  if (history.length >= MAX_TURNS * 2) {
    console.log('⏱️  Max turns reached');
    delete conversations[callSid];
    delete taskByCall[callSid];
    const bye = await speak("I'll need to call back later. Thanks!");
    res.set('Content-Type', 'text/xml');
    res.send(`<Response>${bye}<Hangup/></Response>`);
    return;
  }

  // Empty input
  if (!userSaid) {
    const repeat = await speak("Sorry, I didn't catch that. Could you repeat?");
    res.set('Content-Type', 'text/xml');
    res.send(`
      <Response>
        ${repeat}
        <Gather input="speech" action="/heard" method="POST" speechTimeout="auto" speechModel="experimental_conversations" />
        <Hangup/>
      </Response>
    `);
    return;
  }

  // Add to history, send to Claude with the right system prompt
  history.push({ role: 'user', content: userSaid });
  console.log(`🧠 Asking Claude... (turn ${Math.ceil(history.length / 2)}, ${isOutbound ? 'OUTBOUND' : 'INBOUND'})`);

  let claudeResponse = "Sorry, I'm having a little trouble. Could you repeat that?";

  try {
    const message = await claude.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 200,
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
      <Gather input="speech" action="/heard" method="POST" speechTimeout="auto" speechModel="experimental_conversations" />
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
});