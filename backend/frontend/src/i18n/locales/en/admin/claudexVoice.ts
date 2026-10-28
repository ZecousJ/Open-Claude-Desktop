// CLAUDEX: strings for the claudexVoice console page (keys under admin.claudexVoice).
export default {
  claudexVoice: {
    title: 'Voice',
    description: 'Dictation in the Claudex desktop app, through a realtime transcription service.',
    transcription: {
      title: 'Dictation',
      description:
        'Speech to text in the composer. The desktop app streams microphone audio to this server, which relays it to the transcription service with the key below.'
    },
    upstreamUrl: 'Transcription service URL',
    upstreamUrlHint:
      'A wss:// URL (ws:// only for localhost). The key is sent in the Authorization header, never in the URL.',
    apiKey: 'API key',
    keyStored: 'Key stored',
    keyNotStored: 'No key stored. Dictation can’t be turned on until you add one.',
    keyWillBeRemoved: 'The stored key will be removed when you save, and dictation will turn off.',
    removeKey: 'Remove key',
    undoRemoveKey: 'Undo',
    apiKeyPlaceholder: 'Enter the API key',
    apiKeyReplacePlaceholder: 'Enter a new key to replace the stored one',
    apiKeyHint:
      'Write-only. The key is encrypted on this server and is never shown again or sent to the desktop app.',
    cannotStoreKey: 'This server can’t store a key until a fixed secret encryption key is configured.',
    maxSession: 'Max session length (seconds)',
    maxSessionHint: '10 to 3600. A dictation session ends after this long.',
    maxAudio: 'Max audio per session (seconds)',
    maxAudioHint: '1 to 3600 seconds of audio sent to the service in one session.',
    idleTimeout: 'Idle timeout (seconds)',
    idleTimeoutHint: '5 to 300. A session closes when no audio or text arrives for this long.',
    billing:
      'Billed as model {model} by audio length: {bytes} bytes are 1 second ({format}, {rate} Hz, {channels} channel). Each group’s audio_stt_price_per_hour sets the price.',
    problems: {
      upstreamUrl: 'Enter a wss:// URL without credentials, a fragment or a key in the query.',
      apiKey: 'Enter a key of 8 to 512 characters without spaces.',
      keyRequired: 'Add an API key before turning dictation on.',
      sessionSeconds: 'Enter a whole number from 10 to 3600.',
      audioSeconds: 'Enter a length from 1 to 3600 seconds.',
      idleSeconds: 'Enter a whole number from 5 to 300.'
    },
    fixProblems: 'Fix the highlighted fields, then save again.',
    sessions: {
      title: 'Dictation sessions',
      description:
        'Each session is billed from the audio it sent, estimated at 32,000 bytes per second. Match them with the usage records by request ID.',
      userId: 'User ID',
      anyUser: 'Any user',
      apply: 'Filter',
      clear: 'Clear',
      columns: {
        time: 'Time',
        user: 'User',
        requestId: 'Request ID',
        audio: 'Audio',
        duration: 'Session length',
        cost: 'Cost',
        ended: 'Ended'
      },
      notBilled: 'Not billed',
      endReasons: {
        finished: 'Finished',
        client_closed: 'App closed',
        upstream_closed: 'Service closed',
        upstream_failed: 'Service error',
        idle_timeout: 'Idle timeout',
        max_bytes: 'Audio limit',
        max_duration: 'Time limit',
        bad_start: 'Invalid start',
        canceled: 'Server stopped'
      },
      minutesSeconds: '{minutes} min {seconds} s',
      seconds: '{seconds} s',
      empty: 'No dictation sessions yet.',
      loadFailed: 'Could not load the dictation sessions'
    },
    errors: {
      CLAUDEX_VOICE_INVALID: 'Some voice settings aren’t valid. Check the form and try again.',
      CLAUDEX_SETTING_INVALID: 'Some values aren’t valid. Check the form and try again.'
    }
  }
}
