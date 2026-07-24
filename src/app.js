/* Shopify Cycle Count App
 * Fully client-side. No server, no network calls, no data leaves this machine.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'cycleCountSession_v1';
  var root = document.getElementById('app');

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  function freshState() {
    return {
      screen: 'start', // start | location | summary | counting | report
      productsFileName: null,
      inventoryFileName: null,
      products: [],          // [{sku, barcode, title, variantLabel, costPerItem}]
      productsBySku: {},     // sku -> [product record, ...]  (usually one; more when a SKU is shared across variants)
      barcodeToRecord: {},   // barcode -> product record (single owner)
      barcodeConflicts: {},  // barcode -> [record,...]  (2+ distinct SKUs sharing a barcode)
      sharedSkus: [],        // [{sku, variantLabels}] - same SKU legitimately used by >1 variant (e.g. King/Cal King)
      duplicateRowWarnings: [], // [{sku, variantLabel}] - exact same SKU+variant repeated, likely an export glitch
      inventoryByLocation: {}, // location -> { "sku||variant" -> {sku, variantLabel, onHand, notStocked, sourceRow} }
      locations: [],
      skusMissingFromProducts: [], // unique skus seen in inventory but not in products (global, informational)
      selectedLocation: null,
      countLines: {},   // "sku||variant" -> {sku, barcode, title, variantLabel, costPerItem, expected, counted, noBarcode, notInProducts, lastUpdated, key}
      extraLines: {},   // "sku||variant" -> same shape, expected forced to 0, foundUnexpected:true
      skuToCountKeys: {}, // sku -> [countLine key, ...] so a scanned barcode resolves to its expected line(s) by SKU
      scanLog: [],      // {t, input, result, key}
      unrecognizedScans: {}, // rawValue -> count
      startedAt: null,
      finishedAt: null,
      seq: 0
    };
  }

  var state = loadState() || freshState();
  var resumeBannerDismissed = false;

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.screen) return null;
      return parsed;
    } catch (e) {
      return null;
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.error('Could not save session', e);
    }
  }

  function clearSavedSession() {
    localStorage.removeItem(STORAGE_KEY);
  }

  function resetAll() {
    clearSavedSession();
    state = freshState();
    resumeBannerDismissed = true;
    render();
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtMoney(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    var neg = n < 0;
    var v = Math.abs(n).toFixed(2);
    return (neg ? '-$' : '$') + v;
  }

  function fmtNum(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return String(n);
  }

  function parseCost(raw) {
    if (raw === undefined || raw === null) return null;
    var s = String(raw).trim().replace(/[^0-9.\-]/g, '');
    if (s === '') return null;
    var v = parseFloat(s);
    return isNaN(v) ? null : v;
  }

  function nowStr() {
    var d = new Date();
    return d.toLocaleString();
  }

  function toastStack() {
    var el = document.getElementById('toast-stack');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast-stack';
      el.className = 'toast-stack';
      document.body.appendChild(el);
    }
    return el;
  }

  function toast(msg, type) {
    var stack = toastStack();
    var t = document.createElement('div');
    t.className = 'toast ' + (type || 'ok');
    t.textContent = msg;
    stack.appendChild(t);
    setTimeout(function () {
      t.style.transition = 'opacity .3s';
      t.style.opacity = '0';
      setTimeout(function () { t.remove(); }, 300);
    }, 2600);
  }

  // In-app confirm modal. Native window.confirm()/alert() can be silently
  // blocked inside some locked-down kiosk/embedded browser wrappers, so
  // the app never relies on them.
  function showConfirm(message, opts) {
    opts = opts || {};
    var backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = '<div class="modal"><p>' + esc(message) + '</p><div class="actions">' +
      '<button id="modal-cancel">' + esc(opts.cancelLabel || 'Cancel') + '</button>' +
      '<button id="modal-ok" class="primary' + (opts.danger ? ' danger' : '') + '">' + esc(opts.okLabel || 'OK') + '</button>' +
      '</div></div>';
    document.body.appendChild(backdrop);
    function cleanup() { backdrop.remove(); }
    document.getElementById('modal-cancel').onclick = function () { cleanup(); if (opts.onCancel) opts.onCancel(); };
    document.getElementById('modal-ok').onclick = function () { cleanup(); if (opts.onConfirm) opts.onConfirm(); };
    backdrop.onclick = function (e) { if (e.target === backdrop) { cleanup(); if (opts.onCancel) opts.onCancel(); } };
  }

  // ---------------------------------------------------------------------
  // CSV parsing
  // ---------------------------------------------------------------------
  function parseCsvFile(file, cb) {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: function (results) {
        cb(null, results.data, results.meta.fields || []);
      },
      error: function (err) {
        cb(err);
      }
    });
  }

  function getVal(row, key) {
    if (row[key] === undefined) return '';
    return String(row[key]).trim();
  }

  // SKU/barcode/location values become object keys throughout this app.
  // A CSV cell containing exactly one of these names could otherwise be used
  // to reach into an object's prototype instead of storing a plain property.
  function isUnsafeKey(k) {
    return k === '__proto__' || k === 'constructor' || k === 'prototype';
  }

  function joinVariantLabel(v1, v2, v3) {
    return [v1, v2, v3].filter(Boolean).join(' / ');
  }

  function normVariant(v) {
    return (v || '').toLowerCase().trim();
  }

  // Count lines are keyed by SKU + the INVENTORY file's own variant label, so
  // that two inventory rows sharing one SKU (e.g. King vs Cal King, when a
  // supplier only distinguishes them by barcode) stay as separate lines.
  // NOTE: this key is only ever compared within the inventory file / count —
  // never against the Products file. The Products file often writes option
  // values differently (linked metafield options export as lowercase slugs,
  // e.g. "indigo-chambray" vs the inventory's "Indigo Chambray"), so product
  // data is matched by SKU, never by this key. See pickProductForSku.
  function lineKey(sku, variantLabel) {
    return sku + '||' + normVariant(variantLabel);
  }

  // Choose the Products record for an inventory line. Match on SKU (identical
  // across both export types); only use the variant label to disambiguate when
  // one SKU maps to several product variants (a shared SKU). Returns null only
  // when the SKU genuinely does not appear in the Products file at all.
  function pickProductForSku(sku, invVariantLabel) {
    var recs = state.productsBySku[sku];
    if (!recs || !recs.length) return null;
    if (recs.length === 1) return recs[0];
    var norm = normVariant(invVariantLabel);
    var matched = recs.filter(function (r) { return normVariant(r.variantLabel) === norm; });
    return matched.length === 1 ? matched[0] : recs[0];
  }

  function processProductsRows(rows) {
    var products = [];
    var productsBySku = {};
    var barcodeToRecord = {};
    var barcodeConflicts = {};
    var handleTitle = {};
    var seenKeys = {};
    var duplicateRowWarnings = []; // exact same SKU+variant repeated - likely an export glitch

    // forward-fill Title per Handle (Shopify export leaves Title blank on
    // every row after the first for a given product)
    rows.forEach(function (row) {
      var handle = getVal(row, 'Handle');
      var title = getVal(row, 'Title');
      if (handle && title && !handleTitle[handle]) handleTitle[handle] = title;
    });

    rows.forEach(function (row) {
      var sku = getVal(row, 'Variant SKU');
      if (!sku || isUnsafeKey(sku)) return; // image-only, malformed, or unsafe rows
      var handle = getVal(row, 'Handle');
      var title = getVal(row, 'Title') || handleTitle[handle] || handle || '(untitled product)';
      var variantLabel = joinVariantLabel(getVal(row, 'Option1 Value'), getVal(row, 'Option2 Value'), getVal(row, 'Option3 Value'));
      var barcode = getVal(row, 'Variant Barcode');
      var cost = parseCost(row['Cost per item']);
      var key = lineKey(sku, variantLabel);

      if (seenKeys[key]) duplicateRowWarnings.push({ sku: sku, variantLabel: variantLabel });
      seenKeys[key] = true;

      var record = {
        sku: sku,
        barcode: barcode,
        title: title,
        variantLabel: variantLabel,
        costPerItem: cost
      };
      products.push(record);
      if (!productsBySku[sku]) productsBySku[sku] = [];
      productsBySku[sku].push(record);

      if (barcode && !isUnsafeKey(barcode)) {
        if (barcodeConflicts[barcode]) {
          if (barcodeConflicts[barcode].every(function (r) { return r.sku !== sku || normVariant(r.variantLabel) !== normVariant(variantLabel); })) barcodeConflicts[barcode].push(record);
        } else if (barcodeToRecord[barcode] && barcodeToRecord[barcode].sku !== sku) {
          barcodeConflicts[barcode] = [barcodeToRecord[barcode], record];
          delete barcodeToRecord[barcode];
        } else {
          barcodeToRecord[barcode] = record;
        }
      }
    });

    // A SKU used by more than one distinct variant label (e.g. King/Cal King).
    var sharedSkus = Object.keys(productsBySku)
      .map(function (sku) {
        var labels = [];
        productsBySku[sku].forEach(function (r) { if (labels.indexOf(r.variantLabel) === -1) labels.push(r.variantLabel); });
        return { sku: sku, variantLabels: labels };
      })
      .filter(function (s) { return s.variantLabels.length > 1; });

    return {
      products: products,
      productsBySku: productsBySku,
      barcodeToRecord: barcodeToRecord,
      barcodeConflicts: barcodeConflicts,
      sharedSkus: sharedSkus,
      duplicateRowWarnings: duplicateRowWarnings
    };
  }

  function processInventoryRows(rows) {
    var inventoryByLocation = {};
    var locationSet = {};

    rows.forEach(function (row) {
      var sku = getVal(row, 'SKU');
      var location = getVal(row, 'Location');
      if (!sku || !location || isUnsafeKey(sku) || isUnsafeKey(location)) return;
      locationSet[location] = true;
      if (!inventoryByLocation[location]) inventoryByLocation[location] = {};

      var raw = getVal(row, 'On hand (current)');
      var notStocked = /not stocked/i.test(raw) || raw === '';
      var onHand = notStocked ? null : parseFloat(raw.replace(/[^0-9.\-]/g, ''));
      if (isNaN(onHand)) { onHand = null; notStocked = true; }

      // Keyed by SKU + variant, not bare SKU: two rows sharing one SKU (e.g.
      // King and Cal King, when a supplier only distinguishes them by
      // barcode) must stay as two separate lines, or one's on-hand quantity
      // silently overwrites the other's instead of being tracked alongside it.
      var variantLabel = joinVariantLabel(getVal(row, 'Option1 Value'), getVal(row, 'Option2 Value'), getVal(row, 'Option3 Value'));
      var key = lineKey(sku, variantLabel);

      // Keep the original row's own fields so a Shopify-importable inventory
      // file can be regenerated later as a faithful echo of this file, with
      // only "On hand (new)" filled in from the physical count.
      inventoryByLocation[location][key] = {
        sku: sku,
        variantLabel: variantLabel,
        onHand: onHand,
        notStocked: notStocked,
        sourceRow: {
          handle: getVal(row, 'Handle'),
          title: getVal(row, 'Title'),
          option1Name: getVal(row, 'Option1 Name'),
          option1Value: getVal(row, 'Option1 Value'),
          option2Name: getVal(row, 'Option2 Name'),
          option2Value: getVal(row, 'Option2 Value'),
          option3Name: getVal(row, 'Option3 Name'),
          option3Value: getVal(row, 'Option3 Value'),
          hsCode: getVal(row, 'HS Code'),
          coo: getVal(row, 'COO'),
          binName: getVal(row, 'Bin name'),
          incoming: getVal(row, 'Incoming (not editable)'),
          unavailable: getVal(row, 'Unavailable (not editable)'),
          committed: getVal(row, 'Committed (not editable)'),
          available: getVal(row, 'Available (not editable)')
        }
      };
    });

    return {
      inventoryByLocation: inventoryByLocation,
      locations: Object.keys(locationSet).sort()
    };
  }

  function computeMissingFromProducts() {
    var missing = {};
    Object.keys(state.inventoryByLocation).forEach(function (loc) {
      var m = state.inventoryByLocation[loc];
      Object.keys(m).forEach(function (key) {
        var sku = m[key].sku;
        // "Missing" means the SKU itself is absent from the Products file.
        // Matching is by SKU, never by variant label — the two exports format
        // linked-option variant labels differently. See pickProductForSku.
        if (!m[key].notStocked && !state.productsBySku[sku]) missing[sku] = true;
      });
    });
    return Object.keys(missing).sort();
  }

  // ---------------------------------------------------------------------
  // File handling
  // ---------------------------------------------------------------------
  function handleProductsFile(file) {
    parseCsvFile(file, function (err, rows) {
      if (err) { toast('Could not read Products CSV: ' + err.message, 'bad'); return; }
      var result = processProductsRows(rows);
      state.products = result.products;
      state.productsBySku = result.productsBySku;
      state.barcodeToRecord = result.barcodeToRecord;
      state.barcodeConflicts = result.barcodeConflicts;
      state.sharedSkus = result.sharedSkus;
      state.duplicateRowWarnings = result.duplicateRowWarnings;
      state.productsFileName = file.name;
      state.skusMissingFromProducts = computeMissingFromProducts();
      saveState();
      render();
    });
  }

  function handleInventoryFile(file) {
    parseCsvFile(file, function (err, rows) {
      if (err) { toast('Could not read Inventory CSV: ' + err.message, 'bad'); return; }
      var result = processInventoryRows(rows);
      state.inventoryByLocation = result.inventoryByLocation;
      state.locations = result.locations;
      state.inventoryFileName = file.name;
      state.skusMissingFromProducts = computeMissingFromProducts();
      saveState();
      render();
    });
  }

  // ---------------------------------------------------------------------
  // Location selection -> build count lines
  // ---------------------------------------------------------------------
  function selectLocation(location) {
    state.selectedLocation = location;
    var expected = state.inventoryByLocation[location] || {};
    var countLines = {};
    var skuToCountKeys = {};

    Object.keys(expected).forEach(function (key) {
      var entry = expected[key];
      if (entry.notStocked) return; // not carried at this location at all
      // Match product data by SKU (identical across both exports). Use the
      // inventory variant label only to disambiguate a shared SKU.
      var product = pickProductForSku(entry.sku, entry.variantLabel);
      // Keep the Inventory file's own variant label for display — it's the
      // human-readable one ("Indigo Chambray"), whereas a linked-option
      // Products row may only have the slug ("indigo-chambray").
      var fallbackTitle = entry.sourceRow.title || entry.sourceRow.handle || '(unknown product)';
      countLines[key] = {
        sku: entry.sku,
        barcode: product ? product.barcode : '',
        title: product ? product.title : fallbackTitle,
        variantLabel: entry.variantLabel || (product ? product.variantLabel : ''),
        costPerItem: product ? product.costPerItem : null,
        expected: entry.onHand || 0,
        counted: 0,
        noBarcode: !product || !product.barcode,
        notInProducts: !product,
        lastUpdated: 0,
        key: key,
        sourceRow: entry.sourceRow
      };
      if (!skuToCountKeys[entry.sku]) skuToCountKeys[entry.sku] = [];
      skuToCountKeys[entry.sku].push(key);
    });

    state.countLines = countLines;
    state.skuToCountKeys = skuToCountKeys;
    state.extraLines = {};
    state.scanLog = [];
    state.unrecognizedScans = {};
    state.startedAt = nowStr();
    state.finishedAt = null;
    state.screen = 'summary';
    saveState();
    render();
  }

  // ---------------------------------------------------------------------
  // Scanning
  // ---------------------------------------------------------------------
  function bumpLine(lines, key, delta) {
    var line = lines[key];
    if (!line) return false;
    line.counted = Math.max(0, line.counted + delta);
    line.lastUpdated = ++state.seq;
    return true;
  }

  function describeRecord(r) {
    return r.sku + (r.variantLabel ? ' (' + r.variantLabel + ')' : '');
  }

  function processScan(rawValue) {
    var val = rawValue.trim();
    if (!val) return;
    if (isUnsafeKey(val)) {
      toast('Ignored invalid scan value: ' + val, 'bad');
      return;
    }
    var entry = { t: nowStr(), input: val, result: '', key: null };

    if (state.barcodeConflicts[val]) {
      entry.result = 'conflict';
      state.scanLog.push(entry);
      toast('Barcode ' + val + ' matches multiple variants (' + state.barcodeConflicts[val].map(describeRecord).join(', ') + '). Use manual search below to pick the right one.', 'bad');
      saveState();
      return;
    }

    var record = state.barcodeToRecord[val];
    if (!record) {
      state.unrecognizedScans[val] = (state.unrecognizedScans[val] || 0) + 1;
      entry.result = 'unknown';
      state.scanLog.push(entry);
      toast('Unknown barcode: ' + val, 'bad');
      saveState();
      renderCountingStatsTabs();
      renderCountingLists();
      return;
    }

    // Resolve the scanned barcode to a count line by SKU (product and inventory
    // variant labels are formatted differently, so never key on the label). If
    // the SKU has several expected lines here (a shared SKU), disambiguate by
    // matching the scanned variant to the inventory variant.
    var candidateKeys = state.skuToCountKeys[record.sku] || [];
    var key = null;
    if (candidateKeys.length === 1) {
      key = candidateKeys[0];
    } else if (candidateKeys.length > 1) {
      var norm = normVariant(record.variantLabel);
      var matched = candidateKeys.filter(function (k) { return normVariant(state.countLines[k].variantLabel) === norm; });
      key = matched.length === 1 ? matched[0] : candidateKeys[0];
      if (matched.length !== 1) {
        toast('SKU ' + record.sku + ' has multiple variants at this location and the barcode could not tell them apart — added to the first; verify manually.', 'warn');
      }
    }

    if (key) {
      bumpLine(state.countLines, key, 1);
      entry.key = key;
      entry.result = 'ok';
      var line = state.countLines[key];
      toast((line.title + (line.variantLabel ? ' — ' + line.variantLabel : '')) + '  +1  (now ' + line.counted + ')', 'ok');
    } else {
      var extraKey = lineKey(record.sku, record.variantLabel);
      addOrBumpExtra(extraKey, record);
      entry.key = extraKey;
      entry.result = 'extra';
      var el = state.extraLines[extraKey];
      toast('Not expected at this location! ' + el.title + '  +1  (now ' + el.counted + ') — will show as overage', 'warn');
    }
    state.scanLog.push(entry);
    saveState();
    renderCountingStatsTabs();
    renderCountingLists();
  }

  function addOrBumpExtra(key, product) {
    if (!state.extraLines[key]) {
      state.extraLines[key] = {
        sku: product ? product.sku : key,
        barcode: product ? product.barcode : '',
        title: product ? product.title : '(unknown product)',
        variantLabel: product ? product.variantLabel : '',
        costPerItem: product ? product.costPerItem : null,
        expected: 0,
        counted: 0,
        noBarcode: !product || !product.barcode,
        notInProducts: !product,
        foundUnexpected: true,
        lastUpdated: 0,
        key: key
      };
    }
    bumpLine(state.extraLines, key, 1);
  }

  function manualAdjust(key, delta, isExtra) {
    var lines = isExtra ? state.extraLines : state.countLines;
    bumpLine(lines, key, delta);
    saveState();
    renderCountingStatsTabs();
    renderCountingLists();
  }

  function undoLastScan() {
    var entry = state.scanLog.pop();
    if (!entry) { toast('Nothing to undo', 'warn'); return; }
    if (entry.result === 'ok') {
      bumpLine(state.countLines, entry.key, -1);
    } else if (entry.result === 'extra') {
      bumpLine(state.extraLines, entry.key, -1);
    } else if (entry.result === 'unknown') {
      if (state.unrecognizedScans[entry.input] > 1) state.unrecognizedScans[entry.input]--;
      else delete state.unrecognizedScans[entry.input];
    }
    saveState();
    toast('Undid last scan: ' + entry.input, 'warn');
    renderCountingStatsTabs();
    renderCountingLists();
  }

  // ---------------------------------------------------------------------
  // Report computation
  // ---------------------------------------------------------------------
  function buildReportRows() {
    var all = [];
    Object.keys(state.countLines).forEach(function (sku) { all.push(state.countLines[sku]); });
    Object.keys(state.extraLines).forEach(function (sku) { all.push(state.extraLines[sku]); });

    all.forEach(function (l) {
      l.diff = l.counted - l.expected;
      var cost = l.costPerItem === null || l.costPerItem === undefined ? 0 : l.costPerItem;
      l.costImpact = l.diff * cost;
    });

    return all;
  }

  function reportTotals(rows) {
    var t = {
      totalExpected: 0, totalCounted: 0, netUnitDiff: 0,
      overageDollars: 0, shortageDollars: 0, netDollars: 0,
      discrepancyCount: 0, matchCount: 0
    };
    rows.forEach(function (r) {
      t.totalExpected += r.expected;
      t.totalCounted += r.counted;
      t.netUnitDiff += r.diff;
      if (r.costImpact > 0) t.overageDollars += r.costImpact;
      if (r.costImpact < 0) t.shortageDollars += -r.costImpact;
      if (r.diff !== 0) t.discrepancyCount++; else t.matchCount++;
    });
    t.netDollars = t.overageDollars - t.shortageDollars;
    return t;
  }

  // ---------------------------------------------------------------------
  // Excel export
  // ---------------------------------------------------------------------
  var REPORT_ROW_HEADER = ['SKU', 'Title', 'Variant', 'Expected', 'Counted', 'Difference', 'Cost/Item', 'Cost Impact', 'Notes'];
  var REPORT_COL_WIDTHS = [{ wch: 16 }, { wch: 34 }, { wch: 24 }, { wch: 10 }, { wch: 10 }, { wch: 11 }, { wch: 10 }, { wch: 12 }, { wch: 34 }];

  function reportRowToAoa(r) {
    var notes = [];
    if (r.notInProducts) notes.push('Not in Products file');
    if (r.noBarcode && !r.notInProducts) notes.push('No barcode on file');
    if (r.foundUnexpected) notes.push('Found at location but not expected here');
    if (r.costPerItem === null || r.costPerItem === undefined) notes.push('No cost data');
    return [r.sku, r.title, r.variantLabel, r.expected, r.counted, r.diff,
      r.costPerItem === null ? null : r.costPerItem, r.costImpact, notes.join('; ')];
  }

  function exportFilename(suffix) {
    var dateStr = new Date().toISOString().slice(0, 10);
    var safeLoc = (state.selectedLocation || 'location').replace(/[^a-z0-9]+/gi, '-');
    return 'Cycle Count' + (suffix ? ' ' + suffix : '') + ' - ' + safeLoc + ' - ' + dateStr + '.xlsx';
  }

  function exportExcel() {
    var rows = buildReportRows();
    var totals = reportTotals(rows);
    var discrepancies = rows.filter(function (r) { return r.diff !== 0; })
      .sort(function (a, b) { return a.costImpact - b.costImpact; });
    var matches = rows.filter(function (r) { return r.diff === 0; })
      .sort(function (a, b) { return a.title.localeCompare(b.title); });

    var aoa = [];
    aoa.push(['Shopify Cycle Count Report']);
    aoa.push(['Location', state.selectedLocation]);
    aoa.push(['Started', state.startedAt]);
    aoa.push(['Finished', state.finishedAt]);
    aoa.push(['Products file', state.productsFileName]);
    aoa.push(['Inventory file', state.inventoryFileName]);
    aoa.push([]);
    aoa.push(['SUMMARY']);
    aoa.push(['Total expected units', totals.totalExpected]);
    aoa.push(['Total counted units', totals.totalCounted]);
    aoa.push(['Net unit difference', totals.netUnitDiff]);
    aoa.push(['Total overage ($)', totals.overageDollars]);
    aoa.push(['Total shortage ($)', -totals.shortageDollars]);
    aoa.push(['Net dollar variance', totals.netDollars]);
    aoa.push(['Variants with discrepancies', totals.discrepancyCount]);
    aoa.push(['Variants matching exactly', totals.matchCount]);
    aoa.push([]);

    aoa.push(['DISCREPANCIES (' + discrepancies.length + ')']);
    aoa.push(REPORT_ROW_HEADER);
    discrepancies.forEach(function (r) { aoa.push(reportRowToAoa(r)); });
    aoa.push([]);
    aoa.push(['MATCHES (' + matches.length + ')']);
    aoa.push(REPORT_ROW_HEADER);
    matches.forEach(function (r) { aoa.push(reportRowToAoa(r)); });

    var unknown = Object.keys(state.unrecognizedScans);
    var wb = XLSX.utils.book_new();
    var ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = REPORT_COL_WIDTHS;
    XLSX.utils.book_append_sheet(wb, ws, 'Cycle Count Report');

    if (unknown.length) {
      var aoa2 = [['Unrecognized Scans (barcodes not found in Products file)'], [], ['Scanned value', 'Times scanned']];
      unknown.forEach(function (u) { aoa2.push([u, state.unrecognizedScans[u]]); });
      var ws2 = XLSX.utils.aoa_to_sheet(aoa2);
      ws2['!cols'] = [{ wch: 24 }, { wch: 14 }];
      XLSX.utils.book_append_sheet(wb, ws2, 'Unrecognized Scans');
    }

    XLSX.writeFile(wb, exportFilename());
    toast('Full report exported', 'ok');
  }

  function exportDiscrepanciesExcel() {
    var rows = buildReportRows();
    var totals = reportTotals(rows);
    var discrepancies = rows.filter(function (r) { return r.diff !== 0; })
      .sort(function (a, b) { return a.costImpact - b.costImpact; });

    if (!discrepancies.length) {
      toast('No discrepancies to export — everything counted matched.', 'ok');
      return;
    }

    var aoa = [];
    aoa.push(['Cycle Count — Discrepancies Only (for manual adjustment)']);
    aoa.push(['Location', state.selectedLocation]);
    aoa.push(['Started', state.startedAt]);
    aoa.push(['Finished', state.finishedAt]);
    aoa.push([]);
    aoa.push(['Variants with discrepancies', totals.discrepancyCount]);
    aoa.push(['Net unit difference', totals.netUnitDiff]);
    aoa.push(['Total overage ($)', totals.overageDollars]);
    aoa.push(['Total shortage ($)', -totals.shortageDollars]);
    aoa.push(['Net dollar variance', totals.netDollars]);
    aoa.push([]);
    aoa.push(REPORT_ROW_HEADER);
    discrepancies.forEach(function (r) { aoa.push(reportRowToAoa(r)); });

    var wb = XLSX.utils.book_new();
    var ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = REPORT_COL_WIDTHS;
    XLSX.utils.book_append_sheet(wb, ws, 'Discrepancies');

    XLSX.writeFile(wb, exportFilename('DISCREPANCIES ONLY'));
    toast('Discrepancies-only file exported', 'ok');
  }

  function downloadCsv(filename, aoa) {
    // Trailing CRLF so the final row is newline-terminated, matching Shopify's
    // own export format. UTF-8, and deliberately NO byte-order mark: a BOM
    // would prepend bytes to the "Handle" header and break Shopify's exact
    // header-name matching on import.
    var csv = Papa.unparse(aoa) + '\r\n';
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  var SHOPIFY_INVENTORY_HEADER = ['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Option2 Name', 'Option2 Value',
    'Option3 Name', 'Option3 Value', 'SKU', 'HS Code', 'COO', 'Location', 'Bin name',
    'Incoming (not editable)', 'Unavailable (not editable)', 'Committed (not editable)', 'Available (not editable)',
    'On hand (current)', 'On hand (new)'];

  // Matches Shopify's own "inventory bin / new on-hand" import template exactly,
  // so it can be re-uploaded through Shopify's inventory import as-is. Only
  // includes variants that came from a real row in the uploaded Inventory CSV
  // (i.e. state.countLines) — items found unexpectedly during scanning
  // (state.extraLines) have no such row for this location and are left out,
  // since Shopify would need that SKU connected to this location first.
  function exportShopifyInventoryImport() {
    var lines = Object.values(state.countLines).filter(function (l) { return l.sourceRow; });
    if (!lines.length) {
      toast('Nothing to export.', 'warn');
      return;
    }

    function doExport() {
      var aoa = [SHOPIFY_INVENTORY_HEADER];
      lines.forEach(function (l) {
        var sr = l.sourceRow;
        aoa.push([
          sr.handle, sr.title, sr.option1Name, sr.option1Value, sr.option2Name, sr.option2Value, sr.option3Name, sr.option3Value,
          l.sku, sr.hsCode, sr.coo, state.selectedLocation, sr.binName,
          sr.incoming, sr.unavailable, sr.committed, sr.available,
          l.expected, l.counted
        ]);
      });

      var skippedExtra = Object.keys(state.extraLines).length;
      if (skippedExtra) {
        toast(skippedExtra + ' unexpected find(s) left out — not tracked at this location in Shopify yet, so they need to be added manually', 'warn');
      }

      var dateStr = new Date().toISOString().slice(0, 10);
      var safeLoc = (state.selectedLocation || 'location').replace(/[^a-z0-9]+/gi, '-');
      downloadCsv('Cycle Count IMPORTABLE INVENTORY CHANGES - ' + safeLoc + ' - ' + dateStr + '.csv', aoa);
      toast('Importable inventory changes file exported', 'ok');
    }

    // This file SETS on-hand quantities in Shopify. Any expected variant that
    // was never scanned exports as 0, so re-importing zeroes it out. That is
    // correct for a complete location count but destructive for a partial one,
    // so confirm the impact whenever there are items that would be zeroed.
    var zeroCount = lines.filter(function (l) { return l.counted === 0; }).length;
    if (zeroCount > 0) {
      showConfirm(
        'This file will set on-hand quantities at "' + state.selectedLocation + '" for ' + lines.length + ' variant(s) in Shopify. ' +
        zeroCount + ' of them were not scanned and will be set to 0 — only correct if this was a complete count of the whole location. Export the file?',
        { okLabel: 'Export file', onConfirm: doExport }
      );
    } else {
      doExport();
    }
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------
  function render() {
    if (state.screen === 'start') return renderStart();
    if (state.screen === 'location') return renderLocation();
    if (state.screen === 'summary') return renderSummary();
    if (state.screen === 'counting') return renderCounting();
    if (state.screen === 'report') return renderReport();
  }

  function stepper(activeIdx) {
    var steps = ['Load files', 'Pick location', 'Review', 'Count', 'Report'];
    return '<div class="stepper">' + steps.map(function (s, i) {
      return '<span class="step' + (i === activeIdx ? ' active' : '') + '">' + (i + 1) + '. ' + s + '</span>';
    }).join(' &rarr; ') + '</div>';
  }

  function resumeBanner() {
    if (resumeBannerDismissed) return '';
    if (state.screen === 'start' && !state.selectedLocation) return '';
    if (state.finishedAt) return '';
    if (state.screen === 'start') return '';
    return '';
  }

  function renderStart() {
    var hasSaved = (state.productsFileName || state.inventoryFileName || state.selectedLocation) && state.screen !== 'start';
    var html = '';
    html += '<h1>Shopify Cycle Count</h1>';
    html += '<p class="muted">Upload your Products export and Inventory export to begin a count. Everything stays on this computer.</p>';

    if (!resumeBannerDismissed && loadState() && (loadState().selectedLocation || loadState().screen !== 'start')) {
      var saved = loadState();
      html += '<div class="banner info">' +
        '<div><strong>Resume in-progress count?</strong><br>' +
        (saved.selectedLocation ? 'Location: ' + esc(saved.selectedLocation) + ' — started ' + esc(saved.startedAt) : 'Files loaded, no location picked yet') +
        '</div>' +
        '<div><button id="btn-resume" class="primary">Resume</button> <button id="btn-discard">Discard &amp; start over</button></div>' +
        '</div>';
    }

    html += stepper(0);
    html += '<div class="grid-2">';
    html += dropzoneHtml('products', 'Products CSV', state.productsFileName, 'Contains Variant SKU, Variant Barcode, Cost per item');
    html += dropzoneHtml('inventory', 'Inventory CSV', state.inventoryFileName, 'Contains SKU, Location, On hand (current)');
    html += '</div>';

    html += '<div style="text-align:center; margin-top:20px;">';
    html += '<button id="btn-continue" class="primary" ' + (state.productsFileName && state.inventoryFileName ? '' : 'disabled') + '>Continue &rarr;</button>';
    html += '</div>';

    html += '<footer class="app-footer">Runs entirely offline in your browser. No data is uploaded anywhere.</footer>';
    root.innerHTML = html;

    bindDropzone('products', handleProductsFile);
    bindDropzone('inventory', handleInventoryFile);

    var contBtn = document.getElementById('btn-continue');
    if (contBtn) contBtn.onclick = function () {
      state.screen = 'location';
      saveState();
      render();
    };
    var resumeBtn = document.getElementById('btn-resume');
    if (resumeBtn) resumeBtn.onclick = function () {
      state = loadState();
      render();
    };
    var discardBtn = document.getElementById('btn-discard');
    if (discardBtn) discardBtn.onclick = function () {
      showConfirm('Discard the saved in-progress count? This cannot be undone.', {
        okLabel: 'Discard', danger: true, onConfirm: resetAll
      });
    };
  }

  function dropzoneHtml(id, label, fileName, hint) {
    var loaded = !!fileName;
    return '<div class="dropzone' + (loaded ? ' loaded' : '') + '" id="dz-' + id + '">' +
      '<div><strong>' + label + '</strong></div>' +
      '<div class="muted" style="font-size:13px; margin:4px 0 10px;">' + esc(hint) + '</div>' +
      (loaded ?
        '<div class="file-name">&#10003; ' + esc(fileName) + '</div><button class="small" id="btn-change-' + id + '" style="margin-top:8px;">Change file</button>' :
        '<div>Drag &amp; drop the CSV here, or</div><button class="small" id="btn-browse-' + id + '" style="margin-top:8px;">Browse files</button>') +
      '<input type="file" accept=".csv" id="file-' + id + '">' +
      '</div>';
  }

  function bindDropzone(id, handler) {
    var dz = document.getElementById('dz-' + id);
    var input = document.getElementById('file-' + id);
    var browseBtn = document.getElementById('btn-browse-' + id);
    var changeBtn = document.getElementById('btn-change-' + id);
    if (browseBtn) browseBtn.onclick = function () { input.click(); };
    if (changeBtn) changeBtn.onclick = function () { input.click(); };
    input.onchange = function (e) {
      if (e.target.files && e.target.files[0]) handler(e.target.files[0]);
    };
    dz.ondragover = function (e) { e.preventDefault(); dz.classList.add('drag-over'); };
    dz.ondragleave = function () { dz.classList.remove('drag-over'); };
    dz.ondrop = function (e) {
      e.preventDefault();
      dz.classList.remove('drag-over');
      var f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handler(f);
    };
  }

  function renderLocation() {
    var html = '';
    html += '<h1>Which location are you counting?</h1>';
    html += stepper(1);
    if (!state.locations.length) {
      html += '<div class="banner bad">No locations found in the Inventory CSV. Please check the file and go back.</div>';
    } else {
      html += '<div class="panel">';
      state.locations.forEach(function (loc) {
        var count = Object.keys(state.inventoryByLocation[loc] || {}).filter(function (s) { return !state.inventoryByLocation[loc][s].notStocked; }).length;
        html += '<div style="display:flex; align-items:center; justify-content:space-between; padding:12px 6px; border-bottom:1px solid var(--border);">' +
          '<div><strong>' + esc(loc) + '</strong> <span class="muted">(' + count + ' variants stocked here)</span></div>' +
          '<button class="primary btn-pick-loc" data-loc="' + esc(loc) + '">Select</button>' +
          '</div>';
      });
      html += '</div>';
    }
    html += '<button id="btn-back-start" class="ghost">&larr; Back</button>';
    root.innerHTML = html;

    document.querySelectorAll('.btn-pick-loc').forEach(function (btn) {
      btn.onclick = function () { selectLocation(btn.getAttribute('data-loc')); };
    });
    document.getElementById('btn-back-start').onclick = function () {
      state.screen = 'start';
      saveState();
      render();
    };
  }

  function renderSummary() {
    var lines = Object.values(state.countLines);
    var noBarcodeCount = lines.filter(function (l) { return l.noBarcode && !l.notInProducts; }).length;
    var notInProductsCount = lines.filter(function (l) { return l.notInProducts; }).length;
    var conflictCount = Object.keys(state.barcodeConflicts).length;
    var dupRowCount = state.duplicateRowWarnings.length;
    var sharedSkuCount = state.sharedSkus.length;

    var html = '';
    html += '<h1>Ready to count: ' + esc(state.selectedLocation) + '</h1>';
    html += stepper(2);
    html += '<div class="stats-row">';
    html += statHtml(lines.length, 'Variants expected');
    html += statHtml(noBarcodeCount, 'Missing barcode');
    html += statHtml(notInProductsCount, 'Not in Products file');
    html += statHtml(conflictCount, 'Duplicate barcodes');
    html += '</div>';

    if (noBarcodeCount || notInProductsCount || conflictCount || dupRowCount) {
      html += '<div class="banner warn">Some data issues were found — items below will still be trackable via manual search during counting, but double-check them.</div>';
    } else {
      html += '<div class="banner info">No data issues found. You\'re good to start scanning.</div>';
    }

    if (conflictCount) {
      html += '<div class="panel"><strong>Duplicate barcodes</strong> (same barcode used by more than one distinct variant — scans of these will require manual disambiguation):<ul>';
      Object.keys(state.barcodeConflicts).forEach(function (bc) {
        html += '<li>' + esc(bc) + ' &rarr; ' + state.barcodeConflicts[bc].map(function (r) { return esc(describeRecord(r)); }).join(', ') + '</li>';
      });
      html += '</ul></div>';
    }
    if (dupRowCount) {
      html += '<div class="panel"><strong>Repeated rows in Products file</strong> (exact same SKU + variant appears more than once — likely a duplicate export line):<br>' +
        state.duplicateRowWarnings.map(function (d) { return esc(describeRecord(d)); }).join(', ') + '</div>';
    }
    if (sharedSkuCount) {
      html += '<div class="panel"><strong>SKUs shared across more than one variant</strong> (e.g. King/Cal King using one supplier SKU) — each variant is tracked as its own line using its own barcode, so this is informational only:<ul>';
      state.sharedSkus.forEach(function (s) {
        html += '<li>' + esc(s.sku) + ' &rarr; ' + s.variantLabels.map(esc).join(', ') + '</li>';
      });
      html += '</ul></div>';
    }
    if (notInProductsCount) {
      var missingLines = lines.filter(function (l) { return l.notInProducts; });
      html += '<div class="panel"><strong>SKUs expected at this location but missing from the Products file</strong> (no barcode available — must be counted manually by SKU):<br>' +
        missingLines.map(function (l) { return esc(describeRecord(l)); }).join(', ') + '</div>';
    }

    html += '<div style="text-align:center; margin-top:20px;">';
    html += '<button id="btn-begin" class="primary">Begin counting &rarr;</button> ';
    html += '<button id="btn-back-loc" class="ghost">&larr; Choose a different location</button>';
    html += '</div>';

    root.innerHTML = html;
    document.getElementById('btn-begin').onclick = function () {
      state.screen = 'counting';
      saveState();
      render();
    };
    document.getElementById('btn-back-loc').onclick = function () {
      state.screen = 'location';
      saveState();
      render();
    };
  }

  function statHtml(value, label) {
    return '<div class="stat"><div class="value">' + value + '</div><div class="label">' + esc(label) + '</div></div>';
  }

  var countingTab = 'notcounted';
  var countingSearch = '';

  function renderCounting() {
    var html = '';
    html += '<h1>Counting: ' + esc(state.selectedLocation) + '</h1>';
    html += '<div class="scanner-bar">' +
      '<input type="text" id="scan-input" placeholder="Scan a barcode and press Enter…" autocomplete="off">' +
      '<button id="btn-undo" title="Undo last scan">Undo last scan</button>' +
      '</div>';

    html += '<div id="counting-stats-tabs"></div>';
    html += '<input type="text" class="search-box" id="counting-search" placeholder="Search by SKU, title, or variant…" value="' + esc(countingSearch) + '">';
    html += '<div id="counting-list-wrap"></div>';

    html += '<div class="finish-bar"><button id="btn-finish" class="primary">Finish count &amp; view report &rarr;</button></div>';

    root.innerHTML = html;

    var input = document.getElementById('scan-input');
    input.focus();
    input.onkeydown = function (e) {
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        var v = input.value;
        input.value = '';
        processScan(v);
      }
    };
    document.addEventListener('click', function refocus(e) {
      if (state.screen !== 'counting') { document.removeEventListener('click', refocus); return; }
      if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'BUTTON') input.focus();
    });

    document.getElementById('btn-undo').onclick = undoLastScan;
    document.getElementById('counting-search').oninput = function (e) {
      countingSearch = e.target.value;
      renderCountingLists();
    };
    document.getElementById('btn-finish').onclick = function () {
      var lines = Object.values(state.countLines);
      var remaining = lines.filter(function (l) { return l.counted === 0; }).length;
      var msg = remaining > 0 ?
        (remaining + ' of ' + lines.length + ' expected variants have not been scanned yet — they will show as a full shortage in the report. Finish anyway?') :
        'Finish this count and generate the report?';
      showConfirm(msg, {
        okLabel: 'Finish count',
        onConfirm: function () {
          state.finishedAt = nowStr();
          state.screen = 'report';
          saveState();
          render();
        }
      });
    };

    renderCountingStatsTabs();
    renderCountingLists();
  }

  function tabBtn(id, label) {
    return '<button class="tab-btn' + (countingTab === id ? ' active' : '') + '" data-tab="' + id + '">' + esc(label) + '</button>';
  }

  function renderCountingStatsTabs() {
    var wrap = document.getElementById('counting-stats-tabs');
    if (!wrap) return;

    var lines = Object.values(state.countLines);
    var extras = Object.values(state.extraLines);
    var countedLines = lines.filter(function (l) { return l.counted > 0; });
    var notCountedLines = lines.filter(function (l) { return l.counted === 0; });
    var unknownCount = Object.keys(state.unrecognizedScans).reduce(function (a, k) { return a + state.unrecognizedScans[k]; }, 0);

    var html = '';
    html += '<div class="stats-row">';
    html += statHtml(lines.length, 'Expected variants');
    html += statHtml(countedLines.length, 'Scanned so far');
    html += statHtml(notCountedLines.length, 'Not yet counted');
    html += statHtml(unknownCount, 'Unrecognized scans');
    html += '</div>';

    html += '<div class="tabs">';
    html += tabBtn('notcounted', 'Not yet counted (' + notCountedLines.length + ')');
    html += tabBtn('counted', 'Counted (' + countedLines.length + ')');
    html += tabBtn('all', 'All (' + lines.length + ')');
    html += tabBtn('extra', 'Unexpected finds (' + extras.length + ')');
    html += tabBtn('unknown', 'Unrecognized (' + Object.keys(state.unrecognizedScans).length + ')');
    html += '</div>';

    wrap.innerHTML = html;
    wrap.querySelectorAll('.tab-btn').forEach(function (btn) {
      btn.onclick = function () { countingTab = btn.getAttribute('data-tab'); renderCountingStatsTabs(); renderCountingLists(); };
    });
  }

  function renderCountingLists() {
    var wrap = document.getElementById('counting-list-wrap');
    if (!wrap) return; // not on this screen anymore

    var lines;
    var isExtraTab = countingTab === 'extra';
    var isUnknownTab = countingTab === 'unknown';

    if (isUnknownTab) {
      var keys = Object.keys(state.unrecognizedScans);
      var html = '';
      if (!keys.length) {
        html = '<p class="muted">No unrecognized scans.</p>';
      } else {
        html = '<table><thead><tr><th>Scanned value</th><th class="num">Times scanned</th></tr></thead><tbody>';
        keys.forEach(function (k) {
          html += '<tr><td>' + esc(k) + '</td><td class="num">' + state.unrecognizedScans[k] + '</td></tr>';
        });
        html += '</tbody></table>';
      }
      wrap.innerHTML = html;
      return;
    }

    if (isExtraTab) {
      lines = Object.values(state.extraLines);
    } else if (countingTab === 'counted') {
      lines = Object.values(state.countLines).filter(function (l) { return l.counted > 0; });
    } else if (countingTab === 'notcounted') {
      lines = Object.values(state.countLines).filter(function (l) { return l.counted === 0; });
    } else {
      lines = Object.values(state.countLines);
    }

    if (countingSearch.trim()) {
      var q = countingSearch.trim().toLowerCase();
      lines = lines.filter(function (l) {
        return l.sku.toLowerCase().indexOf(q) !== -1 ||
          l.title.toLowerCase().indexOf(q) !== -1 ||
          (l.variantLabel || '').toLowerCase().indexOf(q) !== -1;
      });
    }

    lines = lines.slice().sort(function (a, b) {
      if (b.lastUpdated !== a.lastUpdated) return b.lastUpdated - a.lastUpdated;
      return a.title.localeCompare(b.title);
    });

    var maxRows = 300;
    var truncated = lines.length > maxRows;
    var shown = lines.slice(0, maxRows);

    var html = '';
    if (!shown.length) {
      html = '<p class="muted">No items in this view.</p>';
    } else {
      html += '<table><thead><tr><th>Title</th><th>Variant</th><th>SKU</th><th class="num">Expected</th><th class="num">Counted</th><th></th></tr></thead><tbody>';
      shown.forEach(function (l) {
        html += '<tr>' +
          '<td>' + esc(l.title) + (l.notInProducts ? ' <span class="muted">(no product match)</span>' : '') + (l.noBarcode && !l.notInProducts ? ' <span class="muted">(no barcode)</span>' : '') + '</td>' +
          '<td>' + esc(l.variantLabel) + '</td>' +
          '<td>' + esc(l.sku) + '</td>' +
          '<td class="num">' + fmtNum(l.expected) + '</td>' +
          '<td class="num">' + fmtNum(l.counted) + '</td>' +
          '<td><div class="qty-controls">' +
          '<button class="iconbtn adj-btn" data-key="' + esc(l.key) + '" data-extra="' + (isExtraTab ? '1' : '0') + '" data-delta="-1">&minus;</button>' +
          '<button class="iconbtn adj-btn" data-key="' + esc(l.key) + '" data-extra="' + (isExtraTab ? '1' : '0') + '" data-delta="1">+</button>' +
          '</div></td>' +
          '</tr>';
      });
      html += '</tbody></table>';
      if (truncated) html += '<p class="muted">Showing first ' + maxRows + ' of ' + lines.length + ' — use search to narrow down.</p>';
    }
    wrap.innerHTML = html;

    wrap.querySelectorAll('.adj-btn').forEach(function (btn) {
      btn.onclick = function () {
        manualAdjust(btn.getAttribute('data-key'), parseInt(btn.getAttribute('data-delta'), 10), btn.getAttribute('data-extra') === '1');
      };
    });
  }

  function renderReport() {
    var rows = buildReportRows();
    var totals = reportTotals(rows);
    var discrepancies = rows.filter(function (r) { return r.diff !== 0; })
      .sort(function (a, b) { return a.costImpact - b.costImpact; });
    var matches = rows.filter(function (r) { return r.diff === 0; })
      .sort(function (a, b) { return a.title.localeCompare(b.title); });
    var unknownKeys = Object.keys(state.unrecognizedScans);

    var html = '';
    html += '<h1>Cycle Count Report — ' + esc(state.selectedLocation) + '</h1>';
    html += '<p class="muted">Started ' + esc(state.startedAt) + ' &middot; Finished ' + esc(state.finishedAt) + '</p>';

    html += '<div class="stats-row">';
    html += statHtml(fmtNum(totals.totalExpected), 'Total expected units');
    html += statHtml(fmtNum(totals.totalCounted), 'Total counted units');
    html += statHtml((totals.netUnitDiff >= 0 ? '+' : '') + totals.netUnitDiff, 'Net unit difference');
    html += statHtml(fmtMoney(totals.netDollars), 'Net dollar variance');
    html += '</div>';
    html += '<div class="stats-row">';
    html += statHtml(fmtMoney(totals.overageDollars), 'Total overage ($)');
    html += statHtml(fmtMoney(-totals.shortageDollars), 'Total shortage ($)');
    html += statHtml(totals.discrepancyCount, 'Variants w/ discrepancy');
    html += statHtml(totals.matchCount, 'Variants matching');
    html += '</div>';

    html += '<div style="text-align:center; margin: 16px 0;">' +
      '<button id="btn-export" class="primary">Export full report (.xlsx)</button> ' +
      '<button id="btn-export-discrepancies">Export discrepancies only (.xlsx)</button> ' +
      '<button id="btn-export-shopify">Export importable inventory changes (.csv)</button> ' +
      '<button id="btn-new-count">Start a new count</button>' +
      '</div>' +
      '<p class="muted" style="text-align:center; margin-top:-8px;">Full report: every counted variant, for your records. Discrepancies only: just the variants that need adjusting — hand this to your inventory manager. Importable inventory changes: same layout as your Inventory export, with "On hand (new)" filled in from this count, ready to re-upload to Shopify.</p>';

    html += '<div class="section-title">Discrepancies (' + discrepancies.length + ')</div>';
    html += reportTable(discrepancies, true);

    html += '<div class="section-title">Matches (' + matches.length + ')</div>';
    html += reportTable(matches, false);

    if (unknownKeys.length) {
      html += '<div class="section-title">Unrecognized scans (' + unknownKeys.length + ')</div>';
      html += '<table><thead><tr><th>Scanned value</th><th class="num">Times scanned</th></tr></thead><tbody>';
      unknownKeys.forEach(function (k) {
        html += '<tr><td>' + esc(k) + '</td><td class="num">' + state.unrecognizedScans[k] + '</td></tr>';
      });
      html += '</tbody></table>';
    }

    root.innerHTML = html;
    document.getElementById('btn-export').onclick = exportExcel;
    document.getElementById('btn-export-discrepancies').onclick = exportDiscrepanciesExcel;
    document.getElementById('btn-export-shopify').onclick = exportShopifyInventoryImport;
    document.getElementById('btn-new-count').onclick = function () {
      showConfirm('Start a brand new count? This clears the current session (export your report first if you need it).', {
        okLabel: 'Start new count', danger: true, onConfirm: resetAll
      });
    };
  }

  function reportTable(rows, flagRows) {
    if (!rows.length) return '<p class="muted">None.</p>';
    var html = '<table><thead><tr><th>Title</th><th>Variant</th><th>SKU</th><th class="num">Expected</th><th class="num">Counted</th><th class="num">Diff</th><th class="num">Cost/Item</th><th class="num">Cost Impact</th><th>Notes</th></tr></thead><tbody>';
    rows.forEach(function (r) {
      var notes = [];
      if (r.notInProducts) notes.push('Not in Products file');
      if (r.noBarcode && !r.notInProducts) notes.push('No barcode');
      if (r.foundUnexpected) notes.push('Found but not expected here');
      if (r.costPerItem === null || r.costPerItem === undefined) notes.push('No cost data');
      var rowClass = (flagRows ? (r.diff > 0 ? 'diff-pos' : 'diff-neg') : '') + (r.notInProducts || r.foundUnexpected ? ' flagged' : '');
      html += '<tr class="' + rowClass + '">' +
        '<td>' + esc(r.title) + '</td>' +
        '<td>' + esc(r.variantLabel) + '</td>' +
        '<td>' + esc(r.sku) + '</td>' +
        '<td class="num">' + fmtNum(r.expected) + '</td>' +
        '<td class="num">' + fmtNum(r.counted) + '</td>' +
        '<td class="num diffcell">' + (r.diff > 0 ? '+' : '') + r.diff + '</td>' +
        '<td class="num">' + (r.costPerItem === null ? '—' : fmtMoney(r.costPerItem)) + '</td>' +
        '<td class="num diffcell">' + fmtMoney(r.costImpact) + '</td>' +
        '<td class="muted">' + esc(notes.join('; ')) + '</td>' +
        '</tr>';
    });
    html += '</tbody></table>';
    return html;
  }

  render();
})();
