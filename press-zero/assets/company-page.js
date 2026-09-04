(function () {
  const page = document.getElementById('page');
  const parts = location.pathname.split('/').filter(Boolean);
  const companyAt = parts.lastIndexOf('company');
  const slug = companyAt >= 0 ? decodeURIComponent(parts[companyAt + 1] || '') : '';
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(slug)) return HP.notFound(page, 'Not on file');

  HP.assetBase = '../../assets/';
  const shard = /^[a-z]/.test(slug) ? slug[0] : '_';
  fetch('../../data/r/' + shard + '.json?v=20260903-route-rework-5')
    .then((response) => {
      if (!response.ok) throw new Error('missing');
      return response.json();
    })
    .then((data) => {
      if (!data[slug]) throw new Error('missing');
      HP.mountRoute(page, data[slug]);
    })
    .catch(() => HP.notFound(page, 'Not on file'));
})();
