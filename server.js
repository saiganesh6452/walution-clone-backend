// Code.gs - WALUTION clone with batching + spacing between messages
// Hard-coded backend + key
const BACKEND_BASE = 'https://walution-clone-backend.onrender.com';
const BACKEND_API_KEY = 'DEV_KEY_123456';
const HISTORY_PROP = 'WALUTION_HISTORY';
const STATUS_COLUMN_NAME = 'Walution Status';

// Batching / throttling configuration (tweak if desired)
const BATCH_SIZE = 5;              // number of messages per batch
const BATCH_INTERVAL_SEC = 60;     // seconds between batch starts (e.g. 60 => 1 batch/minute)

// Property keys used to persist the queue & flags
const PROP_QUEUE_KEY = 'WALUTION_BATCH_QUEUE_V1';
const PROP_PROCESSING_FLAG = 'WALUTION_BATCH_PROCESSING_V1';

// -------------------- UI helpers --------------------
function onOpen(e) {
  SpreadsheetApp.getUi()
    .createMenu('Walution - Send Personalized WhatsApp Messages')
    .addItem('Start', 'showStartModal')
    .addItem('Setup your phone', 'showRegisterDialog')
    .addSeparator()
    .addItem('Default Country Code', 'showCountryDialog')
    .addItem('History', 'showHistoryDialog')
    .addItem('Purge Queue', 'showPurgeDialog')
    .addToUi();
}

function showStartModal() {
  const t = HtmlService.createTemplateFromFile('start');
  t.defaultCountry = getUserDefaultCountry() || '+91';
  t.sheetName = SpreadsheetApp.getActiveSheet().getName();
  t.BACKEND = BACKEND_BASE;
  const html = t.evaluate().setWidth(720).setHeight(560).setTitle('Walution - Start');
  SpreadsheetApp.getUi().showModalDialog(html, 'Sheet: ' + t.sheetName);
}

function showRegisterDialog() {
  const html = HtmlService.createHtmlOutputFromFile('register').setWidth(520).setHeight(320);
  SpreadsheetApp.getUi().showModalDialog(html, 'Register Backend');
}

function showCountryDialog() {
  const html = HtmlService.createHtmlOutputFromFile('country').setWidth(600).setHeight(420);
  SpreadsheetApp.getUi().showModalDialog(html, 'Default Country Code');
}

function showHistoryDialog() {
  const html = HtmlService.createHtmlOutputFromFile('history').setWidth(860).setHeight(520);
  SpreadsheetApp.getUi().showModalDialog(html, 'Search History');
}

function showPurgeDialog() {
  const html = HtmlService.createHtmlOutputFromFile('purge').setWidth(540).setHeight(320);
  SpreadsheetApp.getUi().showModalDialog(html, 'Purge Messages in Queue');
}

function showTestDialog(messageText) {
  const t = HtmlService.createTemplateFromFile('test');
  t.message = messageText || '';
  t.defaultCountry = getUserDefaultCountry() || '+91';
  const html = t.evaluate().setWidth(540).setHeight(220).setTitle('Send Test');
  SpreadsheetApp.getUi().showModalDialog(html, 'Send a WhatsApp test message');
}

// -------------------- Utilities --------------------
function makeUUID() {
  return 'id-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1000000).toString(36);
}

function normalizePhoneWithDefault(phone, defaultCode) {
  defaultCode = defaultCode || getUserDefaultCountry() || '+91';
  const p = String(phone || '').trim();
  if (!p) return p;
  if (p.startsWith('+')) return p.replace(/\s+/g, '');
  const digits = p.replace(/\D/g, '');
  return defaultCode + digits;
}

function persistQueue(queueArr) {
  try {
    const props = PropertiesService.getScriptProperties();
    props.setProperty(PROP_QUEUE_KEY, JSON.stringify(queueArr || []));
    return true;
  } catch (e) {
    console.error('persistQueue error', e);
    return false;
  }
}

function readQueue() {
  try {
    const props = PropertiesService.getScriptProperties();
    const raw = props.getProperty(PROP_QUEUE_KEY) || '[]';
    return JSON.parse(raw || '[]');
  } catch (e) {
    console.error('readQueue error', e);
    return [];
  }
}

function clearQueue() {
  try {
    const props = PropertiesService.getScriptProperties();
    props.deleteProperty(PROP_QUEUE_KEY);
    props.deleteProperty(PROP_PROCESSING_FLAG);
    return true;
  } catch (e) {
    console.error('clearQueue error', e);
    return false;
  }
}

function setProcessingFlag(val) {
  try {
    const props = PropertiesService.getScriptProperties();
    if (val) props.setProperty(PROP_PROCESSING_FLAG, '1');
    else props.deleteProperty(PROP_PROCESSING_FLAG);
  } catch (e) { console.error('setProcessingFlag error', e); }
}

function getProcessingFlag() {
  try {
    const props = PropertiesService.getScriptProperties();
    return !!props.getProperty(PROP_PROCESSING_FLAG);
  } catch (e) { return false; }
}

// -------------------- Backend comm --------------------
function enqueueJobsToBackend(jobsArray) {
  if (!Array.isArray(jobsArray) || !jobsArray.length) return { ok:false, error:'no jobs' };
  const url = BACKEND_BASE + '/sendq';
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': BACKEND_API_KEY },
    payload: JSON.stringify({ jobs: jobsArray }),
    muteHttpExceptions: true
  };
  try {
    const resp = UrlFetchApp.fetch(url, options);
    const code = resp.getResponseCode();
    const body = resp.getContentText();
    if (code >= 200 && code < 300) {
      try {
        const parsed = JSON.parse(body || '{}');
        storeHistoryItems(jobsArray);
        return { ok:true, status:code, body: parsed };
      } catch (e) {
        storeHistoryItems(jobsArray);
        return { ok:true, status:code, body: body };
      }
    } else {
      return { ok:false, status:code, body:body };
    }
  } catch (e) {
    return { ok:false, error:String(e) };
  }
}

// -------------------- Public server functions --------------------

// Send one-off test message
function server_enqueueTest(phone, message) {
  try {
    const id = makeUUID();
    const normalized = normalizePhoneWithDefault(phone);
    const job = { id: id, phone: normalized, text: message };
    const result = enqueueJobsToBackend([job]);
    return result;
  } catch (e) {
    return { ok:false, error:String(e) };
  }
}

/**
 * server_enqueueForSheet:
 * - builds jobs for the sheet (with rowIndex)
 * - persists full queue to ScriptProperties
 * - immediately processes first batch (non-blocking for large sheets)
 */
function server_enqueueForSheet(phoneColumnName, messageTemplate) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getActiveSheet();
    const lastCol = sh.getLastColumn();
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return { ok:false, error:'no data rows' };

    const headerRow = sh.getRange(1,1,1,lastCol).getValues()[0].map(h=>String(h||'').trim());
    let colIndex = -1;
    for (let i=0;i<headerRow.length;i++){
      if (String(headerRow[i]).toLowerCase() === String(phoneColumnName).toLowerCase()) { colIndex = i+1; break; }
    }
    if (colIndex === -1) return { ok:false, error:'Phone column not found' };

    const numRows = Math.max(0, lastRow - 1);
    if (numRows <= 0) return { ok:false, error:'no data rows' };

    const rows = sh.getRange(2,1,numRows,lastCol).getValues();

    const fullQueue = [];
    for (let r=0;r<rows.length;r++) {
      const row = rows[r];
      const phoneVal = String(row[colIndex-1] || '').trim();
      if (!phoneVal) continue;
      let text = String(messageTemplate || '');
      for (let c=0;c<headerRow.length;c++) {
        const tag = '*|' + headerRow[c] + '|*';
        text = text.split(tag).join(String(row[c] || ''));
      }
      const rowNumber = r + 2;
      fullQueue.push({ id: makeUUID(), phone: normalizePhoneWithDefault(phoneVal), text: text, rowIndex: rowNumber });
    }

    if (!fullQueue.length) return { ok:false, error:'no phone numbers found' };

    // Persist full queue
    persistQueue(fullQueue);

    // Ensure no duplicate batch triggers/processors are active
    if (!getProcessingFlag()) {
      // process the first batch immediately in this execution (to give immediate feedback)
      processBatchNow();
      return { ok:true, message: 'queued_and_started', queued: fullQueue.length };
    } else {
      return { ok:true, message: 'queued_processing_already', queued: fullQueue.length };
    }
  } catch (e) {
    return { ok:false, error:String(e) };
  }
}

// -------------------- Batch processor --------------------
/**
 * processBatchNow:
 * - pop up to BATCH_SIZE jobs from queue
 * - enqueue them to backend one-by-one with a small pause (so spacing between messages)
 * - mark rows as Sent for successful enqueues
 * - if queue remains, schedule next run via one-off time trigger
 *
 * Note: this function is safe to be called by a trigger as well as directly.
 */
function processBatchNow() {
  // Prevent concurrent processors
  if (getProcessingFlag()) {
    // If flag present, allow but avoid reentrancy; simply exit to avoid duplicates.
    // In some rare cases you may want to allow multiple runners, but default is conservative.
    console.log('processBatchNow: another processor is running - exiting');
    return;
  }
  setProcessingFlag(true);

  try {
    let queue = readQueue();
    if (!queue || !queue.length) {
      clearQueue();
      setProcessingFlag(false);
      console.log('processBatchNow: queue empty');
      return;
    }

    // Determine how many to process this run (batch size)
    const toProcess = queue.slice(0, BATCH_SIZE);
    const remaining = queue.slice(toProcess.length); // left-over

    // Compute intra-batch spacing so entire batch fits in BATCH_INTERVAL_SEC
    // If BATCH_SIZE == 1, spacing = 0
    let spacingMs = 0;
    try {
      if (BATCH_SIZE > 1) {
        spacingMs = Math.floor((BATCH_INTERVAL_SEC * 1000) / BATCH_SIZE);
        if (spacingMs < 1000) spacingMs = 1000; // minimum 1s
      }
    } catch (e) { spacingMs = 12000; }

    // Enqueue each job separately, with spacing
    const resultsForThisRun = [];
    for (let i=0;i<toProcess.length;i++) {
      const job = toProcess[i];
      // send single-job array so server returns id mapping etc.
      const resp = enqueueJobsToBackend([job]);
      resultsForThisRun.push({ job: job, resp: resp });
      // If enqueue ok, mark row as Sent immediately
      if (resp && resp.ok) {
        try {
          const sh = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
          markRowAsSent(sh, job.rowIndex);
          updateHistoryForRows([job], 'sent');
        } catch (e) {
          console.error('markRowAsSent error for row ' + job.rowIndex, e);
        }
      } else {
        // If enqueue failed, we keep job in remaining queue for retry later
        console.warn('enqueue failed for job', job, resp);
        remaining.push(job);
      }

      // Sleep between messages except after the last one
      if (i < toProcess.length - 1) {
        Utilities.sleep(spacingMs);
      }
    }

    // Persist updated queue (remaining) or clear if empty
    if (remaining && remaining.length) {
      persistQueue(remaining);
      // schedule next run in BATCH_INTERVAL_SEC seconds
      try {
        scheduleNextBatch(BATCH_INTERVAL_SEC);
      } catch (e) {
        console.error('Failed to schedule next batch', e);
      }
    } else {
      clearQueue();
    }

    setProcessingFlag(false);
    return { ok:true, processed: toProcess.length, remaining: remaining.length || 0, details: resultsForThisRun };
  } catch (e) {
    setProcessingFlag(false);
    console.error('processBatchNow error', e);
    throw e;
  }
}

/**
 * scheduleNextBatch(sec)
 * creates a one-off time-based trigger to call processBatchNow at now + sec.
 */
function scheduleNextBatch(sec) {
  try {
    // Compute future date
    const when = new Date(Date.now() + sec * 1000);
    // One-off trigger at 'when'
    ScriptApp.newTrigger('processBatchNow').timeBased().at(when).create();
    console.log('Scheduled next batch at', when);
  } catch (e) {
    console.error('scheduleNextBatch error', e);
  }
}

// -------------------- Sheet helpers --------------------
function markRowAsSent(sheet, rowNum) {
  try {
    if (!sheet || !rowNum) return;
    const headersRange = sheet.getRange(1,1,1,sheet.getLastColumn());
    const headers = headersRange.getValues()[0].map(h => String(h || '').trim());
    let statusColIndex = headers.indexOf(STATUS_COLUMN_NAME) + 1;
    if (statusColIndex === 0) {
      statusColIndex = sheet.getLastColumn() + 1;
      sheet.insertColumnAfter(sheet.getLastColumn());
      sheet.getRange(1, statusColIndex).setValue(STATUS_COLUMN_NAME);
    }
    const nowStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'UTC', 'yyyy-MM-dd HH:mm:ss');
    sheet.getRange(rowNum, statusColIndex).setValue('Sent (' + nowStr + ')');
  } catch (e) {
    console.error('markRowAsSent error', e);
  }
}

function markRowsAsSent(sheet, jobs) {
  // Convenience wrapper (not used in batched flow but kept for compatibility)
  if (!sheet || !jobs || !jobs.length) return;
  for (let j of jobs) {
    markRowAsSent(sheet, j.rowIndex);
  }
}

// -------------------- History persistence --------------------
function storeHistoryItems(sentJobs) {
  try {
    const props = PropertiesService.getScriptProperties();
    const cur = JSON.parse(props.getProperty(HISTORY_PROP) || '[]');
    const ts = new Date().toISOString();
    for (const j of sentJobs) {
      cur.push({ id: j.id || null, phone: j.phone, text: j.text, status: 'queued', createdAt: ts });
    }
    props.setProperty(HISTORY_PROP, JSON.stringify(cur));
  } catch (e) {
    console.error('storeHistoryItems error', e);
  }
}

function updateHistoryForRows(jobs, status) {
  try {
    const props = PropertiesService.getScriptProperties();
    const cur = JSON.parse(props.getProperty(HISTORY_PROP) || '[]');
    const jobIds = new Set(jobs.map(j => j.id));
    for (let i=0;i<cur.length;i++) {
      const item = cur[i];
      if (item.id && jobIds.has(item.id)) {
        item.status = status;
        item.updatedAt = new Date().toISOString();
      }
    }
    props.setProperty(HISTORY_PROP, JSON.stringify(cur));
  } catch (e) {
    console.error('updateHistoryForRows error', e);
  }
}

function server_getLocalHistory(limit) {
  const props = PropertiesService.getScriptProperties();
  const cur = JSON.parse(props.getProperty(HISTORY_PROP) || '[]');
  if (limit && typeof limit === 'number') return cur.slice(-limit).reverse();
  return cur.reverse();
}

function server_purgeQueue() {
  try {
    const props = PropertiesService.getScriptProperties();
    const cur = JSON.parse(props.getProperty(HISTORY_PROP) || '[]');
    const remaining = cur.filter(i=>i.status !== 'queued');
    props.setProperty(HISTORY_PROP, JSON.stringify(remaining));
    return { ok:true, purged: cur.length - remaining.length };
  } catch (e) {
    return { ok:false, error:String(e) };
  }
}

// -------------------- Default country persistence --------------------
function setUserDefaultCountry(code) {
  try {
    PropertiesService.getUserProperties().setProperty('walution_default_country', String(code));
    return { ok:true };
  } catch (e) { return { ok:false, error:String(e) }; }
}

function getUserDefaultCountry() {
  try {
    return PropertiesService.getUserProperties().getProperty('walution_default_country') || null;
  } catch (e) {
    return null;
  }
}

// -------------------- Misc helpers --------------------
function getSheetHeaders() {
  try {
    const sh = SpreadsheetApp.getActiveSheet();
    const headerRow = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
    return headerRow.map(h=>String(h||'').trim());
  } catch (e) {
    return [];
  }
}
/**
 * server_enqueueForSheetWithOptions
 * Build jobs from sheet rows and send them to backend directly.
 * Each job will include a `meta` field with the batch options for backend-side throttling.
 *
 * options = {
 *   batchSize: number,
 *   batchIntervalSec: number,
 *   jitter: boolean,
 *   defaultCountry: '+91'
 * }
 */
function server_enqueueForSheetWithOptions(phoneColumnName, messageTemplate, options) {
  options = options || {};
  const defaultCountry = options.defaultCountry || getUserDefaultCountry() || '+91';
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getActiveSheet();
    const lastCol = sh.getLastColumn();
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return { ok:false, error:'no data rows' };

    const headerRow = sh.getRange(1,1,1,lastCol).getValues()[0].map(h=>String(h||'').trim());
    let colIndex = -1;
    for (let i=0;i<headerRow.length;i++){
      if (String(headerRow[i]).toLowerCase() === String(phoneColumnName).toLowerCase()) { colIndex = i+1; break; }
    }
    if (colIndex === -1) return { ok:false, error:'Phone column not found' };

    const numRows = Math.max(0, lastRow - 1);
    if (numRows <= 0) return { ok:false, error:'no data rows' };

    const rows = sh.getRange(2,1,numRows,lastCol).getValues();

    const jobs = [];
    for (let r=0;r<rows.length;r++) {
      const row = rows[r];
      const phoneVal = String(row[colIndex-1] || '').trim();
      if (!phoneVal) continue;
      let text = String(messageTemplate || '');
      for (let c=0;c<headerRow.length;c++) {
        const tag = '*|' + headerRow[c] + '|*';
        text = text.split(tag).join(String(row[c] || ''));
      }
      const rowNumber = r + 2;
      const normalized = (phoneVal.startsWith('+') ? phoneVal.replace(/\s+/g,'') : (defaultCountry + phoneVal.replace(/\D/g,'')));
      // attach meta object for backend
      const meta = {
        batchSize: Number(options.batchSize) || 5,
        batchIntervalSec: Number(options.batchIntervalSec) || 60,
        jitter: !!options.jitter,
        defaultCountry: defaultCountry
      };
      jobs.push({ id: makeUUID(), phone: normalized, text: text, rowIndex: rowNumber, meta: meta });
    }

    if (!jobs.length) return { ok:false, error:'no phone numbers found' };

    // send to backend (backend should accept job.meta and do throttling there)
    const result = enqueueJobsToBackend(jobs);
    return Object.assign({}, result, { queued: jobs.length });
  } catch (e) {
    return { ok:false, error:String(e) };
  }
}

/**
 * server_enqueueTestWithOptions(phone, message, options)
 * Single-job enqueue using same meta shape
 */
function server_enqueueTestWithOptions(phone, message, options) {
  options = options || {};
  const defaultCountry = options.defaultCountry || getUserDefaultCountry() || '+91';
  try {
    const normalized = (String(phone || '').startsWith('+') ? phone.replace(/\s+/g,'') : (defaultCountry + String(phone || '').replace(/\D/g,'')));
    const meta = {
      batchSize: Number(options.batchSize) || 5,
      batchIntervalSec: Number(options.batchIntervalSec) || 60,
      jitter: !!options.jitter,
      defaultCountry: defaultCountry
    };
    const job = { id: makeUUID(), phone: normalized, text: String(message || ''), meta: meta };
    const resp = enqueueJobsToBackend([job]);
    return resp;
  } catch (e) {
    return { ok:false, error:String(e) };
  }
}
