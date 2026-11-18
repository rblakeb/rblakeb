// Picks a browser text-to-speech voice for a character. Browsers don't say
// whether a voice is male or female, so this goes by the names the main
// platforms (macOS/iOS, Windows/Edge, Chrome/Android) give their voices.

const FEMALE = [
  "female", "woman", "samantha", "victoria", "karen", "moira", "tessa", "fiona", "ava", "allison", "susan", "zoe",
  "zira", "jenny", "aria", "michelle", "sonia", "libby", "hazel", "susan",
  "monica", "mónica", "paulina", "helena", "laura", "elvira", "dalia", "sabina", "marisol",
  "amélie", "amelie", "audrey", "aurelie", "marie", "hortense", "julie", "denise", "eloise", "brigitte",
  "anna", "petra", "helga", "hedda", "katja", "amala", "marlene", "vicki",
  "alice", "federica", "elsa", "isabella", "paola",
  "luciana", "joana", "fernanda", "maria", "francisca", "raquel", "camila",
  "kyoko", "haruka", "ayumi", "nanami", "o-ren", "sakura",
  "google us english", "google español", "google français", "google deutsch", "google italiano",
  "google português", "google 日本語",
];

const MALE = [
  "male", "man", "alex", "daniel", "fred", "aaron", "arthur", "oliver", "tom", "rishi", "gordon", "lee", "evan",
  "david", "mark", "guy", "ryan", "christopher", "eric", "brian", "george", "james", "richard",
  "jorge", "diego", "juan", "pablo", "alvaro", "álvaro", "raul", "jorge", "carlos",
  "thomas", "nicolas", "paul", "henri", "claude", "remy", "rémy",
  "markus", "yannick", "stefan", "conrad", "killian", "hans",
  "luca", "cosimo", "diego", "giorgio", "benigno",
  "felipe", "antonio", "duarte", "ricardo", "luiz",
  "otoya", "ichiro", "keita", "hattori",
];

// Higher-quality voices most platforms label this way.
const QUALITY = ["natural", "neural", "online", "premium", "enhanced", "google"];

function nameMatches(name, list) {
  // Match whole words so "Thomas" isn't caught by "tom", or "Samantha" by "man".
  const words = name.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  return list.some((entry) => (entry.includes(" ") ? name.toLowerCase().includes(entry) : words.includes(entry)));
}

export function voiceGender(voice) {
  const female = nameMatches(voice.name, FEMALE);
  const male = nameMatches(voice.name, MALE);
  if (female && !male) return "female";
  if (male && !female) return "male";
  // "Google UK English Male" matches both lists via "google"; the explicit word wins.
  if (/\bmale\b/i.test(voice.name) && !/\bfemale\b/i.test(voice.name)) return "male";
  if (/\bfemale\b/i.test(voice.name)) return "female";
  return "unknown";
}

// Returns { voice, pitch }. When no voice of the wanted gender exists for the
// language, the pitch nudges whatever voice is used toward it.
export function pickVoice(voices, lang, gender) {
  const base = lang.split("-")[0];
  let best = null;
  let bestScore = -Infinity;
  for (const voice of voices) {
    const vLang = voice.lang.replace("_", "-");
    let score;
    if (vLang === lang) score = 30;
    else if (vLang.split("-")[0] === base) score = 20;
    else continue;
    const g = voiceGender(voice);
    if (g === gender) score += 50;
    else if (g !== "unknown") score -= 50;
    if (nameMatches(voice.name, QUALITY)) score += 5;
    if (voice.localService === false) score += 1;
    if (score > bestScore) {
      best = voice;
      bestScore = score;
    }
  }
  if (!best) return { voice: null, pitch: 1 };
  const g = voiceGender(best);
  const pitch = g === gender ? 1 : gender === "male" ? 0.75 : 1.25;
  return { voice: best, pitch };
}
