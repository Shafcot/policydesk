// Import bridge: lets an admin move leads into Bliss from another web app open in the same browser
// (e.g. a migration script running on the old CRM's page). The other window posts rows here; this page
// sends them to /api/leads/import with the admin's own Bliss sign-in, so no Bliss credential ever leaves Bliss.
// Nothing is accepted until the admin clicks "Allow" for that exact website.
(function () {
  var TOKEN_KEY = 'bliss-erp.token', OLD_TOKEN_KEY = 'policydesk.token';
  var allowed = null, pending = null, totals = { batches: 0, imported: 0, duplicates: 0, skipped: 0, failed: 0 };
  var $ = function (id) { return document.getElementById(id); };
  var token = function () { try { return localStorage.getItem(TOKEN_KEY) || localStorage.getItem(OLD_TOKEN_KEY); } catch (e) { return null; } };
  function render() {
    $('who').textContent = token() ? 'Signed in to Bliss.' : 'Not signed in. Sign in to Bliss in another tab, then reload this page.';
    $('ask').hidden = !(pending && !allowed);
    if (pending) $('origin').textContent = pending;
    $('stats').textContent = allowed
      ? 'Receiving from ' + allowed + ': ' + totals.batches + ' batches · ' + totals.imported + ' imported · ' + totals.duplicates + ' duplicates skipped · ' + totals.skipped + ' rows without name/phone' + (totals.failed ? ' · ' + totals.failed + ' batches failed' : '')
      : 'Waiting for the other window…';
  }
  $('allow').addEventListener('click', function () { allowed = pending; render(); });
  $('deny').addEventListener('click', function () { pending = null; render(); });
  window.addEventListener('message', function (ev) {
    var d = ev.data || {};
    if (d.type !== 'bliss-import' && d.type !== 'bliss-import-hello' && d.type !== 'bliss-restore') return;
    var reply = function (res) { ev.source && ev.source.postMessage({ type: 'bliss-import-result', seq: d.seq, res: res }, ev.origin); };
    if (ev.origin !== allowed) { if (!allowed) { pending = ev.origin; render(); } return reply({ ok: false, error: 'not-allowed' }); }
    if (d.type === 'bliss-import-hello') return reply({ ok: true, ready: !!token() });
    // Full restore into a fresh install (moving servers): uses the one-time restore key, not a sign-in.
    if (d.type === 'bliss-restore') {
      var url = d.table === 'begin' ? '/api/restore/begin' : '/api/restore/' + encodeURIComponent(d.table);
      var tryRestore = function (n) {
        fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-restore-key': String(d.key || '') }, body: JSON.stringify({ rows: d.rows || [] }) })
          .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { r: r, b: b }; }); })
          .then(function (x) {
            if (x.r.ok) { if (d.table !== 'begin') { totals.batches++; totals.imported += x.b.inserted || 0; render(); } return reply({ ok: true, inserted: x.b.inserted || 0 }); }
            if (x.r.status >= 500 && n < 3) return setTimeout(function () { tryRestore(n + 1); }, 3000 * n);
            totals.failed++; render(); reply({ ok: false, status: x.r.status, error: x.b.error || 'failed' });
          })
          .catch(function (e) { if (n < 3) return setTimeout(function () { tryRestore(n + 1); }, 3000 * n); totals.failed++; render(); reply({ ok: false, error: String(e) }); });
      };
      return tryRestore(1);
    }
    if (!token()) return reply({ ok: false, error: 'not-signed-in' });
    var attempt = function (n) {
      fetch('/api/leads/import', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token() },
        body: JSON.stringify({ rows: d.rows, defaultSource: d.defaultSource || 'Previous CRM', autoAssign: !!d.autoAssign, runAutomations: false, allowNoPhone: !!d.allowNoPhone }) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { r: r, b: b }; }); })
        .then(function (x) {
          if (x.r.ok) { totals.batches++; totals.imported += x.b.imported; totals.duplicates += x.b.duplicates; totals.skipped += x.b.skipped.length; render(); return reply({ ok: true, imported: x.b.imported, duplicates: x.b.duplicates, skipped: x.b.skipped.length }); }
          if (x.r.status >= 500 && n < 3) return setTimeout(function () { attempt(n + 1); }, 3000 * n);
          totals.failed++; render(); reply({ ok: false, status: x.r.status, error: x.b.error || 'failed' });
        })
        .catch(function (e) { if (n < 3) return setTimeout(function () { attempt(n + 1); }, 3000 * n); totals.failed++; render(); reply({ ok: false, error: String(e) }); });
    };
    attempt(1);
  });
  render();
})();
