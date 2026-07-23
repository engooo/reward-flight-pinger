import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";

const dashboardMarkup = `
<main class="container">
  <header class="topbar">
    <h1>Reward Seat Pinger</h1>
    <div class="topbar-actions">
      <button id="refreshConfig" type="button">Refresh</button>
      <button id="saveConfig" type="button" class="primary">Save Config</button>
    </div>
  </header>

  <section class="card finder-card">
    <h2>Flight Finder</h2>

    <div class="finder-grid route-grid">
      <article class="finder-tile airport-picker" data-kind="origin">
        <h3>Departure location</h3>
        <div class="chip-input-wrap">
          <div id="originAirportChips" class="chip-list"></div>
          <input id="originAirportSearch" type="text" placeholder="Search city or airport code" autocomplete="off" />
        </div>
        <div id="originAirportSuggestions" class="suggestions hidden"></div>
      </article>

      <article class="finder-tile airport-picker" data-kind="destination">
        <h3>Arrival location</h3>
        <div class="chip-input-wrap">
          <div id="destinationAirportChips" class="chip-list"></div>
          <input id="destinationAirportSearch" type="text" placeholder="Search city or airport code" autocomplete="off" />
        </div>
        <div id="destinationAirportSuggestions" class="suggestions hidden"></div>
      </article>

      <article class="finder-tile">
        <h3>Travel date</h3>
        <div class="picker-toolbar compact">
          <button id="openDatePicker" type="button">Choose travel dates</button>
          <div id="dateSummary" class="date-summary">No travel dates selected</div>
        </div>
      </article>
    </div>

    <div class="finder-grid filters-grid">
      <article class="finder-tile compact-tile">
        <h3>Stops</h3>
        <div class="weekday-grid stops-grid">
          <label><input id="stopsDirect" type="checkbox" /> Direct</label>
          <label><input id="stops1" type="checkbox" /> 1 stop</label>
          <label><input id="stops2" type="checkbox" /> 2 stops</label>
          <label><input id="stops3plus" type="checkbox" /> 3+ stops</label>
        </div>
      </article>

      <article class="finder-tile compact-tile">
        <h3>Cabin preference</h3>
        <label>Seats wanted
          <input id="seatMinCount" type="number" min="1" step="1" placeholder="e.g. 2" />
        </label>
        <div class="cabin-grid">
          <label><input id="seatCabinAny" type="checkbox" /> Any</label>
          <label><input id="seatCabinEconomy" type="checkbox" /> Economy</label>
          <label><input id="seatCabinPremiumEconomy" type="checkbox" /> Premium</label>
          <label><input id="seatCabinBusiness" type="checkbox" /> Business</label>
          <label><input id="seatCabinFirst" type="checkbox" /> First</label>
        </div>
      </article>

      <article class="finder-tile compact-tile">
        <h3>Passengers</h3>
        <label>
          <input id="passengers" type="number" min="1" step="1" />
        </label>
      </article>
    </div>

    <button id="runCheck" type="button" class="primary finder-cta">Explore flights</button>
  </section>

  <section class="grid two">
    <article class="card">
      <h2>Alerts And Watcher</h2>
      <div class="row toggles">
        <label><input id="alertConsole" type="checkbox" /> Console Output</label>
        <label><input id="alertMacOs" type="checkbox" /> macOS Notification</label>
        <label><input id="alertTelegram" type="checkbox" /> Telegram</label>
        <label><input id="alertEmail" type="checkbox" /> Email</label>
      </div>
      <label>Discord Webhook URL
        <input id="discordWebhookUrl" type="url" placeholder="https://discord.com/api/webhooks/..." />
      </label>
      <label>ntfy Topic URL
        <input id="ntfyTopicUrl" type="url" placeholder="https://ntfy.sh/your-topic" />
      </label>
      <label>Email To (comma separated)
        <input id="emailTo" type="text" placeholder="you@example.com, teammate@example.com" />
      </label>

      <h3>Watcher Control</h3>
      <div class="row actions">
        <button id="startWatcher" type="button">Start Watcher</button>
        <button id="stopWatcher" type="button">Stop Watcher</button>
        <button id="refreshWatcher" type="button">Refresh Status</button>
      </div>
      <p id="watcherStatus" class="status">Watcher status: unknown</p>

      <h3>Advanced Runtime</h3>
      <label>Poll Interval (minutes)
        <input id="pollMinutes" type="number" min="1" step="1" />
      </label>
      <label>Request Timeout (ms)
        <input id="requestTimeoutMs" type="number" min="1000" step="500" />
      </label>
      <label>State File
        <input id="stateFile" type="text" />
      </label>
      <div class="row toggles">
        <label><input id="runImmediately" type="checkbox" /> Run immediately on start</label>
        <label><input id="alertOnChangesOnly" type="checkbox" /> Alert only on new matches</label>
      </div>
      <details class="advanced-rules">
        <summary>Advanced route options</summary>
        <label>Origin Regions (comma separated)
          <input id="originRegions" type="text" />
        </label>
        <label>Destination Regions (comma separated)
          <input id="destinationRegions" type="text" />
        </label>
      </details>
    </article>

    <article class="card hidden-date-fields" aria-hidden="true">
      <label>Watch Dates
        <textarea id="watchDates" rows="1"></textarea>
      </label>
      <textarea id="watchDateRanges" rows="1"></textarea>
      <textarea id="excludeDates" rows="1"></textarea>
      <input id="startMonth" type="month" />
      <input id="monthCount" type="number" min="1" step="1" />
    </article>
  </section>

  <section class="card">
    <h2>Output</h2>
    <pre id="output"></pre>
  </section>
</main>

<div id="datePickerModal" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="datePickerTitle">
  <div class="modal-shell">
    <aside class="month-sidebar">
      <h3 id="datePickerTitle">Choose Dates</h3>
      <div id="monthList" class="month-list"></div>
    </aside>
    <section class="calendar-panel">
      <div class="calendar-toolbar">
        <button id="monthPrev" type="button" aria-label="Previous month">&#8249;</button>
        <div id="monthLabel" class="month-label"></div>
        <button id="monthNext" type="button" aria-label="Next month">&#8250;</button>
      </div>
      <div id="rangeHint" class="range-hint">Select a start date, then an end date to include every date in between.</div>
      <div id="calendarGrid" class="calendar-grid"></div>
      <div class="modal-actions">
        <button id="pickerClear" type="button">Clear Dates</button>
        <button id="pickerClose" type="button">Cancel</button>
        <button id="pickerApply" type="button" class="primary">Apply</button>
      </div>
    </section>
  </div>
</div>
`;

function App() {
  useEffect(() => {
    import("./app.js").catch((error) => {
      console.error("Failed to initialize dashboard logic", error);
    });
  }, []);

  return <div dangerouslySetInnerHTML={{ __html: dashboardMarkup }} />;
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Missing root element");
}

createRoot(rootElement).render(<App />);
