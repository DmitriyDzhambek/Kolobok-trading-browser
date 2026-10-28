// Vercel serverless function: /api/news?type=list|moex
// type=list  — real headlines from a public RSS feed (Google News, Russian query).
// type=moex  — ISS connectivity probe (a status check, not a session guarantee).

const FEED_URL =
  "https://news.google.com/rss/search?q=" +
  encodeURIComponent("(EUR/USD OR евро доллар OR нефть Brent OR ключевая ставка ЦБ OR биткоин) when:1d") +
  "&hl=ru&gl=RU&ceid=RU:ru";

const FALLBACK_ITEMS = [
  { title: "Рынок ждёт решения ФРС по ставке", summary: "Инвесторы оценивают риски", icon: "🏦" },
  { title: "Нефть Brent торгуется выше $82", summary: "Геополитика поддерживает цены", icon: "🛢️" },
  { title: "EUR/USD: рост на фоне ослабления доллара", summary: "Евро набирает силу", icon: "💱" }
];

function pickIcon(text) {
  const lower = text.toLowerCase();
  if (/нефть|brent|urals|сырь/.test(lower)) return "🛢️";
  if (/биткоин|bitcoin|крипто|eth/.test(lower)) return "₿";
  if (/евро|usd|доллар|рубл|валют/.test(lower)) return "💱";
  if (/цб|банк|ставк|фрс|инфля/.test(lower)) return "🏦";
  if (/акци|индекс|бирж| Мосбирж|s&p|nasdaq/.test(lower)) return "📈";
  return "📰";
}

function decodeEntities(value) {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatMoscowTime(date) {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit", weekday: "short"
  }).formatToParts(date);
  const get = type => parts.find(p => p.type === type)?.value || "";
  const hour = `${get("hour")}:${get("minute")}`;
  const today = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow" }).format(new Date());
  const day = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow" }).format(date);
  return `${today === day ? "Сегодня" : "Вчера"}, ${hour}`;
}

function parseFeed(xml) {
  const items = [];
  const blocks = String(xml).match(/<item>([\s\S]*?)<\/item>/g) || [];
  for (const block of blocks.slice(0, 8)) {
    const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const dateMatch = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i);
    const title = decodeEntities(titleMatch?.[1] || "");
    if (!title) continue;
    const published = dateMatch ? new Date(dateMatch[1]) : null;
    items.push({
      title,
      summary: "",
      icon: pickIcon(title),
      time: published && !Number.isNaN(published.getTime()) ? formatMoscowTime(published) : "Свежо"
    });
  }
  return items;
}

async function newsList() {
  try {
    const response = await fetch(FEED_URL, {
      headers: { Accept: "application/rss+xml, application/xml", "User-Agent": "KolobokMiniApp/1.0" },
      signal: AbortSignal.timeout(6000)
    });
    if (!response.ok) throw new Error(`feed ${response.status}`);
    const items = parseFeed(await response.text());
    if (items.length < 3) throw new Error("feed too short");
    return { ok: true, source: "google-news-rss", items: items.slice(0, 6) };
  } catch {
    // Offline / blocked feed: return a clearly static list instead of failing the UI.
    const stamp = formatMoscowTime(new Date());
    return { ok: true, source: "fallback", items: FALLBACK_ITEMS.map(i => ({ ...i, time: stamp })) };
  }
}

async function moexStatus() {
  try {
    const response = await fetch("https://iss.moex.com/iss/index.json", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(6000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return {
      ok: true,
      note: "ISS API отвечает, но расписание сессий ещё не загружено. Статус торгов не подтверждён.",
      updatedAt: Date.now()
    };
  } catch {
    return { ok: false, note: "Расписание не подтверждено: источник недоступен.", updatedAt: null };
  }
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return res.status(204).end();
  const type = req.query?.type || "list";
  const payload = type === "moex" ? await moexStatus() : await newsList();
  res.setHeader("Cache-Control", type === "moex" ? "max-age=120" : "max-age=300");
  res.status(200).json(payload);
};
