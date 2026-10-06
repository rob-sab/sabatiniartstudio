/* sabatiniartstudio — menu, smooth scrolling and active section */
(function () {
  'use strict';

  var menu = document.querySelector('.sas-menu');
  if (!menu) return;

  var toggle = menu.querySelector('.sas-menu__toggle');
  var links = Array.prototype.slice.call(menu.querySelectorAll('.sas-menu__link'));
  var sections = Array.prototype.slice.call(document.querySelectorAll('.sas-section'));
  var hero = document.querySelector('.sas-hero');
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var mobile = window.matchMedia('(max-width: 899px)');
  var ticking = false;
  var activeId = null;
  var onLight = false;

  function linkFor(id) {
    for (var i = 0; i < links.length; i++) {
      if (links[i].getAttribute('href') === '#' + id) return links[i];
    }
    return null;
  }

  /* Over the light ground the menu inverts. The switch is a hard cut: transitions are off
     for the one frame in which the class changes. */
  function setOnLight(on) {
    if (on === onLight) return;
    onLight = on;
    menu.classList.add('is-instant');
    menu.classList.toggle('is-on-light', on);
    void menu.offsetWidth;            // apply the new colours before transitions come back
    menu.classList.remove('is-instant');
  }

  /* The active section is the last one whose top has passed the middle of the viewport, or
     the one starting at the top of the window, as after a menu click: a section shorter than
     half the window (Signs on a phone) would otherwise hand over to the next one at once.
     The menu takes the colour of the section under its own vertical centre (the MENU button
     on mobile). */
  function update() {
    ticking = false;
    var middle = window.innerHeight / 2;
    var current = sections[0];
    var probe = (mobile.matches && toggle ? toggle : menu).getBoundingClientRect();
    var probeY = (probe.top + probe.bottom) / 2;
    var under = null;
    var atTop = null;

    for (var i = 0; i < sections.length; i++) {
      var r = sections[i].getBoundingClientRect();
      if (r.top <= middle) current = sections[i];
      if (Math.abs(r.top) < 2) atTop = sections[i];
      if (r.top <= probeY && r.bottom > probeY) under = sections[i];
    }
    if (atTop) current = atTop;

    setOnLight(!!under && under.classList.contains('sas-light'));

    if (current.id !== activeId) {
      activeId = current.id;
      links.forEach(function (link) {
        var on = link.getAttribute('href') === '#' + activeId;
        link.classList.toggle('is-active', on);
        if (on) link.setAttribute('aria-current', 'true');
        else link.removeAttribute('aria-current');
      });
    }

    menu.classList.toggle('is-visible', current !== hero);
  }

  function requestUpdate() {
    if (!ticking) {
      ticking = true;
      window.requestAnimationFrame(update);
    }
  }

  function scrollToId(id) {
    var target = document.getElementById(id);
    if (!target) return;
    target.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'start' });
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', '#' + id);
    }
  }

  /* Mobile menu */

  function setOpen(open) {
    if (!toggle) return;
    menu.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.querySelector('.sas-menu__toggle-label').textContent = open ? 'CLOSE' : 'MENU';
    document.documentElement.style.overflow = open ? 'hidden' : '';
    if (open) {
      var first = linkFor(activeId) || links[0];
      if (first) first.focus();
    }
  }

  function isOpen() {
    return menu.classList.contains('is-open');
  }

  if (toggle) {
    toggle.addEventListener('click', function () {
      setOpen(!isOpen());
    });
  }

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && isOpen()) {
      setOpen(false);
      toggle.focus();
    }
  });

  /* Menu links and any other in-page link to a section scroll smoothly */

  document.addEventListener('click', function (event) {
    var link = event.target.closest && event.target.closest('a[href^="#sas-"]');
    if (!link) return;
    var id = link.getAttribute('href').slice(1);
    if (!document.getElementById(id)) return;
    event.preventDefault();
    if (isOpen()) setOpen(false);
    scrollToId(id);
  });

  /* Leaving the mobile layout with the menu open should not leave the page locked */

  var onBreakpoint = function () {
    if (!mobile.matches && isOpen()) setOpen(false);
  };
  if (mobile.addEventListener) mobile.addEventListener('change', onBreakpoint);
  else if (mobile.addListener) mobile.addListener(onBreakpoint);

  window.addEventListener('scroll', requestUpdate, { passive: true });
  window.addEventListener('resize', requestUpdate);
  update();
})();
