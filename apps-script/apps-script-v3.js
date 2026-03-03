function doGet(e) {
  var SHEET_ID = '1_t0l_nl-LDBQP_hqh1Y6qbnASHwg2lDLinA942aSqkY';
  var OVERVIEW_TAB = 'Vehicles Overview';
  var VEHICLES_TAB = 'Vehicles';
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);

    // --- Read summary data from "Vehicles Overview" tab ---
    var sheet = ss.getSheetByName(OVERVIEW_TAB);
    var data = sheet.getDataRange().getValues();
    var labelMap = {};
    for (var i = 5; i < data.length; i++) {
      var label = String(data[i][0] || '').toLowerCase().trim();
      if (label) { labelMap[label] = i; }
    }
    var checkoutRow = findLabelRow_(labelMap, ['checkout progress', 'checkout %']);
    var statusRow = findLabelRow_(labelMap, ['status']);
    var bmsRow = findLabelRow_(labelMap, ['bms']);
    var inverterRow = findLabelRow_(labelMap, ['inverter']);
    var pmuRow = findLabelRow_(labelMap, ['pmu']);
    var raptorRow = findLabelRow_(labelMap, ['raptor']);
    var functionalRow = findLabelRow_(labelMap, ['functional']);

    // --- Read punchlist data from "Vehicles" tab ---
    var vSheet = ss.getSheetByName(VEHICLES_TAB);
    var vData = vSheet.getDataRange().getValues();
    var vLabelMap = {};
    for (var i = 5; i < vData.length; i++) {
      var vLabel = String(vData[i][0] || '').toLowerCase().trim();
      if (vLabel) { vLabelMap[vLabel] = i; }
    }
    var punchlistRow = findLabelRow_(vLabelMap, ['punchlist', 'punch list']);
    var punchlistData = {};
    if (punchlistRow >= 0) {
      punchlistData = getPunchlistData_(vSheet, vData, punchlistRow);
    }

    // --- Map vehicle columns between tabs ---
    // Build owner lookup from Vehicles tab row 0 for punchlist matching
    var vOwnerMap = {};
    for (var col = 1; col < vData[0].length; col++) {
      var vOwner = String(vData[0][col] || '').trim();
      if (vOwner) { vOwnerMap[vOwner] = col; }
    }

    // --- Build vehicle list from Overview tab ---
    var vehicles = [];
    var maxCols = data[0].length;
    for (var col = 1; col < maxCols; col++) {
      var owner = String(data[0][col] || '').trim();
      if (!owner) { continue; }
      // Look up punchlist by owner name match to Vehicles tab column
      var vCol = vOwnerMap[owner];
      var pl = (vCol !== undefined && punchlistData[vCol]) ? punchlistData[vCol] : { total: 0, done: 0, open: 0, items: [] };
      vehicles.push({
        owner: owner,
        year: data[1][col] ? parseInt(data[1][col]) || null : null,
        color: String(data[2][col] || '').trim(),
        make: String(data[3][col] || '').trim(),
        model: String(data[4][col] || '').trim(),
        status: statusRow >= 0 ? String(data[statusRow][col] || '').trim() : '',
        checkout: getNum_(data, checkoutRow, col),
        bms: getNum_(data, bmsRow, col),
        inverter: getNum_(data, inverterRow, col),
        pmu: getNum_(data, pmuRow, col),
        raptor: getNum_(data, raptorRow, col),
        functional: getNum_(data, functionalRow, col),
        punchlist: pl
      });
    }
    var result = { vehicles: vehicles, updated: new Date().toISOString(), source: 'live' };
    return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    var errorResult = { error: err.message, stack: err.stack, updated: new Date().toISOString() };
    return ContentService.createTextOutput(JSON.stringify(errorResult)).setMimeType(ContentService.MimeType.JSON);
  }
}

function getPunchlistData_(sheet, data, punchlistRow) {
  var itemRows = [];
  for (var i = punchlistRow + 1; i < data.length; i++) {
    var label = String(data[i][0] || '').toLowerCase().trim();
    if (label.indexOf('item') === 0) {
      itemRows.push(i);
    } else if (label && label.indexOf('item') !== 0) {
      break;
    }
  }
  if (itemRows.length === 0) { return {}; }

  var maxCols = data[0].length;
  var startRow = itemRows[0] + 1; // 1-indexed for getRange
  var numRows = itemRows[itemRows.length - 1] - itemRows[0] + 1;
  var richRange = sheet.getRange(startRow, 2, numRows, maxCols - 1);
  var richValues = richRange.getRichTextValues();

  var result = {};
  for (var col = 1; col < maxCols; col++) {
    var total = 0;
    var done = 0;
    var items = [];
    for (var r = 0; r < itemRows.length; r++) {
      var rowOffset = itemRows[r] - itemRows[0];
      var cellText = String(data[itemRows[r]][col] || '').trim();
      if (!cellText) { continue; }
      total++;
      var richText = richValues[rowOffset][col - 1];
      var isStruck = false;
      if (richText) {
        var runs = richText.getRuns();
        if (runs.length > 0) {
          isStruck = true;
          for (var s = 0; s < runs.length; s++) {
            if (!runs[s].getTextStyle().isStrikethrough()) {
              isStruck = false;
              break;
            }
          }
        }
      }
      if (isStruck) { done++; }
      items.push({ text: cellText, done: isStruck });
    }
    result[col] = { total: total, done: done, open: total - done, items: items };
  }
  return result;
}

function findLabelRow_(labelMap, keywords) {
  for (var k = 0; k < keywords.length; k++) {
    for (var key in labelMap) {
      if (key.indexOf(keywords[k].toLowerCase()) !== -1) { return labelMap[key]; }
    }
  }
  return -1;
}

function getNum_(data, rowIdx, col) {
  if (rowIdx < 0 || !data[rowIdx]) { return 0; }
  var v = data[rowIdx][col];
  if (v === '' || v === null || v === undefined) { return 0; }
  var n = parseFloat(v);
  if (isNaN(n)) { return 0; }
  if (n > 0 && n <= 1) { return Math.round(n * 1000) / 10; }
  return Math.round(n * 10) / 10;
}
