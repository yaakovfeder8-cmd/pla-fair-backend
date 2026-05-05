require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const Anthropic = require('@anthropic-ai/sdk');
const deepgramSdk = require('@deepgram/sdk');
const createDeepgramClient = deepgramSdk.createClient || deepgramSdk.default?.createClient;
const LiveTranscriptionEvents = deepgramSdk.LiveTranscriptionEvents || {
  Open: 'open',
  Close: 'close',
  Transcript: 'Results',
  Error: 'error',
};
const { randomUUID } = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

app.use(express.urlencoded({ extended: false }));

const claude = new Anthropic.default({
  apiKey: process.env.ANTHROPIC_KEY,
});

const SYSTEM_PROMPT = `You are pla FAIR, a helpful personal phone-call assistant.
You're speaking on a phone call. Keep responses VERY SHORT — 1 sentence ideally, 2 max.
Never use markdown, lists, asterisks, or special characters — your response will be read aloud.
Be warm and direct. Don't pad with filler words.`;

// ════════════════════════════════════════════════════════════════════
// LEGACY GATHER ROUTES — KEPT AS FALLBACK
// ════════════════════════════════════════════════════════════════════

const conversations = {};
const taskByCall = {};
const audioCache = {};
const AUDIO_TTL_MS = 5 * 60 * 1000;

const escapeXml = (s) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const isGoodbye = (text) => {
  const lower = text.toLowerCase().trim();
  return /\b(goodbye|good bye|bye bye|that's all|hang up|end call|talk to you later)\b/.test(lower)
    || lower === 'bye' || lower === 'thanks bye';
};

async function generateElevenLabsAudio(text) {
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const apiKey = process.env.ELEVENLABS_KEY;
  if (!voiceId || !apiKey) throw new Error('Missing ElevenLabs config');

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
      body: JSON.stringify({
        text,
        model_id: 'eleven_flash_v2_5',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    }
  );
  if (!response.ok) throw new Error(`ElevenLabs ${response.status}`);
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
    console.error('⚠️  ElevenLabs failed, fallback to Polly:', err.message);
    return `<Say voice="Polly.Joanna">${escapeXml(text)}</Say>`;
  }
}

const FAST_GATHER = `<Gather input="speech" action="/heard" method="POST" speechTimeout="1" speechModel="experimental_conversations" />`;

// Legacy /voice — Gather-based (FALLBACK)
app.post('/voice', async (req, res) => {
  const callSid = req.body.CallSid;
  console.log('📞 [LEGACY] INBOUND:', callSid);
  conversations[callSid] = [];
  taskByCall[callSid] = null;
  const greeting = await speak('Hello, this is pla FAIR. How can I help?');
  const noInput = await speak("I didn't hear anything. Goodbye.");
  res.set('Content-Type', 'text/xml');
  res.send(`<Response>${greeting}${FAST_GATHER}${noInput}<Hangup/></Response>`);
});

app.post('/heard', async (req, res) => {
  const callSid = req.body.CallSid;
  const userSaid = (req.body.SpeechResult || '').trim();
  console.log('🗣️  [LEGACY]:', userSaid || '(silence)');
  if (!conversations[callSid]) conversations[callSid] = [];
  const history = conversations[callSid];

  if (userSaid && isGoodbye(userSaid)) {
    delete conversations[callSid];
    const bye = await speak('Take care!');
    res.set('Content-Type', 'text/xml');
    res.send(`<Response>${bye}<Hangup/></Response>`);
    return;
  }
  if (!userSaid) {
    const repeat = await speak("Sorry, I didn't catch that.");
    res.set('Content-Type', 'text/xml');
    res.send(`<Response>${repeat}${FAST_GATHER}<Hangup/></Response>`);
    return;
  }
  history.push({ role: 'user', content: userSaid });
  let claudeResponse = "Sorry, could you repeat?";
  try {
    const message = await claude.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 120,
      system: SYSTEM_PROMPT,
      messages: history,
    });
    claudeResponse = message.content[0].text;
    history.push({ role: 'assistant', content: claudeResponse });
    console.log('🤖 [LEGACY]:', claudeResponse);
  } catch (err) {
    console.error('Claude error:', err.message);
  }
  const reply = await speak(claudeResponse);
  res.set('Content-Type', 'text/xml');
  res.send(`<Response>${reply}${FAST_GATHER}<Hangup/></Response>`);
});

// Audio cache route (used by legacy)
app.get('/audio/:id', (req, res) => {
  const buf = audioCache[req.params.id];
  if (!buf) return res.status(404).send('Audio not found');
  res.set('Content-Type', 'audio/mpeg');
  res.set('Content-Length', buf.length);
  res.send(buf);
});

// ════════════════════════════════════════════════════════════════════
// NEW STREAMING ROUTES — Twilio Media Streams
// ════════════════════════════════════════════════════════════════════

// Twilio hits this when a call comes in — returns TwiML that opens a stream
app.post('/stream-voice', (req, res) => {
  const callSid = req.body.CallSid;
  console.log('⚡ [STREAM] INBOUND:', callSid);
  const wsUrl = process.env.NGROK_URL.replace('https://', 'wss://') + '/stream';
  res.set('Content-Type', 'text/xml');
  res.send(`<Response>
    <Connect>
      <Stream url="${wsUrl}" />
    </Connect>
  </Response>`);
});

// WebSocket server for receiving Twilio audio
const wss = new WebSocketServer({ server, path: '/stream' });

wss.on('connection', (twilioWs) => {
  console.log('🔌 [STREAM] Twilio connected');

  let streamSid = null;
  let dgConnection = null;
  const history = [];
  let isProcessing = false; // prevents overlapping AI responses
  let elevenWs = null;

  // Set up Deepgram for live transcription
  try {
    const deepgram = createDeepgramClient(process.env.DEEPGRAM_KEY);
    dgConnection = deepgram.listen.live({
      encoding: 'mulaw',
      sample_rate: 8000,
      channels: 1,
      model: 'nova-2-phonecall',
      smart_format: true,
      punctuate: true,
      interim_results: false, // only final transcripts
      endpointing: 800, // ms of silence before considering "done"
      utterance_end_ms: 1000,
    });

    dgConnection.on(LiveTranscriptionEvents.Open, () => {
      console.log('✅ Deepgram connected');
    });

    dgConnection.on(LiveTranscriptionEvents.Transcript, async (data) => {
      const transcript = data.channel?.alternatives?.[0]?.transcript;
      if (!transcript || !transcript.trim()) return;
      if (!data.is_final) return; // ignore interim
      if (isProcessing) return; // already responding

      console.log('🗣️  USER:', transcript);
      isProcessing = true;
      history.push({ role: 'user', content: transcript });

      try {
        // Get Claude response (non-streaming for simplicity in v1)
        const message = await claude.messages.create({
          model: 'claude-sonnet-4-5',
          max_tokens: 120,
          system: SYSTEM_PROMPT,
          messages: history,
        });
        const reply = message.content[0].text;
        history.push({ role: 'assistant', content: reply });
        console.log('🤖 PLA FAIR:', reply);

        // Stream ElevenLabs audio back to Twilio in μ-law 8kHz
        await streamElevenLabsToTwilio(reply, twilioWs, streamSid);
      } catch (err) {
        console.error('AI error:', err.message);
      } finally {
        isProcessing = false;
      }
    });

    dgConnection.on(LiveTranscriptionEvents.Error, (err) => {
      console.error('Deepgram error:', err);
    });

    dgConnection.on(LiveTranscriptionEvents.Close, () => {
      console.log('🔌 Deepgram closed');
    });
  } catch (err) {
    console.error('Deepgram setup error:', err);
  }

  // Handle messages from Twilio
  twilioWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      switch (msg.event) {
        case 'connected':
          console.log('📡 Twilio Stream connected');
          break;

        case 'start':
          streamSid = msg.start.streamSid;
          console.log('▶️  Stream started:', streamSid);
          // Send greeting
          (async () => {
            const greeting = "Hello, this is pla FAIR. How can I help?";
            history.push({ role: 'assistant', content: greeting });
            await streamElevenLabsToTwilio(greeting, twilioWs, streamSid);
          })();
          break;

        case 'media':
          // Forward audio to Deepgram
          if (dgConnection && msg.media?.payload) {
            const audio = Buffer.from(msg.media.payload, 'base64');
            try {
              dgConnection.send(audio);
            } catch (err) {
              // Deepgram might be closed, ignore
            }
          }
          break;

        case 'stop':
          console.log('⏹️  Stream stopped');
          if (dgConnection) {
            try { dgConnection.requestClose(); } catch {}
          }
          break;
      }
    } catch (err) {
      console.error('Message parse error:', err);
    }
  });

  twilioWs.on('close', () => {
    console.log('🔌 Twilio WS closed');
    if (dgConnection) {
      try { dgConnection.requestClose(); } catch {}
    }
  });

  twilioWs.on('error', (err) => {
    console.error('Twilio WS error:', err);
  });
});

// Stream ElevenLabs audio (μ-law 8kHz) directly to Twilio Media Stream
async function streamElevenLabsToTwilio(text, twilioWs, streamSid) {
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const apiKey = process.env.ELEVENLABS_KEY;
  if (!voiceId || !apiKey) {
    console.error('Missing ElevenLabs config');
    return;
  }

  console.log('🎙️  Generating audio for:', text.slice(0, 50));

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=ulaw_8000`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/basic',
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_flash_v2_5',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error('ElevenLabs stream failed:', response.status, errText.slice(0, 200));
      return;
    }

    // Read stream and send chunks to Twilio
    const reader = response.body.getReader();
    let totalBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Twilio wants base64-encoded μ-law in 160-byte chunks (20ms @ 8kHz)
      // But it accepts larger chunks too. Send as we receive.
      if (value && value.length > 0 && twilioWs.readyState === 1) {
        const payload = Buffer.from(value).toString('base64');
        twilioWs.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload },
        }));
        totalBytes += value.length;
      }
    }

    console.log(`✅ Audio sent (${totalBytes} bytes)`);
  } catch (err) {
    console.error('ElevenLabs stream error:', err.message);
  }
}

// ════════════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.send('PLA FAIR server is alive! Streaming + legacy routes ready.');
});

server.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
  console.log(`🧠 Claude: READY`);
  console.log(`🎙️  ElevenLabs voice: ${process.env.ELEVENLABS_VOICE_ID || 'NOT SET'}`);
  console.log(`📞 Legacy inbound: /voice (Gather-based, slower but stable)`);
  console.log(`⚡ STREAMING inbound: /stream-voice (Media Streams, fast)`);
});