const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
const runningAnimations = new Set();
const entranceSeen = new WeakSet();
const entranceDelay = new WeakMap();
const curve = 'cubic-bezier(0.22,1,0.36,1)';

function animate(element, keyframes, options = {}) {
  if (!element || motionPreference.matches || window.matchMedia('print').matches || !element.animate) return;
  const animation = element.animate(keyframes, {duration:700, easing:curve, ...options});
  runningAnimations.add(animation);
  animation.finished.then(() => runningAnimations.delete(animation), () => runningAnimations.delete(animation));
  return animation;
}
function enter(element, delay = 0) {
  if (entranceSeen.has(element)) return;
  entranceSeen.add(element);
  animate(element, [{opacity:0, transform:'translateY(24px)'}, {opacity:1, transform:'none'}], {delay, fill:'backwards'});
}
function stopMotion() {
  runningAnimations.forEach(animation => animation.cancel());
  document.querySelectorAll('.is-pointed').forEach(card => card.classList.remove('is-pointed'));
}
document.querySelectorAll('[data-print]').forEach(button => button.addEventListener('click', () => {stopMotion(); window.print();}));
window.addEventListener('beforeprint', stopMotion);
motionPreference.addEventListener('change', event => { if (event.matches) stopMotion(); });

const filters = document.querySelectorAll('[data-filter]');
const cards = document.querySelectorAll('[data-category]');
filters.forEach(button => {
  button.addEventListener('click', () => {
    filters.forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    let count = 0;
    cards.forEach(card => {
      card.hidden = button.dataset.filter !== 'all' && card.dataset.category !== button.dataset.filter;
      if (!card.hidden) { enter(card, Math.min(count * 65, 195)); count++; }
    });
    document.getElementById('filter-status').textContent = `Показано разделов: ${count}`;
    scheduleNavigation();
  });
});

const links = [...document.querySelectorAll('.nav-links a')];
const sections = links.map(link => document.querySelector(link.getAttribute('href')));
const progress = document.querySelector('.reading-progress');
let navigationFrame = 0;
function updateNavigation() {
  navigationFrame = 0;
  const trigger = Math.min(window.innerHeight * .35, 300);
  let active = -1;
  sections.forEach((section, index) => { if (section && section.getBoundingClientRect().top <= trigger) active = index; });
  links.forEach((link, index) => {
    if (index === active) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  });
  const distance = document.documentElement.scrollHeight - window.innerHeight;
  if (progress) progress.style.transform = `scaleX(${distance > 0 ? Math.min(1, Math.max(0, window.scrollY / distance)) : 0})`;
}
function scheduleNavigation() { if (!navigationFrame) navigationFrame = requestAnimationFrame(updateNavigation); }
window.addEventListener('scroll', scheduleNavigation, {passive:true});
window.addEventListener('resize', scheduleNavigation, {passive:true});
if ('ResizeObserver' in window) new ResizeObserver(scheduleNavigation).observe(document.querySelector('main'));
scheduleNavigation();

// Static HTML is always the fallback; nothing is hidden before the observer runs.
const entrances = document.querySelectorAll('.section-heading, .capabilities article, .job, .stack-card, .leadership-list li, .contact-links > *');
document.querySelectorAll('.capabilities, .experience-list, .stack-grid, .leadership-list, .contact-links').forEach(group => {
  [...group.children].forEach((child, index) => entranceDelay.set(child, (index % (group.classList.contains('capabilities') ? 3 : 2)) * 80));
});
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      enter(entry.target, entranceDelay.get(entry.target) || 0);
      observer.unobserve(entry.target);
    });
  }, {threshold:.08, rootMargin:'0px 0px 48px 0px'});
  entrances.forEach(element => observer.observe(element));
}

document.querySelectorAll('.capabilities article, .job, .stack-card, .contact-links > *, .profile-card').forEach(card => {
  card.classList.add('interactive-surface');
  let pointerFrame = 0;
  let x = 0;
  let y = 0;
  card.addEventListener('pointermove', event => {
    if (!finePointer.matches || motionPreference.matches || event.pointerType === 'touch') return;
    x = event.clientX;
    y = event.clientY;
    if (pointerFrame) return;
    pointerFrame = requestAnimationFrame(() => {
      pointerFrame = 0;
      const bounds = card.getBoundingClientRect();
      const localX = x - bounds.left;
      const localY = y - bounds.top;
      card.style.setProperty('--spot-x', `${localX}px`);
      card.style.setProperty('--spot-y', `${localY}px`);
      if (card.classList.contains('profile-card')) {
        card.style.setProperty('--tilt-x', `${-(localY / bounds.height - .5) * 3}deg`);
        card.style.setProperty('--tilt-y', `${(localX / bounds.width - .5) * 3}deg`);
      }
      card.classList.add('is-pointed');
    });
  });
  card.addEventListener('pointerleave', () => {
    cancelAnimationFrame(pointerFrame);
    pointerFrame = 0;
    card.classList.remove('is-pointed');
    card.style.removeProperty('--tilt-x');
    card.style.removeProperty('--tilt-y');
  });
});

// A single entrance sequence under two seconds; no repeating motion loop.
document.querySelectorAll('.name-word').forEach((word, index) => {
  animate(word, [{transform:'translateY(110%)', opacity:0}, {transform:'translateY(0)', opacity:1}], {duration:1000, delay:100 + index * 100, fill:'backwards'});
});
animate(document.querySelector('.hero .eyebrow'), [{opacity:0, transform:'translateY(12px)'}, {opacity:1, transform:'none'}], {duration:600, fill:'backwards'});
document.querySelectorAll('.full-name, .hero .role, .hero .intro, .hero .button').forEach((element, index) => {
  animate(element, [{opacity:0, transform:'translateY(16px)'}, {opacity:1, transform:'none'}], {delay:250 + index * 70, fill:'backwards'});
});
animate(document.querySelector('.profile-card'), [{opacity:0, transform:'translateY(24px) scale(.98)'}, {opacity:1, transform:'none'}], {duration:1000, delay:180, fill:'backwards'});
animate(document.querySelector('.orbital-art'), [{transform:'rotate(-24deg) scale(.86)', opacity:0}, {transform:'rotate(0deg) scale(1)', opacity:.14}], {duration:1800, delay:200, fill:'backwards'});
