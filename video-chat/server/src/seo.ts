import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Express } from "express";
import type { IntentId } from "./config.ts";

// Set SITE_URL (e.g. https://example.com) in production so canonical links,
// social previews and the sitemap point at the real domain.
const SITE_NAME = process.env.SITE_NAME ?? "Video Chat";

interface LandingPage {
  slug: string;
  intent: IntentId;
  // Short name for site-wide footer links.
  navLabel: string;
  title: string;
  description: string;
  h1: string;
  intro: string[];
  faq: { q: string; a: string }[];
  adult?: boolean;
}

// One indexable page per room, each targeting what people actually search for.
export const LANDING_PAGES: LandingPage[] = [
  {
    slug: "random-video-chat",
    navLabel: "Random video chat",
    intent: "chat",
    title: "Random Video Chat with Strangers, Matched by Interest",
    description:
      "Talk face to face with new people who are here to chat, not to waste your time. Free random video chat, matched by language and interests.",
    h1: "Random video chat with people who actually want to talk",
    intro: [
      "Most random chat sites drop you in with everyone at once, so you skip through dozens of people before finding someone who's there for the same reason you are. Here you pick what you're here for first, and we only match you with people who picked the same thing.",
      "Add your language and a few interests and we'll match you with people who share them. If nobody fits within a few seconds, we widen the search so you're never stuck waiting.",
    ],
    faq: [
      { q: "Is random video chat free?", a: "Yes. Just Chat, Music & DJ, Gaming and Language Exchange are free." },
      { q: "Do I need an account?", a: "No sign-up form. Pick a display name and start." },
      { q: "What if someone is rude or inappropriate?", a: "Tap Next to move on, or Report. Repeatedly reported accounts are banned, and explicit video is blurred automatically in non-adult rooms." },
    ],
  },
  {
    slug: "music-video-chat",
    navLabel: "Music & DJ video chat",
    intent: "music",
    title: "Music Video Chat: Jam, Play and DJ Live for Strangers",
    description:
      "Play an instrument, sing or DJ live for new people every time you hit Next. Video chat built for musicians and music lovers.",
    h1: "Video chat for musicians, singers and DJs",
    intro: [
      "Practising guitar, working on a DJ set or just want a fresh audience? The Music & DJ room only matches you with people who came for music, so nobody skips you for not being a random chat.",
      "Add tags like techno, piano or hip-hop and we'll favor people into the same sounds.",
    ],
    faq: [
      { q: "Can I DJ or play live music on video chat?", a: "Yes. That's what the Music & DJ room is for. Everyone you meet there chose music too." },
      { q: "Can I find people who like the same genre?", a: "Add genres as interests and we rank matches that share them higher." },
      { q: "Is it free?", a: "Yes, the music room is free." },
    ],
  },
  {
    slug: "gaming-video-chat",
    navLabel: "Gaming video chat",
    intent: "gaming",
    title: "Gaming Video Chat: Meet Gamers and Find Teammates",
    description:
      "Video chat with other gamers, talk about the games you play and find people to squad up with. Matched by the games you list.",
    h1: "Video chat with gamers who play what you play",
    intro: [
      "Looking for a teammate, someone to talk strategy with, or just people who get why you're still up at 3am? The Gaming room matches you only with other gamers.",
      "List your games as interests and you'll be matched with people who play them first.",
    ],
    faq: [
      { q: "How do I find people who play the same game?", a: "Add the game as an interest. Shared interests are matched first." },
      { q: "Is gaming video chat free?", a: "Yes." },
    ],
  },
  {
    slug: "language-exchange-video-chat",
    navLabel: "Language exchange",
    intent: "language",
    title: "Language Exchange Video Chat with Native Speakers",
    description:
      "Practice speaking Spanish, French, Japanese and more with native speakers on free video chat. Matched by the language you want to practice.",
    h1: "Practice a language face to face with native speakers",
    intro: [
      "Apps teach vocabulary; conversation makes it stick. The Language Exchange room matches you with people who are there to practice and help others practice, not to chat about something else.",
      "Choose the language you want to speak and we'll match you with people who speak it.",
    ],
    faq: [
      { q: "Which languages can I practice?", a: "English, Spanish, French, German, Portuguese, Italian and Japanese, with more as the community grows." },
      { q: "Is language exchange free?", a: "Yes." },
    ],
  },
  {
    slug: "adult-video-chat",
    navLabel: "Adult video chat (18+)",
    intent: "adult",
    adult: true,
    title: "Adult Video Chat for Verified 18+ Members",
    description:
      "An adult video chat room open only to members who have verified their age with ID and a live selfie. 18+ only.",
    h1: "Adult video chat for verified adults only",
    intro: [
      "The Adult 18+ room is separate from the rest of the site, and every person in it has verified their age with a government ID and a live selfie. Nobody gets in on a checkbox.",
      "Verification is handled by a specialist provider. We keep only the result, never your ID.",
    ],
    faq: [
      { q: "How is age verified?", a: "With a photo of your ID, a live selfie and a face match, handled by our verification provider." },
      { q: "Do you store my ID?", a: "No. We store only that you passed, not the document." },
      { q: "How much does it cost?", a: "Access is paid with credits; 1 credit unlocks 24 hours. Unused credits never expire and can be refunded." },
    ],
  },
];

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function renderLanding(page: LandingPage, siteUrl: string): string {
  const url = `${siteUrl}/${page.slug}`;
  const jsonLd = [
    { "@context": "https://schema.org", "@type": "WebPage", name: page.title, description: page.description, url },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: page.faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
    },
  ];
  const others = LANDING_PAGES.filter((p) => p.slug !== page.slug);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${escapeHtml(page.title)} | ${escapeHtml(SITE_NAME)}</title>
  <meta name="description" content="${escapeHtml(page.description)}" />
  <link rel="canonical" href="${url}" />
  ${page.adult ? '<meta name="rating" content="adult" />' : ""}
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="${escapeHtml(SITE_NAME)}" />
  <meta property="og:title" content="${escapeHtml(page.title)}" />
  <meta property="og:description" content="${escapeHtml(page.description)}" />
  <meta property="og:url" content="${url}" />
  <meta property="og:image" content="${siteUrl}/og-image.png" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="theme-color" content="#0f1115" />
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="icon" href="/icons/icon-192.png" />
  <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
  <link rel="stylesheet" href="/style.css" />
  <script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>
</head>
<body>
  <header class="topbar">
    <a class="brand" href="/">${escapeHtml(SITE_NAME)}</a>
  </header>
  <main class="panel landing">
    <h1>${escapeHtml(page.h1)}</h1>
    ${page.intro.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n    ")}
    <p><a class="cta" href="/?intent=${page.intent}">${page.adult ? "Verify and enter" : "Start chatting"}</a></p>
    <h2>Questions</h2>
    ${page.faq.map((f) => `<h3>${escapeHtml(f.q)}</h3>\n    <p>${escapeHtml(f.a)}</p>`).join("\n    ")}
  </main>
  ${siteFooter(others)}
</body>
</html>
`;
}

function siteFooter(pages: LandingPage[]): string {
  return `<footer class="site-footer">
    <nav>${pages.map((p) => `<a href="/${p.slug}">${escapeHtml(p.navLabel)}</a>`).join("")}</nav>
  </footer>`;
}

export function registerSeo(app: Express, publicDir: string, port: number): void {
  const siteUrl = (process.env.SITE_URL ?? `http://localhost:${port}`).replace(/\/$/, "");

  for (const page of LANDING_PAGES) {
    const html = renderLanding(page, siteUrl);
    app.get(`/${page.slug}`, (_req, res) => res.type("html").send(html));
  }

  // The app shell, with absolute URLs filled in for canonical and social tags.
  let index: Promise<string> | null = null;
  app.get(["/", "/index.html"], async (_req, res, next) => {
    try {
      index ??= readFile(path.join(publicDir, "index.html"), "utf8").then((html) =>
        html.replaceAll("%SITE_URL%", siteUrl).replaceAll("%SITE_NAME%", escapeHtml(SITE_NAME)).replace("%FOOTER%", siteFooter(LANDING_PAGES)),
      );
      res.type("html").send(await index);
    } catch (err) {
      next(err);
    }
  });

  app.get("/robots.txt", (_req, res) => {
    res.type("text/plain").send(`User-agent: *\nDisallow: /api/\nDisallow: /dev/\nDisallow: /admin/\nAllow: /\n\nSitemap: ${siteUrl}/sitemap.xml\n`);
  });

  app.get("/sitemap.xml", (_req, res) => {
    const urls = ["", ...LANDING_PAGES.map((p) => `/${p.slug}`)];
    res.type("application/xml").send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
        .map((u) => `  <url><loc>${siteUrl}${u}</loc></url>`)
        .join("\n")}\n</urlset>\n`,
    );
  });
}
