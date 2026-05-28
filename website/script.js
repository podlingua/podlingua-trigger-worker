// Mobile nav toggle
const navToggle = document.getElementById('navToggle');
const nav = document.getElementById('nav');

navToggle?.addEventListener('click', () => {
  const isOpen = nav.classList.toggle('open');
  navToggle.classList.toggle('open', isOpen);
  navToggle.setAttribute('aria-expanded', isOpen);
});

// Mobile dropdown toggles
document.querySelectorAll('.nav__item--dropdown > a').forEach(link => {
  link.addEventListener('click', e => {
    if (window.innerWidth > 768) return;
    e.preventDefault();
    const parent = link.parentElement;
    parent.classList.toggle('open');
  });
});

// Sticky header shadow on scroll
const header = document.getElementById('header');
window.addEventListener('scroll', () => {
  header?.classList.toggle('header--scrolled', window.scrollY > 10);
}, { passive: true });

// Close nav on outside click
document.addEventListener('click', e => {
  if (!header?.contains(e.target) && nav?.classList.contains('open')) {
    nav.classList.remove('open');
    navToggle?.classList.remove('open');
    navToggle?.setAttribute('aria-expanded', 'false');
  }
});
