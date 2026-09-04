fetch('data/stats.json?v=20260903-route-rework-5')
  .then((response) => {
    if (!response.ok) throw new Error('missing');
    return response.json();
  })
  .then((stats) => {
    document.getElementById('cov').textContent =
      stats.companies.toLocaleString() + ' companies · ' +
      stats.numbers.toLocaleString() + ' phone numbers · ' +
      stats.contactChannels.toLocaleString() + ' researched online contact routes · ' +
      stats.withSteps.toLocaleString() + ' mapped menus · ' +
      stats.verified.toLocaleString() + ' confirmed by two or more steps · ' +
      stats.sources + ' sources';
    document.getElementById('built').textContent = stats.built;
  })
  .catch(() => {});
