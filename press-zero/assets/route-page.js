(function () {
  const page = document.getElementById('page');
  const slug = new URLSearchParams(location.search).get('c') || '';
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(slug)) return HP.notFound(page, 'No company picked');

  const canonical = document.createElement('link');
  canonical.rel = 'canonical';
  canonical.href = 'https://humanplease.wiki/company/' + encodeURIComponent(slug) + '/';
  document.head.appendChild(canonical);

  const shard = /^[a-z]/.test(slug) ? slug[0] : '_';
  fetch('data/r/' + shard + '.json?v=20260903-route-rework-5')
    .then((response) => {
      if (!response.ok) throw new Error('missing');
      return response.json();
    })
    .then((data) => {
      const company = data[slug] || data[slug + '-ca'] || data[slug + '-us'] ||
        Object.values(data).find((item) => item.baseSlug === slug);
      if (!company) throw new Error('missing');
      HP.mountRoute(page, company);
    })
    .catch(() => HP.notFound(page, 'Not on file'));
})();
