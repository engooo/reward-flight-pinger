import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const webSrcRoot = path.join(projectRoot, "web");
const webDistRoot = path.join(webSrcRoot, "dist");
const webRoot = existsSync(webDistRoot) ? webDistRoot : webSrcRoot;
const configPath = path.join(projectRoot, "config.json");
const airportsCsvPath = path.join(projectRoot, "data/airports.csv");
const port = Number(process.env.PORT || 8787);
const countryNameDisplay = new Intl.DisplayNames(["en"], { type: "region" });

const watcherState = {
  process: null,
  startedAt: null,
  lastOutput: "",
};

let airportIndexPromise = null;

function jsonResponse(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function textResponse(res, statusCode, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function getConfig() {
  const raw = await fs.readFile(configPath, "utf8");
  return JSON.parse(raw);
}

async function saveConfig(config) {
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function appendWatcherOutput(value) {
  watcherState.lastOutput = `${watcherState.lastOutput}${value}`.slice(-10000);
}

function startWatcher() {
  if (watcherState.process) {
    return { started: false, reason: "already-running" };
  }

  const child = spawn(process.execPath, [path.join(projectRoot, "src/index.mjs")], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });

  watcherState.process = child;
  watcherState.startedAt = new Date().toISOString();
  watcherState.lastOutput = "";

  child.stdout.on("data", (chunk) => appendWatcherOutput(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => appendWatcherOutput(chunk.toString("utf8")));

  child.on("exit", (code, signal) => {
    appendWatcherOutput(`\n[watcher-exit] code=${String(code)} signal=${String(signal)}\n`);
    watcherState.process = null;
    watcherState.startedAt = null;
  });

  return { started: true };
}

function stopWatcher() {
  if (!watcherState.process) {
    return { stopped: false, reason: "not-running" };
  }

  watcherState.process.kill("SIGTERM");
  return { stopped: true };
}

function watcherStatus() {
  return {
    running: Boolean(watcherState.process),
    startedAt: watcherState.startedAt,
    lastOutput: watcherState.lastOutput,
  };
}

function runOneCheck() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(projectRoot, "src/index.mjs"), "--once"], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });

    child.on("exit", (code) => {
      resolve({
        ok: code === 0,
        exitCode: code,
        output: output.slice(-12000),
      });
    });
  });
}

function normalizePath(urlPathname) {
  if (!urlPathname || urlPathname === "/") {
    return "/index.html";
  }
  return urlPathname;
}

function contentTypeFor(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];

    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === "," && !inQuotes) {
      cells.push(current);
      current = "";
      continue;
    }

    current += ch;
  }

  cells.push(current);
  return cells;
}

function airportTypeRank(type) {
  if (type === "large_airport") return 3;
  if (type === "medium_airport") return 2;
  if (type === "small_airport") return 1;
  return 0;
}

async function loadAirportIndex() {
  if (airportIndexPromise) {
    return airportIndexPromise;
  }

  airportIndexPromise = (async () => {
    const csv = await fs.readFile(airportsCsvPath, "utf8");
    const lines = csv.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) {
      return [];
    }

    const header = parseCsvLine(lines[0]);
    const idx = {
      name: header.indexOf("name"),
      municipality: header.indexOf("municipality"),
      isoCountry: header.indexOf("iso_country"),
      iata: header.indexOf("iata_code"),
      type: header.indexOf("type"),
    };

    const allowedTypes = new Set(["large_airport", "medium_airport", "small_airport"]);
    const records = [];

    for (let i = 1; i < lines.length; i += 1) {
      const row = parseCsvLine(lines[i]);
      const iataCode = (row[idx.iata] || "").trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(iataCode)) {
        continue;
      }

      const airportType = (row[idx.type] || "").trim();
      if (!allowedTypes.has(airportType)) {
        continue;
      }

      const airportName = (row[idx.name] || "").trim();
      const city = (row[idx.municipality] || "").trim();
      const country = (row[idx.isoCountry] || "").trim();
      const countryName = country ? countryNameDisplay.of(country) || country : "";
      const label = `${iataCode} - ${airportName}${city ? ` (${city})` : ""}${country ? ` [${country}]` : ""}`;

      records.push({
        iataCode,
        airportName,
        city,
        country,
        countryName,
        airportType,
        label,
        search: `${iataCode} ${airportName} ${city} ${country} ${countryName}`.toLowerCase(),
      });
    }

    const byCode = new Map();
    for (const record of records) {
      const existing = byCode.get(record.iataCode);
      if (!existing) {
        byCode.set(record.iataCode, record);
        continue;
      }

      const existingScore = (existing.airportName ? existing.airportName.length : 0) + (existing.city ? existing.city.length : 0);
      const nextScore = (record.airportName ? record.airportName.length : 0) + (record.city ? record.city.length : 0);
      if (nextScore > existingScore) {
        byCode.set(record.iataCode, record);
      }
    }

    return [...byCode.values()].sort((a, b) => a.iataCode.localeCompare(b.iataCode));
  })();

  return airportIndexPromise;
}

async function searchAirports(query, limitRaw) {
  const limit = Math.min(300, Math.max(1, Number(limitRaw) || 20));
  const index = await loadAirportIndex();
  const q = (query || "").trim().toLowerCase();

  if (!q) {
    return index.slice(0, limit).map(({ search, ...rest }) => rest);
  }

  const scored = [];

  for (const airport of index) {
    const code = airport.iataCode.toLowerCase();
    const name = airport.airportName.toLowerCase();
    const city = airport.city.toLowerCase();
    const country = airport.country.toLowerCase();
    const countryName = String(airport.countryName || "").toLowerCase();
    const tokens = `${code} ${name} ${city} ${country} ${countryName}`.split(/[^a-z0-9]+/).filter(Boolean);

    let score = -1;

    if (code === q) {
      score = 1000;
    } else if (code.startsWith(q)) {
      score = 950;
    } else if (city === q) {
      score = 900;
    } else if (city.startsWith(q)) {
      score = 850;
    } else if (name === q) {
      score = 800;
    } else if (name.startsWith(q)) {
      score = 760;
    } else if (countryName === q) {
      score = 740;
      score += airportTypeRank(airport.airportType) * 10;
      if (airport.city) {
        score += 4;
      }
    } else if (countryName.startsWith(q)) {
      score = 700;
      score += airportTypeRank(airport.airportType) * 6;
      if (airport.city) {
        score += 2;
      }
    } else if (tokens.some((token) => token === q)) {
      score = 720;
    } else if (tokens.some((token) => token.startsWith(q))) {
      score = 680;
    } else {
      const nameIndex = name.indexOf(q);
      const cityIndex = city.indexOf(q);
      const countryIndex = countryName.indexOf(q);
      const searchIndex = airport.search.indexOf(q);

      if (cityIndex >= 0) {
        score = 620 - cityIndex;
      } else if (nameIndex >= 0) {
        score = 580 - nameIndex;
      } else if (countryIndex >= 0) {
        score = 560 - countryIndex;
      } else if (searchIndex >= 0) {
        score = 520 - searchIndex;
      }
    }

    if (score < 0) {
      continue;
    }

    if (airport.country === "AU") {
      score += 5;
    }

    scored.push({ airport, score });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    const aTypeRank = airportTypeRank(a.airport.airportType);
    const bTypeRank = airportTypeRank(b.airport.airportType);
    if (aTypeRank !== bTypeRank) {
      return bTypeRank - aTypeRank;
    }
    const aCity = a.airport.city || "";
    const bCity = b.airport.city || "";
    const aHasCity = aCity.length > 0;
    const bHasCity = bCity.length > 0;
    if (aHasCity !== bHasCity) {
      return aHasCity ? -1 : 1;
    }
    if (a.airport.city !== b.airport.city) {
      return a.airport.city.localeCompare(b.airport.city);
    }
    return a.airport.iataCode.localeCompare(b.airport.iataCode);
  });

  return scored.slice(0, limit).map(({ airport }) => {
    const { search, ...rest } = airport;
    return rest;
  });
}

async function serveStatic(req, res, pathname) {
  const relativePath = normalizePath(pathname);
  const requestedPath = path.normalize(relativePath).replace(/^\.\.(\/|\\|$)/, "");
  const filePath = path.join(webRoot, requestedPath);

  if (!filePath.startsWith(webRoot)) {
    textResponse(res, 403, "Forbidden");
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentTypeFor(filePath),
      "Content-Length": data.length,
      "Cache-Control": "no-store",
    });
    res.end(data);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      textResponse(res, 404, "Not Found");
      return;
    }
    textResponse(res, 500, `Error serving file: ${error.message}`);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/api/config" && req.method === "GET") {
      const config = await getConfig();
      jsonResponse(res, 200, { ok: true, config });
      return;
    }

    if (url.pathname === "/api/config" && req.method === "POST") {
      const body = await readBody(req);
      const parsed = JSON.parse(body || "{}");
      if (!parsed || typeof parsed !== "object") {
        jsonResponse(res, 400, { ok: false, error: "Invalid config payload" });
        return;
      }
      await saveConfig(parsed);
      jsonResponse(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/api/airports" && req.method === "GET") {
      const q = url.searchParams.get("q") || "";
      const limit = url.searchParams.get("limit") || "20";
      const items = await searchAirports(q, limit);
      jsonResponse(res, 200, { ok: true, items });
      return;
    }

    if (url.pathname === "/api/check" && req.method === "POST") {
      const result = await runOneCheck();
      jsonResponse(res, 200, result);
      return;
    }

    if (url.pathname === "/api/watcher/status" && req.method === "GET") {
      jsonResponse(res, 200, { ok: true, ...watcherStatus() });
      return;
    }

    if (url.pathname === "/api/watcher/start" && req.method === "POST") {
      const result = startWatcher();
      jsonResponse(res, 200, { ok: true, ...result, ...watcherStatus() });
      return;
    }

    if (url.pathname === "/api/watcher/stop" && req.method === "POST") {
      const result = stopWatcher();
      jsonResponse(res, 200, { ok: true, ...result, ...watcherStatus() });
      return;
    }

    await serveStatic(req, res, url.pathname);
  } catch (error) {
    jsonResponse(res, 500, { ok: false, error: error.message });
  }
});

server.listen(port, () => {
  console.log(`Dashboard running at http://localhost:${port}`);
});
