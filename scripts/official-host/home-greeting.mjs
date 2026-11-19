const messages = {
  "en": [
    "Good morning",
    "Good afternoon",
    "Good evening",
    "Good morning, {name}",
    "Good afternoon, {name}",
    "Good evening, {name}",
    "Back at it, {name}",
    "Let’s noodle",
    "Afternoon, {name}",
    "Evening, how are things?",
    "Evening thoughts"
  ],
  "zh": [
    "早上好",
    "下午好",
    "晚上好",
    "早上好，{name}",
    "下午好，{name}",
    "晚上好，{name}",
    "又见面了，{name}",
    "一起来琢磨吧",
    "午后好，{name}",
    "晚上好，一切还好吗？",
    "晚间思绪"
  ],
  "ja": [
    "おはようございます",
    "こんにちは",
    "こんばんは",
    "おはようございます、{name}さん",
    "こんにちは、{name}さん",
    "こんばんは、{name}さん",
    "おかえりなさい、{name}さん",
    "一緒に考えよう",
    "{name}さん、こんにちは",
    "こんばんは、調子はどうですか？",
    "夜の思索"
  ],
  "ko": [
    "좋은 아침이에요",
    "안녕하세요",
    "좋은 저녁이에요",
    "좋은 아침이에요, {name}님",
    "안녕하세요, {name}님",
    "좋은 저녁이에요, {name}님",
    "다시 시작해볼까요, {name}님",
    "같이 생각해봐요",
    "{name}님, 좋은 오후예요",
    "좋은 저녁이에요, 어떻게 지내세요?",
    "저녁의 생각"
  ],
  "de": [
    "Guten Morgen",
    "Guten Tag",
    "Guten Abend",
    "Guten Morgen, {name}",
    "Guten Tag, {name}",
    "Guten Abend, {name}",
    "Weiter geht’s, {name}",
    "Lass uns tüfteln",
    "Schönen Nachmittag, {name}",
    "Guten Abend, wie läuft’s?",
    "Abendgedanken"
  ],
  "fr": [
    "Bonjour",
    "Bon après-midi",
    "Bonsoir",
    "Bonjour, {name}",
    "Bon après-midi, {name}",
    "Bonsoir, {name}",
    "De retour, {name}",
    "Réfléchissons ensemble",
    "Bel après-midi, {name}",
    "Bonsoir, comment ça va ?",
    "Pensées du soir"
  ],
  "es": [
    "Buenos días",
    "Buenas tardes",
    "Buenas noches",
    "Buenos días, {name}",
    "Buenas tardes, {name}",
    "Buenas noches, {name}",
    "De vuelta al trabajo, {name}",
    "Pensemos juntos",
    "Buena tarde, {name}",
    "Buenas noches, ¿cómo va todo?",
    "Pensamientos de la noche"
  ],
  "it": [
    "Buongiorno",
    "Buon pomeriggio",
    "Buonasera",
    "Buongiorno, {name}",
    "Buon pomeriggio, {name}",
    "Buonasera, {name}",
    "Di nuovo al lavoro, {name}",
    "Ragioniamoci su",
    "Pomeriggio, {name}",
    "Buonasera, come va?",
    "Pensieri serali"
  ],
  "pt": [
    "Bom dia",
    "Boa tarde",
    "Boa noite",
    "Bom dia, {name}",
    "Boa tarde, {name}",
    "Boa noite, {name}",
    "De volta à ação, {name}",
    "Vamos pensar juntos",
    "Boa tarde por aí, {name}",
    "Boa noite, como vão as coisas?",
    "Pensamentos da noite"
  ],
  "id": [
    "Selamat pagi",
    "Selamat siang",
    "Selamat malam",
    "Selamat pagi, {name}",
    "Selamat siang, {name}",
    "Selamat malam, {name}",
    "Kembali lagi, {name}",
    "Yuk berpikir bersama",
    "Siang, {name}",
    "Selamat malam, apa kabar?",
    "Renungan malam"
  ],
  "hi": [
    "सुप्रभात",
    "नमस्कार",
    "शुभ संध्या",
    "सुप्रभात, {name}",
    "नमस्कार, {name}",
    "शुभ संध्या, {name}",
    "फिर से शुरू करें, {name}",
    "चलिए सोचते हैं",
    "दोपहर की नमस्ते, {name}",
    "शुभ संध्या, सब कैसा चल रहा है?",
    "शाम के विचार"
  ],
  "zh-hant": [
    "早安",
    "午安",
    "晚安",
    "早安，{name}",
    "午安，{name}",
    "晚安，{name}",
    "又見面了，{name}",
    "一起來琢磨吧",
    "午後好，{name}",
    "晚安，一切還好嗎？",
    "晚間思緒"
  ]
};

export function homeGreetingChoices(locale, hour, name = "") {
  const tag = String(locale).toLowerCase().replaceAll("_", "-");
  const language = /^zh-(hant|tw|hk)(-|$)/.test(tag) ? "zh-hant" : tag.split("-")[0];
  const text = messages[language] ?? messages.en;
  const period = hour >= 5 && hour < 12 ? 0 : hour >= 12 && hour < 17 ? 1 : 2;
  const who = name.trim();
  const indices = [
    period,
    ...(who ? [period + 3, 6] : []),
    ...(who && period === 1 ? [8] : []),
    7,
    ...(period === 2 ? [9, 10] : []),
  ];
  return indices.map(index => text[index].replace("{name}", who));
}

export function homeGreeting(locale, hour, name, roll) {
  const choices = homeGreetingChoices(locale, hour, name);
  return choices[Math.min(choices.length - 1, Math.max(0, Math.floor(roll * choices.length)))];
}

export function homeGreetingForAccount(previous, locale, hour, account, roll) {
  if (!account) return "";
  const key = JSON.stringify([account.uuid, locale, hour >= 5 && hour < 12 ? 0 : hour >= 12 && hour < 17 ? 1 : 2]);
  if (previous.key !== key) {
    previous.key = key;
    previous.text = homeGreeting(locale, hour, account.display_name ?? "", roll);
  }
  return previous.text;
}
