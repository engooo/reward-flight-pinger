const outputEl = document.getElementById("output");
const watcherStatusEl = document.getElementById("watcherStatus");
const dateSummaryEl = document.getElementById("dateSummary");
const watchSummaryEl = document.getElementById("watchSummary");

const modalEl = document.getElementById("datePickerModal");
const monthListEl = document.getElementById("monthList");
const monthLabelEl = document.getElementById("monthLabel");
const calendarGridEl = document.getElementById("calendarGrid");
const rangeHintEl = document.getElementById("rangeHint");

const monthFormatter = new Intl.DateTimeFormat("en-AU", { month: "long", year: "numeric", timeZone: "UTC" });
const displayDateFormatter = new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const weekdayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function formatDateLabel(isoDate) {
  if (!isIsoDate(isoDate)) return String(isoDate);
  return displayDateFormatter.format(new Date(`${isoDate}T00:00:00Z`));
}

function formatDateRange(range) {
  if (!range || !range.from || !range.to) return "";
  const fromLabel = formatDateLabel(range.from);
  const toLabel = formatDateLabel(range.to);
  return fromLabel === toLabel ? fromLabel : `${fromLabel} - ${toLabel}`;
}

function normalizeDateListToRanges(dates) {
  const sorted = Array.from(new Set((dates || []).filter(isIsoDate))).sort();
  const ranges = [];
  for (const date of sorted) {
    if (ranges.length === 0) {
      ranges.push({ from: date, to: date });
      continue;
    }
    const previous = ranges[ranges.length - 1];
    const nextDay = new Date(`${previous.to}T00:00:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const nextIso = nextDay.toISOString().slice(0, 10);
    if (date === nextIso) {
      previous.to = date;
    } else {
      ranges.push({ from: date, to: date });
    }
  }
  return ranges;
}

const pickerState = {
  mode: "watch",
  viewMonth: "",
  anchorDate: null,
  watchDates: new Set(),
  excludeDates: new Set(),
  ranges: [],
};

const routeState = {
  originAirports: [],
  destinationAirports: [],
  latestSuggestions: {
    origin: [],
    destination: [],
  },
  searchTimers: {
    origin: null,
    destination: null,
  },
  searchRequestIds: {
    origin: 0,
    destination: 0,
  },
  watchGroups: [],
};

const CABINS = ["Economy", "PremiumEconomy", "Business", "First"];
const STOP_VALUE_MAP = {
  stopsDirect: "direct",
  stops1: "1_stop",
  stops2: "2_stops",
  stops3plus: "3_plus_stops",
};

function setOutput(text) {
  outputEl.textContent = text || "";
}

function appendOutput(text) {
  outputEl.textContent = `${outputEl.textContent}\n${text}`.trim();
}

function parseList(rawValue) {
  if (!rawValue) return [];
  return rawValue
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function parseLines(rawValue) {
  if (!rawValue) return [];
  return rawValue
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function rangesFromText(rawValue) {
  const lines = parseLines(rawValue);
  return lines
    .map((line) => {
      const parts = line.split("..").map((v) => v.trim());
      if (parts.length !== 2) return null;
      if (!isIsoDate(parts[0]) || !isIsoDate(parts[1])) return null;
      return normalizeRange(parts[0], parts[1]);
    })
    .filter(Boolean);
}

function rangesToText(ranges) {
  if (!Array.isArray(ranges)) return "";
  return ranges
    .filter((r) => r && r.from && r.to)
    .map((r) => `${r.from}..${r.to}`)
    .join("\n");
}

function bool(elId) {
  const element = document.getElementById(elId);
  return element ? element.checked : false;
}

function value(elId) {
  const element = document.getElementById(elId);
  return element ? element.value : "";
}

function numberOrNull(elId) {
  const raw = value(elId).trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function setCabinSelectionDisabled(disabled) {
  ["seatCabinEconomy", "seatCabinPremiumEconomy", "seatCabinBusiness", "seatCabinFirst"].forEach((id) => {
    document.getElementById(id).disabled = disabled;
  });
}

function applyCabinAnyBehavior() {
  const anyChecked = bool("seatCabinAny");
  setCabinSelectionDisabled(anyChecked);
  if (anyChecked) {
    ["seatCabinEconomy", "seatCabinPremiumEconomy", "seatCabinBusiness", "seatCabinFirst"].forEach((id) => {
      document.getElementById(id).checked = false;
    });
  }
}

function isIsoDate(dateValue) {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateValue);
}

function normalizeRange(from, to) {
  return from <= to ? { from, to } : { from: to, to: from };
}

function datesInRange(from, to) {
  const { from: start, to: end } = normalizeRange(from, to);
  const dates = [];
  const current = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);

  while (current <= endDate) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return dates;
}

function addMonths(monthValue, diff) {
  const [yearRaw, monthRaw] = monthValue.split("-");
  const base = new Date(Date.UTC(Number(yearRaw), Number(monthRaw) - 1, 1));
  base.setUTCMonth(base.getUTCMonth() + diff);
  return `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthDiff(startMonth, endMonth) {
  const [startYear, startMonthNum] = startMonth.split("-").map(Number);
  const [endYear, endMonthNum] = endMonth.split("-").map(Number);
  return (endYear - startYear) * 12 + (endMonthNum - startMonthNum);
}

function dateInRanges(dateValue, ranges) {
  return ranges.some((range) => dateValue >= range.from && dateValue <= range.to);
}

function uniqueCodes(items) {
  const seen = new Set();
  const result = [];
  for (const item of items || []) {
    const code = String(item.iataCode || "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code) || seen.has(code)) {
      continue;
    }
    seen.add(code);
    result.push({
      iataCode: code,
      airportName: item.airportName || code,
      city: item.city || "",
      country: item.country || "",
      label: item.label || `${code} - ${item.airportName || code}`,
    });
  }
  return result;
}

function codeToChipLabel(item) {
  const cityPart = item.city ? ` (${item.city})` : "";
  return `${item.iataCode} - ${item.airportName}${cityPart}`;
}

function renderAirportChips(kind) {
  const listEl = document.getElementById(`${kind}AirportChips`);
  const items = kind === "origin" ? routeState.originAirports : routeState.destinationAirports;
  listEl.innerHTML = "";

  for (const item of items) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = codeToChipLabel(item);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.setAttribute("aria-label", `Remove ${item.iataCode}`);
    removeBtn.textContent = "x";
    removeBtn.addEventListener("click", () => {
      if (kind === "origin") {
        routeState.originAirports = routeState.originAirports.filter((a) => a.iataCode !== item.iataCode);
      } else {
        routeState.destinationAirports = routeState.destinationAirports.filter((a) => a.iataCode !== item.iataCode);
      }
      renderAirportChips(kind);
    });

    chip.appendChild(removeBtn);
    listEl.appendChild(chip);
  }
  summarizeWatchSummary();
}

function hideSuggestions(kind) {
  const container = document.getElementById(`${kind}AirportSuggestions`);
  container.innerHTML = "";
  container.classList.add("hidden");
}

function addAirportSelection(kind, item) {
  const target = kind === "origin" ? routeState.originAirports : routeState.destinationAirports;
  if (!target.some((a) => a.iataCode === item.iataCode)) {
    target.push(item);
  }
  renderAirportChips(kind);
  summarizeWatchSummary();
}

function removeAirportSelection(kind, iataCode) {
  if (kind === "origin") {
    routeState.originAirports = routeState.originAirports.filter((a) => a.iataCode !== iataCode);
  } else {
    routeState.destinationAirports = routeState.destinationAirports.filter((a) => a.iataCode !== iataCode);
  }
  renderAirportChips(kind);
  summarizeWatchSummary();
}

function isAirportSelected(kind, iataCode) {
  const list = kind === "origin" ? routeState.originAirports : routeState.destinationAirports;
  return list.some((a) => a.iataCode === iataCode);
}

function groupedByCountry(items) {
  const groups = new Map();
  for (const item of items) {
    const country = item.countryName || item.country || "Other";
    const list = groups.get(country) || [];
    list.push(item);
    groups.set(country, list);
  }

  for (const list of groups.values()) {
    list.sort((a, b) => {
      const cityA = (a.city || "").trim();
      const cityB = (b.city || "").trim();
      const aHasCity = cityA.length > 0;
      const bHasCity = cityB.length > 0;

      if (aHasCity !== bHasCity) {
        return aHasCity ? -1 : 1;
      }
      if (cityA !== cityB) {
        return cityA.localeCompare(cityB);
      }

      const nameA = (a.airportName || "").trim();
      const nameB = (b.airportName || "").trim();
      if (nameA !== nameB) {
        return nameA.localeCompare(nameB);
      }

      return (a.iataCode || "").localeCompare(b.iataCode || "");
    });
  }

  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function showSuggestions(kind, items) {
  const container = document.getElementById(`${kind}AirportSuggestions`);
  container.innerHTML = "";

  if (!items.length) {
    container.classList.add("hidden");
    return;
  }

  for (const [country, groupItems] of groupedByCountry(items)) {
    const section = document.createElement("section");
    section.className = "suggestion-group";

    const heading = document.createElement("div");
    heading.className = "suggestion-group-title";
    heading.textContent = `${country}`;
    section.appendChild(heading);

    for (const item of groupItems) {
      const row = document.createElement("label");
      row.className = "suggestion-item";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "suggestion-checkbox";
      checkbox.checked = isAirportSelected(kind, item.iataCode);

      const topRow = document.createElement("div");
      topRow.className = "suggestion-top-row";

      const main = document.createElement("span");
      main.className = "suggestion-main";
      main.textContent = item.city || item.airportName || item.iataCode;

      const code = document.createElement("span");
      code.className = "suggestion-code";
      code.textContent = item.iataCode;

      const meta = document.createElement("span");
      meta.className = "suggestion-meta";
      const airportPart = item.airportName && item.airportName !== item.city ? item.airportName : "Airport";
      const countryPart = item.countryName || item.country || "";
      meta.textContent = countryPart ? `${airportPart} - ${countryPart}` : airportPart;

      row.appendChild(checkbox);
      topRow.appendChild(main);
      topRow.appendChild(code);
      row.appendChild(topRow);
      row.appendChild(meta);

      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          addAirportSelection(kind, item);
        } else {
          removeAirportSelection(kind, item.iataCode);
        }
      });

      section.appendChild(row);
    }

    container.appendChild(section);
  }

  container.classList.remove("hidden");
}

async function fetchAirportSuggestions(kind, query) {
  const trimmed = query.trim();
  const requestId = (routeState.searchRequestIds[kind] || 0) + 1;
  routeState.searchRequestIds[kind] = requestId;

  if (trimmed.length < 1) {
    routeState.latestSuggestions[kind] = [];
    hideSuggestions(kind);
    return;
  }

  const data = await apiGet(`/api/airports?q=${encodeURIComponent(trimmed)}&limit=200`);
  if (!data.ok) {
    throw new Error(data.error || "Could not search airports");
  }

  const currentInput = document.getElementById(`${kind}AirportSearch`).value.trim();
  if (routeState.searchRequestIds[kind] !== requestId || currentInput !== trimmed) {
    return;
  }

  const items = data.items || [];
  routeState.latestSuggestions[kind] = items;
  showSuggestions(kind, items);
}

function bindAirportSearch(kind) {
  const input = document.getElementById(`${kind}AirportSearch`);

  input.addEventListener("input", () => {
    if (routeState.searchTimers[kind]) {
      clearTimeout(routeState.searchTimers[kind]);
    }
    routeState.searchTimers[kind] = setTimeout(async () => {
      try {
        await fetchAirportSuggestions(kind, input.value);
      } catch (error) {
        setOutput(error.message);
      }
    }, 160);
  });

  input.addEventListener("focus", async () => {
    try {
      if (input.value.trim().length >= 1) {
        await fetchAirportSuggestions(kind, input.value);
      }
    } catch (error) {
      setOutput(error.message);
    }
  });

  input.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter" && event.key !== "Tab" && event.key !== ",") {
      return;
    }

    const typed = input.value.trim();
    if (!typed) {
      return;
    }

    const suggestions = routeState.latestSuggestions[kind] || [];
    const exactCode = suggestions.find((item) => item.iataCode.toLowerCase() === typed.toLowerCase());
    const firstMatch = exactCode || suggestions[0] || null;

    if (!firstMatch) {
      return;
    }

    event.preventDefault();
    addAirportSelection(kind, firstMatch);
    input.value = "";
    routeState.latestSuggestions[kind] = [];
    hideSuggestions(kind);
  });
}

function monthDays(monthValue) {
  const [yearRaw, monthRaw] = monthValue.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const first = new Date(Date.UTC(year, month - 1, 1));
  const totalDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mondayFirstOffset = (first.getUTCDay() + 6) % 7;

  const cells = [];
  for (let i = 0; i < mondayFirstOffset; i += 1) {
    cells.push({ empty: true });
  }
  for (let day = 1; day <= totalDays; day += 1) {
    cells.push({
      empty: false,
      day,
      iso: `${monthValue}-${String(day).padStart(2, "0")}`,
    });
  }
  return cells;
}

function summarizeDateRules() {
  const watchCount = parseLines(value("watchDates")).length;
  dateSummaryEl.textContent = watchCount > 0 ? `${watchCount} travel date${watchCount === 1 ? "" : "s"} selected` : "No travel dates selected";
  summarizeWatchSummary();
}

function currentGroupFromFields() {
  return {
    originAirports: routeState.originAirports.map((item) => item.iataCode),
    originRegions: parseList(value("originRegions")),
    destinationAirports: routeState.destinationAirports.map((item) => item.iataCode),
    destinationRegions: parseList(value("destinationRegions")),
    watchDates: parseLines(value("watchDates")).filter(isIsoDate),
    watchDateRanges: rangesFromText(value("watchDateRanges")),
    weekdays: parseLines(value("weekdays")),
    excludeDates: parseLines(value("excludeDates")).filter(isIsoDate),
  };
}

function rangeListToText(ranges) {
  if (!Array.isArray(ranges)) return "";
  return ranges
    .map((range) => formatDateRange(range))
    .filter(Boolean)
    .join(", ");
}

function formatGroupSummary(group) {
  const origin = group.originAirports.length > 0
    ? group.originAirports.join(", ")
    : group.originRegions.join(", ") || "*";
  const destination = group.destinationAirports.length > 0
    ? group.destinationAirports.join(", ")
    : group.destinationRegions.join(", ") || "*";
  const dateParts = [];
  if (Array.isArray(group.watchDates) && group.watchDates.length > 0) {
    const ranges = normalizeDateListToRanges(group.watchDates);
    dateParts.push(`Dates: ${rangeListToText(ranges)}`);
  }
  if (Array.isArray(group.watchDateRanges) && group.watchDateRanges.length > 0) {
    dateParts.push(`Ranges: ${rangeListToText(group.watchDateRanges)}`);
  }
  const dateSummary = dateParts.length > 0 ? ` | ${dateParts.join(" | ")}` : " | All dates";
  return `${origin} → ${destination}${dateSummary}`;
}

function renderWatchGroups() {
  const listEl = document.getElementById("groupList");
  if (!listEl) return;

  listEl.innerHTML = "";
  if (routeState.watchGroups.length === 0) {
    return;
  }

  routeState.watchGroups.forEach((group, index) => {
    const card = document.createElement("div");
    card.className = "watch-group-card";

    const label = document.createElement("div");
    label.className = "watch-group-label";
    label.textContent = formatGroupSummary(group);
    card.appendChild(label);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "watch-group-remove";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => {
      removeWatchGroup(index);
    });
    card.appendChild(removeBtn);

    listEl.appendChild(card);
  });
}

function addWatchGroup() {
  const group = currentGroupFromFields();
  if (group.originAirports.length === 0 && group.originRegions.length === 0) {
    appendOutput("Cannot add watch group without an origin.");
    return;
  }
  if (group.destinationAirports.length === 0 && group.destinationRegions.length === 0) {
    appendOutput("Cannot add watch group without a destination.");
    return;
  }

  routeState.watchGroups.push(group);
  renderWatchGroups();
  summarizeWatchSummary();
  appendOutput(`Added watch group: ${formatGroupSummary(group)}`);
}

function removeWatchGroup(index) {
  routeState.watchGroups.splice(index, 1);
  renderWatchGroups();
  summarizeWatchSummary();
}

function summarizeWatchSummary() {
  const originCodes = routeState.originAirports.map((item) => item.iataCode);
  const destinationCodes = routeState.destinationAirports.map((item) => item.iataCode);
  const watchDates = parseLines(value("watchDates")).filter(isIsoDate);
  const watchDateRanges = rangesFromText(value("watchDateRanges"));
  const currentGroup = currentGroupFromFields();

  const routeSummary = originCodes.length > 0 && destinationCodes.length > 0
    ? `Current group: ${originCodes.join(", ")} → ${destinationCodes.join(", ")}`
    : "Current group: no route configured";

  let dateSummary = "No travel dates selected";
  const dateParts = [];
  if (watchDates.length > 0) {
    const ranges = normalizeDateListToRanges(watchDates);
    dateParts.push(`Dates: ${rangeListToText(ranges)}`);
  }
  if (watchDateRanges.length > 0) {
    dateParts.push(`Ranges: ${rangeListToText(watchDateRanges)}`);
  }
  if (dateParts.length > 0) {
    dateSummary = dateParts.join(" | ");
  }

  const groupCountText = routeState.watchGroups.length > 0
    ? `${routeState.watchGroups.length} saved watch group${routeState.watchGroups.length === 1 ? "" : "s"}`
    : "No saved watch groups";

  if (watchSummaryEl) {
    watchSummaryEl.innerHTML = `<div>${routeSummary}</div><div>${dateSummary}</div><div>${groupCountText}</div>`;
  }

  renderWatchGroups();
}

function readPickerDataFromFields() {
  pickerState.watchDates = new Set(parseLines(value("watchDates")).filter(isIsoDate));
  pickerState.excludeDates = new Set();
  pickerState.ranges = [];
}

function writePickerDataToFields() {
  document.getElementById("watchDates").value = [...pickerState.watchDates].sort().join("\n");
  document.getElementById("excludeDates").value = "";
  document.getElementById("watchDateRanges").value = "";
  summarizeDateRules();
}

function monthOptions() {
  const selected = parseLines(value("watchDates")).filter(isIsoDate).sort();
  const todayMonth = new Date().toISOString().slice(0, 7);
  const start = selected.length > 0 ? selected[0].slice(0, 7) : todayMonth;
  const end = selected.length > 0 ? selected[selected.length - 1].slice(0, 7) : addMonths(start, 11);
  const count = Math.max(12, Math.min(24, monthDiff(start, end) + 1));
  const months = [];
  for (let i = 0; i < count; i += 1) {
    months.push(addMonths(start, i));
  }
  return months;
}

function handleDayClick(dateValue) {
  if (!pickerState.anchorDate) {
    pickerState.anchorDate = dateValue;
    pickerState.watchDates.add(dateValue);
    renderCalendars();
    return;
  }

  const rangeDates = datesInRange(pickerState.anchorDate, dateValue);
  for (const day of rangeDates) {
    pickerState.watchDates.add(day);
  }

  pickerState.anchorDate = null;
  renderCalendars();
}

function dayClassList(dateValue) {
  const classes = ["day"];
  if (pickerState.watchDates.has(dateValue)) classes.push("selected");
  if (pickerState.anchorDate === dateValue) classes.push("range-edge");
  return classes.join(" ");
}

function renderMonthSidebar() {
  const months = monthOptions();
  if (!months.includes(pickerState.viewMonth)) {
    pickerState.viewMonth = months[0];
  }

  monthListEl.innerHTML = "";
  for (const monthValue of months) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `month-item${monthValue === pickerState.viewMonth ? " active" : ""}`;
    button.textContent = monthFormatter.format(new Date(`${monthValue}-01T00:00:00Z`));
    button.addEventListener("click", () => {
      pickerState.viewMonth = monthValue;
      renderMonthSidebar();
      renderCalendars();
    });
    monthListEl.appendChild(button);
  }
}

function renderMonthCard(monthValue) {
  const wrapper = document.createElement("section");
  wrapper.className = "month-card";

  const title = document.createElement("h4");
  title.textContent = monthFormatter.format(new Date(`${monthValue}-01T00:00:00Z`));
  wrapper.appendChild(title);

  const weekdays = document.createElement("div");
  weekdays.className = "weekday-head";
  for (const dayLabel of weekdayLabels) {
    const span = document.createElement("span");
    span.textContent = dayLabel;
    weekdays.appendChild(span);
  }
  wrapper.appendChild(weekdays);

  const grid = document.createElement("div");
  grid.className = "day-grid";
  for (const cell of monthDays(monthValue)) {
    const button = document.createElement("button");
    button.type = "button";
    if (cell.empty) {
      button.className = "day empty";
      grid.appendChild(button);
      continue;
    }
    button.className = dayClassList(cell.iso);
    button.textContent = String(cell.day);
    button.title = cell.iso;
    button.addEventListener("click", () => handleDayClick(cell.iso));
    grid.appendChild(button);
  }
  wrapper.appendChild(grid);

  return wrapper;
}

function renderCalendars() {
  const firstMonth = pickerState.viewMonth;
  const secondMonth = addMonths(firstMonth, 1);
  monthLabelEl.textContent = `${monthFormatter.format(new Date(`${firstMonth}-01T00:00:00Z`))} - ${monthFormatter.format(new Date(`${secondMonth}-01T00:00:00Z`))}`;
  calendarGridEl.innerHTML = "";
  calendarGridEl.appendChild(renderMonthCard(firstMonth));
  calendarGridEl.appendChild(renderMonthCard(secondMonth));
}

function openDatePicker() {
  readPickerDataFromFields();
  const months = monthOptions();
  pickerState.viewMonth = months[0];
  pickerState.anchorDate = null;
  modalEl.classList.remove("hidden");
  pickerState.mode = "range";
  rangeHintEl.classList.remove("hidden");
  renderMonthSidebar();
  renderCalendars();
}

function closeDatePicker() {
  modalEl.classList.add("hidden");
  pickerState.anchorDate = null;
}

function clearCurrentMode() {
  pickerState.watchDates.clear();
  renderCalendars();
}

function stopTokensFromConfig(stops) {
  const values = new Set((stops || []).map((s) => String(s).toLowerCase()));
  return {
    direct: values.has("direct"),
    one: values.has("1_stop") || values.has("one_stop") || values.has("1 stop"),
    two: values.has("2_stops") || values.has("two_stops") || values.has("2 stops"),
    threePlus: values.has("3_plus_stops") || values.has("three_plus_stops") || values.has("3+ stops"),
  };
}

function selectedStopsFromForm() {
  const selected = [];
  if (bool("stopsDirect")) selected.push(STOP_VALUE_MAP.stopsDirect);
  if (bool("stops1")) selected.push(STOP_VALUE_MAP.stops1);
  if (bool("stops2")) selected.push(STOP_VALUE_MAP.stops2);
  if (bool("stops3plus")) selected.push(STOP_VALUE_MAP.stops3plus);
  return selected.length > 0 ? selected : [STOP_VALUE_MAP.stopsDirect];
}

function deriveMonthWindowFromDates(dates) {
  const validDates = (dates || []).filter(isIsoDate).sort();
  const fallbackStart = new Date().toISOString().slice(0, 7);
  if (validDates.length === 0) {
    return { startMonth: fallbackStart, monthCount: 4 };
  }

  const firstMonth = validDates[0].slice(0, 7);
  const lastMonth = validDates[validDates.length - 1].slice(0, 7);
  const count = Math.max(1, monthDiff(firstMonth, lastMonth) + 1);
  return { startMonth: firstMonth, monthCount: count };
}

function loadGroupIntoFields(group) {
  const originCodes = (group.originAirports || []).map((code) => ({ iataCode: String(code).toUpperCase(), airportName: String(code).toUpperCase(), city: "", country: "" }));
  const destinationCodes = (group.destinationAirports || []).map((code) => ({ iataCode: String(code).toUpperCase(), airportName: String(code).toUpperCase(), city: "", country: "" }));
  routeState.originAirports = uniqueCodes(originCodes);
  routeState.destinationAirports = uniqueCodes(destinationCodes);
  renderAirportChips("origin");
  renderAirportChips("destination");

  document.getElementById("originRegions").value = (group.originRegions || []).join(", ");
  document.getElementById("destinationRegions").value = (group.destinationRegions || []).join(", ");
  document.getElementById("watchDates").value = (group.watchDates || []).join("\n");
  document.getElementById("watchDateRanges").value = rangesToText(group.watchDateRanges || []);
  document.getElementById("excludeDates").value = (group.excludeDates || []).join("\n");
}

function fillForm(config) {
  const groups = Array.isArray(config.watchGroups) && config.watchGroups.length > 0
    ? config.watchGroups
    : [{
        originAirports: config.originAirports || [],
        originRegions: config.originRegions || [],
        destinationAirports: config.destinationAirports || [],
        destinationRegions: config.destinationRegions || [],
        watchDates: config.watchDates || [],
        watchDateRanges: config.watchDateRanges || [],
        weekdays: config.weekdays || [],
        excludeDates: config.excludeDates || [],
      }];

  const [primaryGroup, ...savedGroups] = groups;
  routeState.watchGroups = savedGroups;
  loadGroupIntoFields(primaryGroup);

  document.getElementById("passengers").value = config.passengers ?? 1;
  const stopTokens = stopTokensFromConfig(config.stops || []);
  document.getElementById("stopsDirect").checked = stopTokens.direct;
  document.getElementById("stops1").checked = stopTokens.one;
  document.getElementById("stops2").checked = stopTokens.two;
  document.getElementById("stops3plus").checked = stopTokens.threePlus;
  document.getElementById("startMonth").value = config.startMonth || new Date().toISOString().slice(0, 7);
  document.getElementById("monthCount").value = config.monthCount ?? 4;

  const seat = config.seatFilters || {};
  const selectedCabins = CABINS.filter((cabin) => Number.isFinite(Number(seat[cabin])) && Number(seat[cabin]) >= 1);
  const distinctCounts = [...new Set(selectedCabins.map((cabin) => Number(seat[cabin])))];
  const seatCount = distinctCounts.length > 0 ? distinctCounts[0] : "";

  document.getElementById("seatMinCount").value = seatCount;
  document.getElementById("seatCabinAny").checked = selectedCabins.length === 0 || selectedCabins.length === CABINS.length;
  document.getElementById("seatCabinEconomy").checked = selectedCabins.includes("Economy");
  document.getElementById("seatCabinPremiumEconomy").checked = selectedCabins.includes("PremiumEconomy");
  document.getElementById("seatCabinBusiness").checked = selectedCabins.includes("Business");
  document.getElementById("seatCabinFirst").checked = selectedCabins.includes("First");
  applyCabinAnyBehavior();

  document.getElementById("pollMinutes").value = config.pollMinutes ?? 15;
  document.getElementById("runImmediately").checked = config.runImmediately !== false;
  document.getElementById("alertOnChangesOnly").checked = config.alertOnChangesOnly !== false;
  document.getElementById("stateFile").value = config.stateFile || ".state/seen.json";
  document.getElementById("requestTimeoutMs").value = config.requestTimeoutMs ?? 15000;

  const sinks = config.alertSinks || {};
  document.getElementById("alertConsole").checked = sinks.console !== false;
  document.getElementById("alertMacOs").checked = sinks.macOsNotification === true;
  document.getElementById("alertTelegram").checked = sinks.telegram === true;
  document.getElementById("alertEmail").checked = sinks.email === true;
  document.getElementById("discordWebhookUrl").value = sinks.discordWebhookUrl || "";
  document.getElementById("ntfyTopicUrl").value = sinks.ntfyTopicUrl || "";
  document.getElementById("emailTo").value = sinks.emailTo || "";

  summarizeDateRules();
  renderWatchGroups();
  summarizeWatchSummary();
}

function collectConfig() {
  const seatFilters = {};
  const seatMinCount = numberOrNull("seatMinCount");
  const anyCabin = bool("seatCabinAny");
  const watchDates = parseLines(value("watchDates")).filter(isIsoDate).sort();
  const watchDateRanges = rangesFromText(value("watchDateRanges"));
  const weekdays = parseLines(value("weekdays"));
  const excludeDates = parseLines(value("excludeDates")).filter(isIsoDate);
  const monthWindow = deriveMonthWindowFromDates(watchDates);

  if (seatMinCount !== null) {
    const selectedCabins = [];

    if (anyCabin) {
      selectedCabins.push(...CABINS);
    } else {
      if (bool("seatCabinEconomy")) selectedCabins.push("Economy");
      if (bool("seatCabinPremiumEconomy")) selectedCabins.push("PremiumEconomy");
      if (bool("seatCabinBusiness")) selectedCabins.push("Business");
      if (bool("seatCabinFirst")) selectedCabins.push("First");
    }

    for (const cabin of selectedCabins) {
      seatFilters[cabin] = seatMinCount;
    }
  }

  const currentGroup = currentGroupFromFields();
  const watchGroups = [];

  if (
    (currentGroup.originAirports.length > 0 || currentGroup.originRegions.length > 0) &&
    (currentGroup.destinationAirports.length > 0 || currentGroup.destinationRegions.length > 0)
  ) {
    watchGroups.push(currentGroup);
  }

  watchGroups.push(...routeState.watchGroups);

  return {
    apiBaseUrl: "https://flightrewardfinder.qantas.com/api/availability",
    originAirports: currentGroup.originAirports,
    originRegions: currentGroup.originRegions,
    destinationAirports: currentGroup.destinationAirports,
    destinationRegions: currentGroup.destinationRegions,
    passengers: Number(value("passengers") || 1),
    stops: selectedStopsFromForm(),
    startMonth: monthWindow.startMonth,
    monthCount: monthWindow.monthCount,
    seatFilters,
    watchDates,
    watchDateRanges,
    weekdays,
    excludeDates,
    watchGroups,
    pollMinutes: Number(value("pollMinutes") || 15),
    runImmediately: bool("runImmediately"),
    alertOnChangesOnly: bool("alertOnChangesOnly"),
    stateFile: value("stateFile") || ".state/seen.json",
    requestTimeoutMs: Number(value("requestTimeoutMs") || 15000),
    alertSinks: {
      console: bool("alertConsole"),
      discordWebhookUrl: value("discordWebhookUrl").trim(),
      ntfyTopicUrl: value("ntfyTopicUrl").trim(),
      macOsNotification: bool("alertMacOs"),
      telegram: bool("alertTelegram"),
      email: bool("alertEmail"),
      emailTo: value("emailTo").trim(),
    },
  };
}

async function apiGet(url) {
  const response = await fetch(url);
  return response.json();
}

async function apiPost(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload ? JSON.stringify(payload) : "{}",
  });
  return response.json();
}

async function loadConfig() {
  const data = await apiGet("/api/config");
  if (!data.ok) {
    throw new Error(data.error || "Could not load config");
  }
  fillForm(data.config);
  appendOutput("Loaded config");
}

async function saveConfig() {
  const config = collectConfig();
  const data = await apiPost("/api/config", config);
  if (!data.ok) {
    throw new Error(data.error || "Could not save config");
  }
  appendOutput("Saved config.json");
}

async function runCheck() {
  setOutput("Running one-off check...");
  const result = await apiPost("/api/check");
  setOutput(result.output || "No output");
}

async function refreshWatcherStatus() {
  const status = await apiGet("/api/watcher/status");
  watcherStatusEl.textContent = status.running
    ? `Watcher status: running since ${status.startedAt}`
    : "Watcher status: stopped";
  if (status.lastOutput) {
    setOutput(status.lastOutput);
  }
}

async function startWatcher() {
  const data = await apiPost("/api/watcher/start");
  if (data.reason === "already-running") {
    appendOutput("Watcher already running");
  } else {
    appendOutput("Watcher started");
  }
  await refreshWatcherStatus();
}

async function stopWatcher() {
  const data = await apiPost("/api/watcher/stop");
  if (data.reason === "not-running") {
    appendOutput("Watcher was not running");
  } else {
    appendOutput("Watcher stop signal sent");
  }
  await refreshWatcherStatus();
}

document.getElementById("refreshConfig").addEventListener("click", async () => {
  try {
    await loadConfig();
  } catch (error) {
    setOutput(error.message);
  }
});

document.getElementById("saveConfig").addEventListener("click", async () => {
  try {
    await saveConfig();
  } catch (error) {
    setOutput(error.message);
  }
});

document.getElementById("runCheck").addEventListener("click", async () => {
  try {
    await saveConfig();
    await runCheck();
  } catch (error) {
    setOutput(error.message);
  }
});

document.getElementById("startWatcher").addEventListener("click", async () => {
  try {
    await saveConfig();
    await startWatcher();
  } catch (error) {
    setOutput(error.message);
  }
});

document.getElementById("stopWatcher").addEventListener("click", async () => {
  try {
    await stopWatcher();
  } catch (error) {
    setOutput(error.message);
  }
});

document.getElementById("refreshWatcher").addEventListener("click", async () => {
  try {
    await refreshWatcherStatus();
  } catch (error) {
    setOutput(error.message);
  }
});

document.getElementById("openDatePicker").addEventListener("click", () => {
  openDatePicker();
});

document.getElementById("pickerApply").addEventListener("click", () => {
  writePickerDataToFields();
  closeDatePicker();
});

document.getElementById("pickerClose").addEventListener("click", () => {
  closeDatePicker();
});

document.getElementById("pickerClear").addEventListener("click", () => {
  clearCurrentMode();
});

document.getElementById("monthPrev").addEventListener("click", () => {
  pickerState.viewMonth = addMonths(pickerState.viewMonth, -1);
  renderMonthSidebar();
  renderCalendars();
});

document.getElementById("monthNext").addEventListener("click", () => {
  pickerState.viewMonth = addMonths(pickerState.viewMonth, 1);
  renderMonthSidebar();
  renderCalendars();
});

document.getElementById("watchDates").addEventListener("input", summarizeDateRules);
document.getElementById("watchDateRanges").addEventListener("input", summarizeDateRules);
document.getElementById("excludeDates").addEventListener("input", summarizeDateRules);
document.getElementById("seatCabinAny").addEventListener("change", applyCabinAnyBehavior);
document.getElementById("addWatchGroup").addEventListener("click", addWatchGroup);

bindAirportSearch("origin");
bindAirportSearch("destination");

modalEl.addEventListener("click", (event) => {
  if (event.target === modalEl) {
    closeDatePicker();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !modalEl.classList.contains("hidden")) {
    closeDatePicker();
  }
});

document.addEventListener("click", (event) => {
  const originWrap = document.querySelector('.airport-picker[data-kind="origin"]');
  const destinationWrap = document.querySelector('.airport-picker[data-kind="destination"]');
  if (originWrap && !originWrap.contains(event.target)) {
    hideSuggestions("origin");
  }
  if (destinationWrap && !destinationWrap.contains(event.target)) {
    hideSuggestions("destination");
  }
});

(async () => {
  try {
    await loadConfig();

    const [originFirst] = routeState.originAirports;
    const [destinationFirst] = routeState.destinationAirports;

    if (originFirst) {
      try {
        const result = await apiGet(`/api/airports?q=${encodeURIComponent(originFirst.iataCode)}&limit=5`);
        if (result.ok && Array.isArray(result.items)) {
          const enriched = uniqueCodes(result.items.filter((i) => i.iataCode === originFirst.iataCode));
          if (enriched[0]) {
            routeState.originAirports = uniqueCodes([
              ...enriched,
              ...routeState.originAirports,
            ]);
            renderAirportChips("origin");
          }
        }
      } catch {
        // Keep fallback chip labels when lookup fails.
      }
    }

    if (destinationFirst) {
      try {
        const result = await apiGet(`/api/airports?q=${encodeURIComponent(destinationFirst.iataCode)}&limit=10`);
        if (result.ok && Array.isArray(result.items)) {
          const enriched = uniqueCodes(
            result.items.filter((item) =>
              routeState.destinationAirports.some((selected) => selected.iataCode === item.iataCode)
            )
          );
          if (enriched.length > 0) {
            routeState.destinationAirports = uniqueCodes([
              ...enriched,
              ...routeState.destinationAirports,
            ]);
            renderAirportChips("destination");
          }
        }
      } catch {
        // Keep fallback chip labels when lookup fails.
      }
    }

    await refreshWatcherStatus();
  } catch (error) {
    setOutput(error.message);
  }
})();
