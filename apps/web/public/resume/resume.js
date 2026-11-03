document.querySelectorAll('[data-print]').forEach(button => {
  button.addEventListener('click', () => window.print());
});

const filters = document.querySelectorAll('[data-filter]');
const cards = document.querySelectorAll('[data-category]');
filters.forEach(button => {
  button.addEventListener('click', () => {
    filters.forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    let count = 0;
    cards.forEach(card => {
      card.hidden = button.dataset.filter !== 'all' && card.dataset.category !== button.dataset.filter;
      if (!card.hidden) count++;
    });
    document.getElementById('filter-status').textContent = `Показано разделов: ${count}`;
  });
});

// The complete resume remains readable without JavaScript or animation support.
if ('IntersectionObserver' in window) {
  const links = document.querySelectorAll('.nav-links a');
  const sections = [...links].map(link => document.querySelector(link.getAttribute('href')));
  const navigationObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      links.forEach(link => {
        if (link.getAttribute('href') === `#${entry.target.id}`) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      });
    });
  }, {rootMargin: '-15% 0px -55% 0px'});
  sections.forEach(section => { if (section) navigationObserver.observe(section); });

}
