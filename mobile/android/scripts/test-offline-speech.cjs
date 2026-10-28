const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/offline-speech.js'), 'utf8');
function fixture(mainFrame = true) {
  const requests = [];
  const window = { claudexOfflineSpeech: { postMessage: data => requests.push(JSON.parse(data)) } };
  window.top = mainFrame ? window : {};
  const context = { window, location: { href: 'https://appassets.androidplatform.net/conversation/index.html' }, Event, EventTarget, queueMicrotask };
  vm.runInNewContext(source, context);
  return { window, requests };
}
test('canonical voice loading and utterance completion contract', () => {
  const { window: w, requests } = fixture();
  assert.equal(requests[0].type, 'voices');
  let changed = 0; w.speechSynthesis.addEventListener('voiceschanged', () => changed++, { once: true });
  w.__claudexOfflineSpeechEvent({ type: 'voices', voices: [{ name: 'Offline', voiceURI: 'offline', lang: 'en-US', localService: true }] });
  assert.equal(changed, 1); assert.equal(w.speechSynthesis.getVoices()[0].localService, true);
  const u = new w.SpeechSynthesisUtterance('First reply');
  u.voice = w.speechSynthesis.getVoices()[0]; u.rate = 1.2;
  let ended = 0; u.onend = () => ended++;
  w.speechSynthesis.speak(u);
  const request = requests.at(-1);
  assert.equal(request.voice, 'offline'); assert.equal(request.text, 'First reply'); assert.equal(request.rate, 1.2);
  w.__claudexOfflineSpeechEvent({ type: 'end', id: 'unrelated' }); assert.equal(ended, 0);
  w.__claudexOfflineSpeechEvent({ type: 'end', id: request.id });
  assert.equal(ended, 1); assert.equal(w.speechSynthesis.speaking, false);
});
test('one active utterance, cancel drains waiting chunks without replay', () => {
  const { window: w, requests } = fixture();
  let errors = 0;
  for (const text of ['one', 'two']) { const u = new w.SpeechSynthesisUtterance(text); u.onerror = () => errors++; w.speechSynthesis.speak(u); }
  assert.equal(requests.filter(r => r.type === 'speak').length, 1);
  assert.equal(w.speechSynthesis.pending, true);
  w.speechSynthesis.cancel();
  assert.equal(errors, 2); assert.equal(requests.at(-1).type, 'cancel');
  w.__claudexOfflineSpeechEvent({ type: 'end', id: 'speech-1' });
  assert.equal(requests.filter(r => r.type === 'speak').length, 1);
  assert.equal(w.speechSynthesis.pending, false);
});
test('unavailable voice ends current utterance and native stop clears state', () => {
  const { window: w, requests } = fixture();
  const u = new w.SpeechSynthesisUtterance('hello'); let error;
  u.onerror = event => error = event.error; w.speechSynthesis.speak(u);
  w.__claudexOfflineSpeechEvent({ type: 'error', id: requests.at(-1).id, error: 'voice-unavailable' });
  assert.equal(error, 'voice-unavailable'); assert.equal(w.speechSynthesis.speaking, false);
  w.speechSynthesis.speak(new w.SpeechSynthesisUtterance('again'));
  w.__claudexOfflineSpeechEvent({ type: 'cancelled' });
  assert.equal(w.speechSynthesis.speaking, false);
});
test('bounded payload rejects oversize text without a native request', async () => {
  const { window: w, requests } = fixture();
  const u = new w.SpeechSynthesisUtterance('x'.repeat(1001)); let error;
  u.onerror = event => error = event.error; w.speechSynthesis.speak(u);
  await Promise.resolve();
  assert.equal(error, 'invalid-argument'); assert.equal(requests.length, 1);
});
test('subframe never installs speech compatibility', () => {
  const { window, requests } = fixture(false);
  assert.equal(window.speechSynthesis, undefined); assert.equal(requests.length, 0);
});
test('background cancellation blocks new chunks until foreground voice refresh', async () => {
  const { window: w, requests } = fixture();
  w.speechSynthesis.speak(new w.SpeechSynthesisUtterance('first'));
  w.__claudexOfflineSpeechEvent({ type: 'cancelled' });
  const later = new w.SpeechSynthesisUtterance('later'); let error;
  later.onerror = event => error = event.error; w.speechSynthesis.speak(later);
  await Promise.resolve();
  assert.equal(error, 'canceled'); assert.equal(requests.filter(r => r.type === 'speak').length, 1);
  w.__claudexOfflineSpeechEvent({ type: 'voices', voices: [] });
  w.speechSynthesis.speak(new w.SpeechSynthesisUtterance('foreground'));
  assert.equal(requests.filter(r => r.type === 'speak').length, 2);
});
test('missing voice prevents repeated native requests for later canonical chunks', async () => {
  const { window: w, requests } = fixture();
  w.speechSynthesis.speak(new w.SpeechSynthesisUtterance('first'));
  w.__claudexOfflineSpeechEvent({ type: 'error', id: requests.at(-1).id, error: 'voice-unavailable' });
  const later = new w.SpeechSynthesisUtterance('later'); let error;
  later.onerror = event => error = event.error; w.speechSynthesis.speak(later);
  await Promise.resolve();
  assert.equal(error, 'voice-unavailable'); assert.equal(requests.filter(r => r.type === 'speak').length, 1);
});

test('retained document carries the current playback generation and ignores older audio completion', () => {
  const { window: w, requests } = fixture();
  w.__claudexOfflineSpeechEvent({ type: 'voices', context: 1, voices: [] });
  const first = new w.SpeechSynthesisUtterance('first local reply');
  w.speechSynthesis.speak(first); assert.equal(requests.at(-1).context, 1);
  w.__claudexOfflineSpeechEvent({ type: 'cancelled', context: 1 });
  w.__claudexOfflineSpeechEvent({ type: 'voices', context: 2, voices: [] });
  w.__claudexOfflineSpeechEvent({ type: 'voices', context: 1, voices: [] });
  const next = new w.SpeechSynthesisUtterance('next local reply'); let completed = 0;
  next.onend = () => completed++;
  w.speechSynthesis.speak(next); const request = requests.at(-1);
  assert.equal(request.context, 2);
  w.__claudexOfflineSpeechEvent({ type: 'end', context: 1, id: request.id });
  assert.equal(completed, 0); assert.equal(w.speechSynthesis.speaking, true);
  w.__claudexOfflineSpeechEvent({ type: 'end', context: 2, id: request.id });
  assert.equal(completed, 1);
});
