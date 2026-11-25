// Dictation (package C6): hands the microphone's first channel to the page,
// one render quantum at a time. Loaded with AudioWorklet.addModule.
class PcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("claudex-pcm-capture", PcmCapture);
