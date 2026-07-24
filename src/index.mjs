import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import nodemailer from "nodemailer";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 15000;
const CABINS = ["Economy", "PremiumEconomy", "Business", "First"];

function parseArgs(argv) {
  const args = {
    configPath: null,
    once: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--once") {
      args.once = true;
      continue;
    }
    if (token === "--config" && argv[i + 1]) {
      args.configPath = argv[i + 1];
      i += 1;
    }
  }

  return args;
}

async function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJson(filePath, data) {
  await ensureDir(filePath);
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function todayMonth() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = `${now.getUTCMonth() + 1}`.padStart(2, "0");
  return `${year}-${month}`;
}

function normalizeArray(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

function normalizeRangeObject(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const from = String(raw.from || "").trim();
  const to = String(raw.to || "").trim();
  if (!isValidIsoDate(from) || !isValidIsoDate(to)) {
    return null;
  }
  return from <= to ? { from, to } : { from: to, to: from };
}

function unionStrings(arrays) {
  const result = new Set();
  for (const arr of arrays || []) {
    if (!Array.isArray(arr)) continue;
    for (const value of arr) {
      if (value) {
        result.add(String(value).trim());
      }
    }
  }
  return [...result];
}

function normalizeWatchGroup(raw) {
  return {
    originAirports: normalizeArray(raw.originAirports),
    originRegions: normalizeArray(raw.originRegions),
    destinationAirports: normalizeArray(raw.destinationAirports),
    destinationRegions: normalizeArray(raw.destinationRegions),
    watchDates: normalizeArray(raw.watchDates).filter(isValidIsoDate),
    watchDateRanges: Array.isArray(raw.watchDateRanges)
      ? raw.watchDateRanges.map(normalizeRangeObject).filter(Boolean)
      : [],
    weekdays: normalizeArray(raw.weekdays),
    excludeDates: normalizeArray(raw.excludeDates).filter(isValidIsoDate),
  };
}

function sanitizeConfig(rawConfig) {
  const cfg = { ...rawConfig };
  cfg.apiBaseUrl = cfg.apiBaseUrl || "https://flightrewardfinder.qantas.com/api/availability";
  cfg.searchApiBaseUrl = cfg.searchApiBaseUrl || "https://flightrewardfinder.qantas.com/api/search";
  const rootGroup = {
    originAirports: normalizeArray(cfg.originAirports),
    originRegions: normalizeArray(cfg.originRegions),
    destinationAirports: normalizeArray(cfg.destinationAirports),
    destinationRegions: normalizeArray(cfg.destinationRegions),
    watchDates: normalizeArray(cfg.watchDates).filter(isValidIsoDate),
    watchDateRanges: Array.isArray(cfg.watchDateRanges)
      ? cfg.watchDateRanges.map(normalizeRangeObject).filter(Boolean)
      : [],
    weekdays: normalizeArray(cfg.weekdays),
    excludeDates: normalizeArray(cfg.excludeDates).filter(isValidIsoDate),
  };

  cfg.originAirports = rootGroup.originAirports;
  cfg.originRegions = rootGroup.originRegions;
  cfg.destinationAirports = rootGroup.destinationAirports;
  cfg.destinationRegions = rootGroup.destinationRegions;
  cfg.watchDates = rootGroup.watchDates;
  cfg.watchDateRanges = rootGroup.watchDateRanges;
  cfg.weekdays = rootGroup.weekdays;
  cfg.excludeDates = rootGroup.excludeDates;
  cfg.passengers = Number.isInteger(cfg.passengers) ? cfg.passengers : 1;
  cfg.stops = normalizeStopsForAvailability(Array.isArray(cfg.stops) ? cfg.stops : ["direct"]);
  cfg.startMonth = cfg.startMonth === "auto" ? todayMonth() : cfg.startMonth;
  cfg.monthCount = Number.isInteger(cfg.monthCount) ? cfg.monthCount : 4;
  cfg.seatFilters = cfg.seatFilters && typeof cfg.seatFilters === "object" ? cfg.seatFilters : {};
  cfg.seatFilterMode = cfg.seatFilterMode === "all" ? "all" : "any";
  cfg.pollMinutes = Number.isFinite(cfg.pollMinutes) ? cfg.pollMinutes : 15;
  cfg.runImmediately = cfg.runImmediately !== false;
  cfg.alertOnChangesOnly = cfg.alertOnChangesOnly !== true;
  cfg.stateFile = cfg.stateFile || ".state/seen.json";
  cfg.requestTimeoutMs = Number.isFinite(cfg.requestTimeoutMs) ? cfg.requestTimeoutMs : DEFAULT_TIMEOUT_MS;
  cfg.searchPagesMax = Number.isFinite(cfg.searchPagesMax) ? Math.max(1, Math.floor(cfg.searchPagesMax)) : 8;
  cfg.alertSinks = cfg.alertSinks && typeof cfg.alertSinks === "object" ? cfg.alertSinks : {};
  cfg.alertSinks.console = cfg.alertSinks.console !== false;
  cfg.alertSinks.discordWebhookUrl = cfg.alertSinks.discordWebhookUrl || "";
  cfg.alertSinks.ntfyTopicUrl = cfg.alertSinks.ntfyTopicUrl || "";
  cfg.alertSinks.macOsNotification = cfg.alertSinks.macOsNotification === true;
  cfg.alertSinks.telegram = cfg.alertSinks.telegram === true;
  cfg.alertSinks.email = cfg.alertSinks.email === true;
  cfg.alertSinks.emailTo = cfg.alertSinks.emailTo || "";
  cfg.testPing = cfg.testPing === true;

  cfg.watchGroups = Array.isArray(cfg.watchGroups)
    ? cfg.watchGroups.map(normalizeWatchGroup)
    : [normalizeWatchGroup(rootGroup)];

  if (cfg.watchGroups.length === 0) {
    throw new Error("Config requires at least one watch group.");
  }

  for (const group of cfg.watchGroups) {
    if (!group.originAirports.length && !group.originRegions.length) {
      throw new Error("Each watch group requires at least one origin airport or region.");
    }
    if (!group.destinationAirports.length && !group.destinationRegions.length) {
      throw new Error("Each watch group requires at least one destination airport or region.");
    }
  }

  return cfg;
}

function normalizeStopsForAvailability(stops) {
  const values = (Array.isArray(stops) ? stops : [])
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);

  if (values.length === 0) {
    return ["direct"];
  }

  const hasDirect = values.includes("direct");
  const hasNonDirect = values.some((value) => value !== "direct");

  // Availability API only accepts direct-only or no stops filter.
  if (hasDirect && !hasNonDirect) {
    return ["direct"];
  }

  return [];
}

function routeLabelForGroup(group) {
  const origin = group.originAirports.length > 0 ? group.originAirports.join(",") : group.originRegions.join(",") || "*";
  const destination = group.destinationAirports.length > 0 ? group.destinationAirports.join(",") : group.destinationRegions.join(",") || "*";
  return `${origin} -> ${destination}`;
}

function makeAvailabilityUrl(cfg, group) {
  const url = new URL(cfg.apiBaseUrl);

  url.searchParams.set(
    "origin",
    JSON.stringify({ airports: group.originAirports, regions: group.originRegions })
  );
  url.searchParams.set(
    "destination",
    JSON.stringify({ airports: group.destinationAirports, regions: group.destinationRegions })
  );
  url.searchParams.set("passengers", String(cfg.passengers));
  url.searchParams.set("stops", JSON.stringify(cfg.stops));
  url.searchParams.set("startMonth", cfg.startMonth);
  url.searchParams.set("monthCount", String(cfg.monthCount));

  return url;
}

function makeSearchUrl(cfg, group, page) {
  const url = new URL(cfg.searchApiBaseUrl);
  const stops = cfg.stops[0] || "direct";
  const origin = Array.isArray(group.originAirports) && group.originAirports.length > 0
    ? group.originAirports.join(",")
    : Array.isArray(group.originRegions) && group.originRegions.length > 0
      ? group.originRegions.join(",")
      : "";
  const destination = Array.isArray(group.destinationAirports) && group.destinationAirports.length > 0
    ? group.destinationAirports.join(",")
    : Array.isArray(group.destinationRegions) && group.destinationRegions.length > 0
      ? group.destinationRegions.join(",")
      : "";

  url.searchParams.set("o", origin);
  url.searchParams.set("d", destination);
  url.searchParams.set("st", stops);
  url.searchParams.set("p", String(cfg.passengers));
  url.searchParams.set("page", String(page));

  return url;
}

async function fetchJson(url, timeoutMs) {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "reward-seat-pinger/0.1",
      },
      signal: abortController.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from availability API`);
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function isValidIsoDate(dateString) {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateString);
}

function getWeekday(dateString) {
  const date = new Date(`${dateString}T00:00:00Z`);
  return date.getUTCDay();
}

function normalizeWeekday(value) {
  if (typeof value === "number" && value >= 0 && value <= 6) {
    return value;
  }

  const map = {
    sun: 0,
    sunday: 0,
    mon: 1,
    monday: 1,
    tue: 2,
    tuesday: 2,
    wed: 3,
    wednesday: 3,
    thu: 4,
    thursday: 4,
    fri: 5,
    friday: 5,
    sat: 6,
    saturday: 6,
  };

  if (typeof value === "string") {
    const key = value.trim().toLowerCase();
    if (key in map) {
      return map[key];
    }
  }

  return null;
}

function dateInRanges(dateString, ranges) {
  for (const range of ranges) {
    if (!range || typeof range !== "object") {
      continue;
    }
    const from = range.from;
    const to = range.to;
    if (!isValidIsoDate(from) || !isValidIsoDate(to)) {
      continue;
    }
    if (dateString >= from && dateString <= to) {
      return true;
    }
  }
  return false;
}

function passesDateFilters(dateString, group) {
  if (!isValidIsoDate(dateString)) {
    return false;
  }

  if (group.excludeDates.includes(dateString)) {
    return false;
  }

  const hasDateSelectors = group.watchDates.length > 0 || group.watchDateRanges.length > 0;
  if (hasDateSelectors) {
    const inList = group.watchDates.includes(dateString);
    const inRanges = dateInRanges(dateString, group.watchDateRanges);
    if (!inList && !inRanges) {
      return false;
    }
  }

  if (group.weekdays.length > 0) {
    const allowedDays = new Set(
      group.weekdays
        .map(normalizeWeekday)
        .filter((day) => day !== null)
    );
    if (!allowedDays.has(getWeekday(dateString))) {
      return false;
    }
  }

  return true;
}

function evaluateSeatHits(cabinSeatMap, cfg) {
  const filters = Object.entries(cfg.seatFilters)
    .filter(([cabin]) => CABINS.includes(cabin))
    .map(([cabin, minSeats]) => [cabin, Number(minSeats)]);

  if (filters.length === 0) {
    return CABINS
      .map((cabin) => [cabin, Number(cabinSeatMap[cabin] || 0)])
      .filter(([, seats]) => seats > 0)
      .map(([cabin, seats]) => ({ cabin, seats }));
  }

  const hits = [];
  for (const [cabin, minSeats] of filters) {
    const seats = Number(cabinSeatMap[cabin] || 0);
    if (Number.isFinite(minSeats) && seats >= minSeats) {
      hits.push({ cabin, seats, minSeats });
    }
  }

  if (cfg.seatFilterMode === "all" && hits.length !== filters.length) {
    return [];
  }

  return hits;
}

function buildMatches(availabilityMap, cfg, group) {
  const matches = [];
  for (const [date, cabinSeatMap] of Object.entries(availabilityMap)) {
    if (!passesDateFilters(date, group)) {
      continue;
    }

    const hits = evaluateSeatHits(cabinSeatMap, cfg);
    if (!hits.length) {
      continue;
    }

    matches.push({
      date,
      hits,
      group,
    });
  }

  matches.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return matches;
}

function formatPoints(points) {
  const value = Number(points || 0);
  return `${value.toLocaleString("en-AU")} pts`;
}

function formatCash(currency, tax) {
  const value = Number(tax || 0);
  const currencyLabel = currency || "AU$";
  if (Number.isFinite(value)) {
    return `${currencyLabel}${value.toLocaleString("en-AU")}`;
  }
  return `${currencyLabel}0`;
}

function parseIsoDuration(isoDuration) {
  if (typeof isoDuration === "number" && Number.isFinite(isoDuration)) {
    return Math.round(isoDuration);
  }
  if (!isoDuration || typeof isoDuration !== "string") {
    return null;
  }

  const trimmed = isoDuration.trim();
  const isoMatch = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?$/i.exec(trimmed);
  if (isoMatch) {
    const days = Number(isoMatch[1] || 0);
    const hours = Number(isoMatch[2] || 0);
    const minutes = Number(isoMatch[3] || 0);
    return days * 24 * 60 + hours * 60 + minutes;
  }

  const clockMatch = /^(\d+):(\d{2})$/.exec(trimmed);
  if (clockMatch) {
    return Number(clockMatch[1]) * 60 + Number(clockMatch[2]);
  }

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    return Math.round(numeric);
  }

  return null;
}

function formatMinutesAsHoursMinutes(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return null;
  }
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  if (hours > 0) {
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
  return `${mins}m`;
}

function formatDurationValue(value) {
  const minutes = parseIsoDuration(value);
  if (minutes !== null) {
    return formatMinutesAsHoursMinutes(minutes);
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return null;
}

function getDurationMinutes(departsAt, arrivesAt) {
  if (!departsAt || !arrivesAt) {
    return null;
  }
  const start = new Date(departsAt);
  const end = new Date(arrivesAt);
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf())) {
    return null;
  }
  const diff = Math.round((end.valueOf() - start.valueOf()) / 60000);
  return diff >= 0 ? diff : null;
}

function normalizeFlightLeg(leg) {
  if (!leg || typeof leg !== "object") {
    return null;
  }
  return {
    departsAt: String(leg.departsAt || leg.departureAt || leg.startAt || ""),
    arrivesAt: String(leg.arrivesAt || leg.arrivalAt || leg.endAt || ""),
    originCode: String(leg.origin?.code || leg.originCode || "").trim(),
    originName: String(leg.origin?.name || leg.originName || "").trim(),
    destinationCode: String(leg.destination?.code || leg.destinationCode || "").trim(),
    destinationName: String(leg.destination?.name || leg.destinationName || "").trim(),
    duration: String(leg.duration || leg.durationMinutes || leg.travelTime || "").trim(),
    layoverDuration: String(leg.connectionDuration || leg.layoverDuration || leg.stopoverDuration || "").trim(),
  };
}

function buildFlightLegs(flight) {
  const rawLegs = Array.isArray(flight?.legs)
    ? flight.legs
    : Array.isArray(flight?.segments)
      ? flight.segments
      : [];

  return rawLegs
    .map(normalizeFlightLeg)
    .filter((leg) => leg && (leg.departsAt || leg.arrivesAt || leg.originCode || leg.destinationCode));
}

function formatFlightSegmentLine(segment, isLast) {
  const departureTime = formatTimeFromIso(segment.departsAt);
  const arrivalTime = formatTimeFromIso(segment.arrivesAt);
  const origin = segment.originCode || "?";
  const destination = segment.destinationCode || "?";
  const durationText = formatDurationValue(segment.duration) || formatDurationValue(getDurationMinutes(segment.departsAt, segment.arrivesAt));
  const durationPart = durationText ? ` | ${durationText}` : "";
  const branch = isLast ? "└" : "├";
  return `  ${branch} ${departureTime} ${origin} → ${arrivalTime} ${destination}${durationPart}`;
}

function formatLayoverLine(previousSegment, nextSegment) {
  const waitMinutes = getDurationMinutes(previousSegment.arrivesAt, nextSegment.departsAt);
  const layoverText = formatDurationValue(previousSegment.layoverDuration) || formatMinutesAsHoursMinutes(waitMinutes);
  if (!layoverText) {
    return null;
  }
  const location = nextSegment.originCode || nextSegment.originName || "connection";
  return `    ⏳ ${layoverText} layover at ${location}`;
}

function renderFlightDetailLines(matchDate, detail, hit) {
  const departs = formatTimeFromIso(detail.departsAt);
  const arrives = formatTimeFromIso(detail.arrivesAt);
  const originCode = detail.originCode || "";
  const destinationCode = detail.destinationCode || "";
  const originLabel = originCode || detail.originName || "?";
  const destinationLabel = destinationCode || detail.destinationName || "?";
  const durationText =
    formatDurationValue(detail.duration) || formatDurationValue(getDurationMinutes(detail.departsAt, detail.arrivesAt));

  const priceText = `${formatPoints(detail.points)} + ${formatCash(detail.currency, detail.tax)}`;
  const summaryParts = [
    `📅 ${matchDate}`,
    `✈️ ${departs} ${originLabel} → ${arrives} ${destinationLabel}`,
    `💺 ${hit.cabin}`,
  ];
  if (durationText) {
    summaryParts.push(`⏱ ${durationText}`);
  }
  summaryParts.push(`💰 ${priceText}`);
  summaryParts.push(`🪑 ${detail.seats} spots left`);

  const lines = [`• ${summaryParts.join(" | ")}`];
  lines.push(`  📍 ${originLabel} → ${destinationLabel}`);
  lines.push(`  💵 ${priceText}`);

  if (detail.originName || detail.destinationName) {
    const originText = detail.originName ? `${originLabel} (${detail.originName})` : originLabel;
    const destinationText = detail.destinationName ? `${destinationLabel} (${detail.destinationName})` : destinationLabel;
    lines.push(`  ${originText} → ${destinationText}`);
  }

  if (Array.isArray(detail.legs) && detail.legs.length > 0) {
    for (let index = 0; index < detail.legs.length; index += 1) {
      const segment = detail.legs[index];
      lines.push(formatFlightSegmentLine(segment, index === detail.legs.length - 1));
      if (index < detail.legs.length - 1) {
        const layoverLine = formatLayoverLine(segment, detail.legs[index + 1]);
        if (layoverLine) {
          lines.push(layoverLine);
        }
      }
    }
  }

  return lines;
}

function parseBooleanEnv(value) {
  if (!value) {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function formatTimeFromIso(iso) {
  if (!iso || typeof iso !== "string" || iso.length < 16) {
    return "--:--";
  }

  const raw = iso.slice(11, 16);
  const [hourRaw, minuteRaw] = raw.split(":");
  const hour = Number(hourRaw);
  if (!Number.isInteger(hour) || !minuteRaw) {
    return raw;
  }

  const suffix = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${minuteRaw} ${suffix}`;
}

function weekdayLabel(dateString) {
  const date = new Date(`${dateString}T00:00:00Z`);
  return date.toLocaleDateString("en-AU", { weekday: "short", timeZone: "UTC" });
}

function formatLongDate(dateString) {
  const date = new Date(`${dateString}T00:00:00Z`);
  return date.toLocaleDateString("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function getDateFromIso(iso) {
  if (!iso || typeof iso !== "string" || iso.length < 10) {
    return null;
  }
  return iso.slice(0, 10);
}

async function fetchFlightDetails(cfg, group) {
  const flights = [];
  const seenIds = new Set();
  const activeGroup = group || {
    originAirports: cfg.originAirports,
    destinationAirports: cfg.destinationAirports,
  };

  for (let page = 1; page <= cfg.searchPagesMax; page += 1) {
    const url = makeSearchUrl(cfg, activeGroup, page);
    const data = await fetchJson(url, cfg.requestTimeoutMs);
    const pageFlights = Array.isArray(data?.flights) ? data.flights : [];

    if (pageFlights.length === 0) {
      break;
    }

    let newCount = 0;
    for (const flight of pageFlights) {
      const id = String(flight?.id ?? "");
      if (id && seenIds.has(id)) {
        continue;
      }
      if (id) {
        seenIds.add(id);
      }
      flights.push(flight);
      newCount += 1;
    }

    if (newCount === 0) {
      break;
    }
  }

  return flights;
}

function buildFlightDetailIndex(flights) {
  const index = new Map();

  for (const flight of flights) {
    const date = getDateFromIso(flight?.departsAt);
    if (!date) {
      continue;
    }

    const originCode = flight?.origin?.code || "";
    const destinationCode = flight?.destination?.code || "";

    for (const cabin of CABINS) {
      const cabinData = flight?.cabins?.[cabin];
      const seats = Number(cabinData?.seats || 0);
      if (!cabinData || seats <= 0) {
        continue;
      }

      const key = `${date}|${cabin}`;
      const routeKey = `${date}|${cabin}|${originCode}|${destinationCode}`;
      const entry = {
        date,
        cabin,
        seats,
        points: Number(cabinData.points || 0),
        tax: Number(cabinData.tax || 0),
        currency: cabinData.currency || "AU$",
        departsAt: flight.departsAt || "",
        arrivesAt: flight.arrivesAt || "",
        originCode,
        originName: flight?.origin?.name || "",
        destinationCode,
        destinationName: flight?.destination?.name || "",
        duration: flight.duration || flight.totalDuration || "",
        legs: buildFlightLegs(flight),
      };

      const append = (keyToUse) => {
        const list = index.get(keyToUse) || [];
        list.push(entry);
        index.set(keyToUse, list);
      };

      append(key);
      if (originCode || destinationCode) {
        append(routeKey);
      }
    }
  }

  for (const [key, list] of index.entries()) {
    list.sort((a, b) => {
      if (a.points !== b.points) {
        return a.points - b.points;
      }
      if (a.tax !== b.tax) {
        return a.tax - b.tax;
      }
      if (a.departsAt !== b.departsAt) {
        return a.departsAt.localeCompare(b.departsAt);
      }
      return a.destinationCode.localeCompare(b.destinationCode);
    });
    index.set(key, list);
  }

  return index;
}

function getExactRouteDetail(matchDate, hit, group, detailIndex) {
  const originCodes = Array.isArray(group.originAirports) && group.originAirports.length === 1
    ? group.originAirports
    : [];
  const destinationCodes = Array.isArray(group.destinationAirports) && group.destinationAirports.length === 1
    ? group.destinationAirports
    : [];

  if (originCodes.length === 1 && destinationCodes.length === 1) {
    const routeKey = `${matchDate}|${hit.cabin}|${originCodes[0]}|${destinationCodes[0]}`;
    const routeOptions = detailIndex.get(routeKey) || [];
    if (routeOptions.length > 0) {
      return routeOptions[0];
    }
  }
  return null;
}

function pickDetailForHit(matchDate, hit, group, detailIndex) {
  const key = `${matchDate}|${hit.cabin}`;
  const options = detailIndex.get(key) || [];
  const routeDetail = getExactRouteDetail(matchDate, hit, group, detailIndex);
  if (routeDetail) {
    return routeDetail;
  }
  const minSeats = Number(hit.minSeats || 1);
  const filtered = options.filter((option) => option.seats >= minSeats);
  if (filtered.length > 0) {
    return filtered[0];
  }
  return options[0] || null;
}

function routeLabelFromDetail(detail) {
  if (!detail || typeof detail !== "object") {
    return null;
  }

  const originCode = String(detail.originCode || detail.origin?.code || "").trim();
  const destinationCode = String(detail.destinationCode || detail.destination?.code || "").trim();
  if (originCode && destinationCode) {
    return `${originCode} -> ${destinationCode}`;
  }

  const originName = String(detail.originName || detail.origin?.name || "").trim();
  const destinationName = String(detail.destinationName || detail.destination?.name || "").trim();
  if (originName && destinationName) {
    return `${originName} -> ${destinationName}`;
  }

  return null;
}

function preferredRouteLabel(group, matches, cfg, detailIndex = null) {
  if (detailIndex && matches.length > 0) {
    for (const match of matches) {
      for (const hit of match.hits) {
        const detail = pickDetailForHit(match.date, hit, group, detailIndex);
        const routeFromDetail = routeLabelFromDetail(detail);
        if (routeFromDetail) {
          return routeFromDetail;
        }
      }
    }
  }

  return routeLabelForGroup(group);
}

function buildAlertTextForGroup(group, matches, cfg, detailIndex = null) {
  const route = preferredRouteLabel(group, matches, cfg, detailIndex);
  const lines = [
    `✈️ Qantas reward seat alert — ${route}`,
    `🧭 Filters: passengers=${cfg.passengers}, stops=${cfg.stops.join(",")}, startMonth=${cfg.startMonth}, months=${cfg.monthCount}`,
    `✅ Matches: ${matches.length}`,
    "",
  ];

  for (const match of matches) {
    for (const hit of match.hits) {
      if (detailIndex) {
        const detail = pickDetailForHit(match.date, hit, group, detailIndex);
        if (detail) {
          lines.push(...renderFlightDetailLines(match.date, detail, hit));
          continue;
        }
      }

      lines.push(`• ${match.date} | ${hit.cabin} | seats:${hit.seats}`);
    }
  }

  return lines.join("\n");
}

function buildTelegramTextForGroup(group, matches, cfg, detailIndex = null) {
  const route = preferredRouteLabel(group, matches, cfg, detailIndex);
  const lines = [
    `✈️ Qantas reward seat alert`,
    `📍 Route: ${route}`,
    `✅ Matches: ${matches.length}`,
    "",
  ];

  for (const match of matches) {
    lines.push(`📅 ${formatLongDate(match.date)}`);

    for (const hit of match.hits) {
      const detail = detailIndex ? pickDetailForHit(match.date, hit, group, detailIndex) : null;
      if (detail) {
        lines.push(...renderFlightDetailLines(match.date, detail, hit));
      } else {
        lines.push(`• ${hit.cabin} | seats ${hit.seats}`);
      }
    }

    lines.push("");
  }

  const message = lines.join("\n").trim();
  return message.slice(0, 3900);
}

function signaturesForMatches(matches) {
  const signatures = [];
  for (const match of matches) {
    const route = routeLabelForGroup(match.group || {});
    for (const hit of match.hits) {
      signatures.push(`${route}|${match.date}|${hit.cabin}|${hit.seats}`);
    }
  }
  return signatures;
}

async function sendDiscord(webhookUrl, text) {
  if (!webhookUrl) {
    return;
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: text.slice(0, 1900) }),
  });

  if (!response.ok) {
    throw new Error(`Discord webhook failed with HTTP ${response.status}`);
  }
}

async function sendNtfy(topicUrl, text) {
  if (!topicUrl) {
    return;
  }

  const response = await fetch(topicUrl, {
    method: "POST",
    headers: {
      Title: "Qantas Reward Seat Alert",
      Priority: "high",
      Tags: "airplane",
      "Content-Type": "text/plain; charset=utf-8",
    },
    body: text,
  });

  if (!response.ok) {
    throw new Error(`ntfy publish failed with HTTP ${response.status}`);
  }
}

async function sendTelegram(text) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN || "";
  const chatId = process.env.TELEGRAM_CHAT_ID || "";

  if (!botToken || !chatId) {
    throw new Error("Telegram enabled but TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing");
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body = new URLSearchParams({
    chat_id: chatId,
    text,
    disable_web_page_preview: "true",
  });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Telegram send failed with HTTP ${response.status}: ${errText.slice(0, 240)}`);
  }

  const payload = await response.json();
  if (!payload?.ok) {
    throw new Error(`Telegram send failed: ${payload?.description || "Unknown error"}`);
  }
}

function parseEmailRecipients(raw) {
  return String(raw || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function sendEmail(text, cfg) {
  const recipients = parseEmailRecipients(cfg.alertSinks.emailTo);
  if (recipients.length === 0) {
    throw new Error("Email alerts enabled but alertSinks.emailTo is empty");
  }

  const smtpUrl = process.env.SMTP_URL || "";
  const smtpHost = process.env.SMTP_HOST || "";
  const smtpPort = Number(process.env.SMTP_PORT || 587);
  const smtpUser = process.env.SMTP_USER || "";
  const smtpPass = process.env.SMTP_PASS || "";
  const smtpSecure = parseBooleanEnv(process.env.SMTP_SECURE);
  const fromAddress = process.env.SMTP_FROM || smtpUser;

  let transport;
  if (smtpUrl) {
    transport = nodemailer.createTransport(smtpUrl);
  } else {
    if (!smtpHost || !smtpUser || !smtpPass) {
      throw new Error(
        "Email alerts enabled but SMTP is not configured. Set SMTP_URL or SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS"
      );
    }

    transport = nodemailer.createTransport({
      host: smtpHost,
      port: Number.isFinite(smtpPort) ? smtpPort : 587,
      secure: smtpSecure,
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
    });
  }

  await transport.sendMail({
    from: fromAddress || "reward-seat-pinger@localhost",
    to: recipients.join(", "),
    subject: "Qantas Reward Seat Alert",
    text,
  });
}

function escapeAppleScript(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

async function sendMacNotification(text) {
  const shortText = text.split("\n").slice(0, 3).join(" ").slice(0, 220);
  await execFileAsync("osascript", [
    "-e",
    `display notification \"${escapeAppleScript(shortText)}\" with title \"Qantas Reward Alert\"`,
  ]);
}

async function runOnce(cfg, statePath) {
  const groups = Array.isArray(cfg.watchGroups) ? cfg.watchGroups : [];
  if (groups.length === 0) {
    throw new Error("Config requires at least one watch group.");
  }

  const results = [];
  for (const group of groups) {
    if (
      group.originAirports.length === 0 &&
      group.originRegions.length === 0
    ) {
      throw new Error("Each watch group requires at least one origin airport or region.");
    }
    if (
      group.destinationAirports.length === 0 &&
      group.destinationRegions.length === 0
    ) {
      throw new Error("Each watch group requires at least one destination airport or region.");
    }

    const url = makeAvailabilityUrl(cfg, group);
    const [data, flights] = await Promise.all([
      fetchJson(url, cfg.requestTimeoutMs),
      fetchFlightDetails(cfg, group),
    ]);

    if (!data || typeof data !== "object" || !data.availability) {
      throw new Error("Unexpected API response: missing availability object");
    }

    const matches = buildMatches(data.availability, cfg, group);
    const detailIndex = buildFlightDetailIndex(flights);

    results.push({ group, matches, detailIndex, dateCount: Object.keys(data.availability).length });
  }

  const allMatches = results.flatMap((result) => result.matches);
  const allSignatures = signaturesForMatches(allMatches);

  const state = await readJson(statePath, { signatures: [] });
  const oldSet = new Set(Array.isArray(state.signatures) ? state.signatures : []);
  const newSignatures = allSignatures.filter((sig) => {
    if (oldSet.has(sig)) {
      return false;
    }
    const parts = sig.split("|");
    const legacySig = parts.slice(-3).join("|");
    return !oldSet.has(legacySig);
  });
  const shouldAlert = cfg.alertOnChangesOnly ? newSignatures.length > 0 : allMatches.length > 0;

  const totalDates = results.reduce((sum, result) => sum + result.dateCount, 0);
  const matchSummary = results
    .map((result, index) => `${routeLabelForGroup(result.group)}=${result.matches.length}`)
    .join(", ");
  console.log(`[${new Date().toISOString()}] Retrieved ${totalDates} dates. Matches=${allMatches.length} New=${newSignatures.length}. Groups: ${matchSummary}`);

  if (cfg.alertSinks.console && allMatches.length > 0) {
    if (cfg.alertOnChangesOnly) {
      const freshGroups = results.map((result) => {
        const freshMatches = result.matches
          .map((match) => {
            const freshHits = match.hits.filter((hit) => {
              const sig = `${routeLabelForGroup(result.group)}|${match.date}|${hit.cabin}|${hit.seats}`;
              const legacySig = `${match.date}|${hit.cabin}|${hit.seats}`;
              return newSignatures.includes(sig) && !oldSet.has(legacySig);
            });
            return freshHits.length > 0
              ? { ...match, hits: freshHits }
              : null;
          })
          .filter(Boolean);

        return { group: result.group, matches: freshMatches, detailIndex: result.detailIndex };
      }).filter((entry) => entry.matches.length > 0);

      for (const entry of freshGroups) {
        const text = buildAlertTextForGroup(entry.group, entry.matches, cfg, entry.detailIndex);
        console.log(text);
      }
    } else {
      for (const result of results) {
        if (result.matches.length > 0) {
          const text = buildAlertTextForGroup(result.group, result.matches, cfg, result.detailIndex);
          console.log(text);
        }
      }
    }
  }

  if (shouldAlert) {
    const alertGroups = results.map((result) => {
      const filteredMatches = result.matches.filter((match) =>
        match.hits.some((hit) => {
          const sig = `${routeLabelForGroup(result.group)}|${match.date}|${hit.cabin}|${hit.seats}`;
          const legacySig = `${match.date}|${hit.cabin}|${hit.seats}`;
          return !cfg.alertOnChangesOnly || newSignatures.includes(sig) && !oldSet.has(legacySig);
        })
      );
      return { group: result.group, matches: filteredMatches, detailIndex: result.detailIndex };
    }).filter((entry) => entry.matches.length > 0);

    const text = alertGroups
      .map((entry) => buildAlertTextForGroup(entry.group, entry.matches, cfg, entry.detailIndex))
      .join("\n\n");

    const telegramText = alertGroups
      .map((entry) => buildTelegramTextForGroup(entry.group, entry.matches, cfg, entry.detailIndex))
      .join("\n\n");

    await Promise.all([
      sendDiscord(cfg.alertSinks.discordWebhookUrl, text),
      sendNtfy(cfg.alertSinks.ntfyTopicUrl, text),
      cfg.alertSinks.macOsNotification ? sendMacNotification(text) : Promise.resolve(),
      cfg.alertSinks.telegram ? sendTelegram(telegramText) : Promise.resolve(),
      cfg.alertSinks.email ? sendEmail(text, cfg) : Promise.resolve(),
    ]);
  } else if (cfg.testPing) {
    const pingText = `Qantas reward-seat-pinger heartbeat: checked at ${new Date().toISOString()} (poll interval ${cfg.pollMinutes}m)`;
    await Promise.all([
      sendDiscord(cfg.alertSinks.discordWebhookUrl, pingText),
      sendNtfy(cfg.alertSinks.ntfyTopicUrl, pingText),
      cfg.alertSinks.macOsNotification ? sendMacNotification(pingText) : Promise.resolve(),
      cfg.alertSinks.telegram ? sendTelegram(pingText) : Promise.resolve(),
      cfg.alertSinks.email ? sendEmail(pingText, cfg) : Promise.resolve(),
    ]);
  }

  if (newSignatures.length > 0) {
    const merged = new Set([...oldSet, ...newSignatures]);
    const trimmed = [...merged].slice(-5000);
    await writeJson(statePath, { signatures: trimmed });
  }
}

async function loadConfig(configPath) {
  const raw = await readJson(configPath, null);
  if (!raw || typeof raw !== "object") {
    throw new Error(`Could not read config JSON from ${configPath}`);
  }
  return sanitizeConfig(raw);
}

async function main() {
  const argv = parseArgs(process.argv.slice(2));
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(scriptDir, "..");
  const configPath = argv.configPath
    ? path.resolve(process.cwd(), argv.configPath)
    : path.resolve(projectRoot, "config.json");

  const cfg = await loadConfig(configPath);
  const statePath = path.resolve(projectRoot, cfg.stateFile);

  const runCheck = async () => {
    try {
      await runOnce(cfg, statePath);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Check failed:`, error.message);
    }
  };

  if (argv.once || cfg.pollMinutes <= 0) {
    await runCheck();
    return;
  }

  if (cfg.runImmediately) {
    await runCheck();
  }

  const intervalMs = Math.max(1, cfg.pollMinutes) * 60 * 1000;
  console.log(`Polling every ${cfg.pollMinutes} minute(s). Config: ${configPath}`);
  setInterval(runCheck, intervalMs);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
