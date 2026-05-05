require('dotenv').config();
const twilio = require('twilio');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// What we want PLA FAIR to do on this call
const TASK = process.argv[2] || 'Book a license renewal appointment for late May';
const TARGET_NUMBER = process.argv[3] || process.env.MY_PHONE;

async function makeCall() {
  console.log('📞 Telling Twilio to make an outbound call...');
  console.log(`   Calling: ${TARGET_NUMBER}`);
  console.log(`   Task: ${TASK}`);

  try {
    const call = await client.calls.create({
      to: TARGET_NUMBER,
      from: process.env.TWILIO_PHONE,
      url: `${process.env.NGROK_URL}/outbound?task=${encodeURIComponent(TASK)}`,
      method: 'POST',
    });
    console.log('✅ Call started!');
    console.log('   Call SID:', call.sid);
  } catch (err) {
    console.error('❌ Error:', err.message);
  }
}

makeCall();