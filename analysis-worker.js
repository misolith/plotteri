// Web Worker kalapaikka-analyysin laskentaan, jotta karttasaie ei tahmaa.
import { buildAnalysis } from './analysis.js';

self.onmessage = function (e) {
  var msg = e.data || {};
  var result = null;
  try {
    result = buildAnalysis(msg.input);
  } catch (err) {
    self.postMessage({ id: msg.id, error: String(err && err.message || err) });
    return;
  }
  var transfer = [];
  if (result) {
    ['depth', 'mask', 'slope', 'windExp', 'score'].forEach(function (key) {
      if (result[key] && result[key].buffer) transfer.push(result[key].buffer);
    });
  }
  self.postMessage({ id: msg.id, result: result }, transfer);
};
