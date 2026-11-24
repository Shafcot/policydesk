// Applies the saved light/dark choice before the app draws (no flash). Light is the default.
// Also carries settings saved under the app's earlier storage names over to the current ones (keeps people signed in).
try {
  [['pd-theme', 'bliss-erp.theme'], ['policydesk.token', 'bliss-erp.token']].forEach(function (p) {
    var old = localStorage.getItem(p[0]);
    if (old !== null) { if (localStorage.getItem(p[1]) === null) localStorage.setItem(p[1], old); localStorage.removeItem(p[0]); }
  });
  if (localStorage.getItem('bliss-erp.theme') === 'dark') document.documentElement.dataset.theme = 'dark';
} catch (e) { /* storage blocked */ }
