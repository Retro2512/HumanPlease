Promise.all([
  fetch('data/index.json?v=20260903-route-rework-5').then((response) => response.json()),
  fetch('data/stats.json?v=20260903-route-rework-5').then((response) => response.json()),
])
  .then(([index, stats]) => HP.mountSearch({
    index,
    stats,
    href: (slug) => 'company/' + encodeURIComponent(slug) + '/',
  }))
  .catch(() => {
    const results = document.getElementById('results');
    if (results) results.textContent = 'The route index did not load. Reload the page.';
  });
