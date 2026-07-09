(() => {
  const items = Array.from(document.querySelectorAll('.grid-item'));
  return items
    .map((item) => {
      const nameEl = item.querySelector('.product-header');
      const imgEl = item.querySelector('img.grid-image') || item.querySelector('img');
      const linkEl = item.querySelector('a[href]');
      const href = linkEl ? linkEl.getAttribute('href') : null;
      return {
        name: nameEl ? nameEl.textContent.trim() : null,
        imageUrl: imgEl ? imgEl.getAttribute('src') : null,
        productUrl: href ? new URL(href, window.location.origin).href : null,
      };
    })
    .filter((p) => p.imageUrl);
})()