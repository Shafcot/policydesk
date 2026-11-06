// Applies the saved light/dark choice before the app draws (no flash). Light is the default.
try { if (localStorage.getItem('pd-theme') === 'dark') document.documentElement.dataset.theme = 'dark'; } catch (e) { /* storage blocked */ }
