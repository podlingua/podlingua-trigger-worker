const navToggle = document.getElementById('navToggle');
const nav = document.getElementById('nav');
const header = document.getElementById('header');

navToggle?.addEventListener('click', () => {
  const isOpen = nav.classList.toggle('open');
  navToggle.classList.toggle('open', isOpen);
  navToggle.setAttribute('aria-expanded', String(isOpen));
});

document.querySelectorAll('.nav__item--dropdown > a').forEach(link => {
  link.addEventListener('click', e => {
    if (window.innerWidth > 768) return;
    e.preventDefault();
    link.parentElement.classList.toggle('open');
  });
});

document.addEventListener('click', e => {
  if (!header?.contains(e.target) && nav?.classList.contains('open')) {
    nav.classList.remove('open');
    navToggle?.classList.remove('open');
    navToggle?.setAttribute('aria-expanded', 'false');
  }
});

window.addEventListener('scroll', () => {
  header?.classList.toggle('header--scrolled', window.scrollY > 10);
}, { passive: true });

document.querySelectorAll('.play-btn, .play-btn-lg').forEach(btn => {
  btn.addEventListener('click', () => {
    btn.textContent = '⏸';
    setTimeout(() => { btn.textContent = '▶'; }, 2000);
  });
});