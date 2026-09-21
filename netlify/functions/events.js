// Netlify serverless function: fetches the public "The Cincy Edit" Google
// Calendar feed and converts it into the JSON shape the calendar page
// expects. Runs server-side on every request (Google's feed is not
// reachable directly from a browser due to CORS), with a short cache
// header so repeat visitors don't hammer Google's servers.
//
// Set the calendar's public .ics address as an environment variable named
// CINCY_CALENDAR_ICS_URL in Netlify (Project configuration > Environment
// variables). Keeping it out of the source code means it's easy to swap
// later without editing code, and keeps this file identical whether the
// URL is public or not.

const ICS_URL = process.env.CINCY_CALENDAR_ICS_URL || "";

const CATEGORY_LABEL_TO_KEY = {
  "arts & culture": "arts",
  "food & drink": "food",
  "music & nightlife": "music",
  "family friendly": "family",
  "adult events (21+)": "adult",
  "adult events": "adult",
  "free/budget-friendly": "free",
  "free / budget-friendly": "free",
  "health & fitness": "health",
  "sports": "sports"
};

function unfoldLines(raw) {
  // RFC 5545: a line starting with a single space or tab is a
  // continuation of the previous line and must be joined to it.
  const rawLines = raw.split(/\r\n|\n|\r/);
  const lines = [];
  for (const line of rawLines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

function unescapeICS(s) {
  if (!s) return "";
  return s
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function parseProp(line) {
  // "DTSTART;TZID=America/New_York:20260917T160000" ->
  // { name: "DTSTART", params: {TZID: "America/New_York"}, value: "20260917T160000" }
  const colonIdx = line.indexOf(":");
  if (colonIdx === -1) return null;
  const left = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const parts = left.split(";");
  const name = parts[0].toUpperCase();
  const params = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf("=");
    if (eq === -1) continue;
    params[parts[i].slice(0, eq).toUpperCase()] = parts[i].slice(eq + 1);
  }
  return { name, params, value };
}

function isDstEasternUTCMinus4(y, m, d) {
  // Approximate US DST rule: 2nd Sunday in March through 1st Sunday in
  // November, EDT (UTC-4); otherwise EST (UTC-5). Good enough for a
  // Cincinnati-only calendar without pulling in a timezone library.
  function nthSunday(year, month, n) {
    const first = new Date(Date.UTC(year, month, 1));
    const firstSunday = 1 + ((7 - first.getUTCDay()) % 7);
    return firstSunday + (n - 1) * 7;
  }
  const marchSecondSunday = nthSunday(y, 2, 2);
  const novFirstSunday = nthSunday(y, 10, 1);
  const date = Date.UTC(y, m - 1, d);
  const start = Date.UTC(y, 2, marchSecondSunday, 7); // 2am ET = 7am UTC (EST)
  const end = Date.UTC(y, 10, novFirstSunday, 6); // 2am ET = 6am UTC (EDT)
  return date >= start && date < end;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

// Extracts {date:"YYYY-MM-DD", time:"HH:MM"|null, allDay:bool} in
// America/New_York wall-clock terms from a DTSTART/DTEND property.
function toLocalDateTime(prop) {
  if (!prop) return null;
  const isDateOnly = prop.params.VALUE === "DATE" || /^\d{8}$/.test(prop.value);
  if (isDateOnly) {
    const v = prop.value;
    return { date: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`, time: null, allDay: true };
  }
  const m = prop.value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, , Z] = m;
  if (Z) {
    // UTC instant: convert to America/New_York wall-clock time.
    const utcMs = Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, 0);
    const offsetHours = isDstEasternUTCMinus4(+Y, +Mo, +D) ? 4 : 5;
    const local = new Date(utcMs - offsetHours * 3600 * 1000);
    return {
      date: `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`,
      time: `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`,
      allDay: false
    };
  }
  // TZID=America/New_York (or floating/no zone): treat digits as local wall clock directly.
  return { date: `${Y}-${Mo}-${D}`, time: `${H}:${Mi}`, allDay: false };
}

function parseRRule(value, allDay) {
  if (!value) return null;
  const parts = {};
  value.split(";").forEach((p) => {
    const [k, v] = p.split("=");
    if (k) parts[k.toUpperCase()] = v;
  });
  const freq = parts.FREQ;
  if (!freq) return null;
  const repeat = { freq };
  if (parts.UNTIL) {
    const u = parts.UNTIL;
    const um = u.match(/^(\d{4})(\d{2})(\d{2})/);
    if (um) repeat.until = `${um[1]}-${um[2]}-${um[3]}`;
  }
  if (freq === "MONTHLY" && parts.BYDAY) {
    const bm = parts.BYDAY.match(/^(-?\d)([A-Z]{2})$/);
    const codes = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
    if (bm) {
      repeat.monthly = { mode: "WEEKDAY", pos: parseInt(bm[1], 10), day: codes.indexOf(bm[2]) };
    }
  }
  return repeat;
}

function mapCategories(categoriesValue, descriptionValue) {
  const found = new Set();
  const scan = (text) => {
    if (!text) return;
    const lower = text.toLowerCase();
    for (const label in CATEGORY_LABEL_TO_KEY) {
      if (lower.includes(label)) found.add(CATEGORY_LABEL_TO_KEY[label]);
    }
  };
  scan(categoriesValue);
  scan(descriptionValue);
  return Array.from(found);
}

function parseICS(raw) {
  const lines = unfoldLines(raw);
  const events = [];
  let current = null;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (current) events.push(current);
      current = null;
      continue;
    }
    if (!current) continue;
    const prop = parseProp(line);
    if (!prop) continue;
    switch (prop.name) {
      case "UID":
        current.uid = prop.value;
        break;
      case "SUMMARY":
        current.summary = unescapeICS(prop.value);
        break;
      case "LOCATION":
        current.location = unescapeICS(prop.value);
        break;
      case "DESCRIPTION":
        current.description = unescapeICS(prop.value);
        break;
      case "URL":
        current.url = prop.value;
        break;
      case "CATEGORIES":
        current.categoriesRaw = unescapeICS(prop.value);
        break;
      case "DTSTART":
        current.dtstart = prop;
        break;
      case "DTEND":
        current.dtend = prop;
        break;
      case "RRULE":
        current.rrule = prop.value;
        break;
      default:
        break;
    }
  }

  const out = [];
  events.forEach((ev, idx) => {
    const start = toLocalDateTime(ev.dtstart);
    if (!start) return;
    const end = toLocalDateTime(ev.dtend) || start;
    const categories = mapCategories(ev.categoriesRaw, ev.description);
    // Strip the "| Categories: ..." trailer we append ourselves so it
    // doesn't show twice in the notes text on the page.
    const notes = (ev.description || "").replace(/\s*\|\s*Categories:.*$/i, "").trim();

    out.push({
      id: ev.uid || `evt-${idx}`,
      title: ev.summary || "Untitled event",
      categories,
      date: start.date,
      allDay: !!start.allDay,
      startTime: start.time || "00:00",
      endTime: end.time || start.time || "23:59",
      location: ev.location || "",
      link: ev.url || "",
      notes,
      repeat: parseRRule(ev.rrule, start.allDay)
    });
  });

  return out;
}

exports.parseICS = parseICS;

exports.handler = async function () {
  if (!ICS_URL) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "CINCY_CALENDAR_ICS_URL is not set" })
    };
  }
  try {
    const res = await fetch(ICS_URL);
    if (!res.ok) {
      return {
        statusCode: 502,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: `Calendar feed returned ${res.status}` })
      };
    }
    const raw = await res.text();
    const events = parseICS(raw);
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        // Cache for 5 minutes at the edge/browser so a burst of visitors
        // doesn't mean a burst of calls to Google.
        "Cache-Control": "public, max-age=300"
      },
      body: JSON.stringify({ events })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: String((err && err.message) || err) })
    };
  }
};

