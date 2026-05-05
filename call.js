require('dotenv').config();
const twilio = require('twilio');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

console.log('📞 Calling your phone now...');

client.calls.create({
 twiml: '<Response><Say voice="Polly.Joanna">Yo, it is yaakov calling himself he has big dick. I am the future founder of pla FAIR. Pretty cool, right?</Say></Response>',
  to: process.env.MY_PHONE,
  from: process.env.TWILIO_PHONE,
})
  .then(call => {
    console.log('✅ Call started!');
    console.log('Call ID:', call.sid);
  })
  .catch(err => {
    console.error('❌ Something went wrong:');
    console.error(err.message);
  });