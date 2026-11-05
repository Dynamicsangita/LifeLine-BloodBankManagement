document.addEventListener('DOMContentLoaded', () => {
  const navToggle = document.querySelector('.nav-toggle');
  const navContent = document.querySelector('.nav-content');
  navToggle?.addEventListener('click', () => {
    const expanded = navToggle.getAttribute('aria-expanded') === 'true';
    navToggle.setAttribute('aria-expanded', String(!expanded));
    navContent?.classList.toggle('open', !expanded);
  });

  const urgency = document.querySelector('select[name="urgency"]');
  const requestForm = urgency?.closest('form');
  requestForm?.addEventListener('submit', (event) => {
    if (urgency.value === 'Emergency' && !window.confirm('Submit this request marked EMERGENCY? For urgent medical care, contact the hospital/blood bank directly too.')) {
      event.preventDefault();
    }
  });

  document.querySelectorAll('form[data-confirm]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      if (!window.confirm(form.dataset.confirm)) event.preventDefault();
    });
  });

  const bloodGroupGrid = document.querySelector('.how-blood-grid');
  const bloodGroupModal = document.querySelector('.how-blood-modal');
  const bloodGroupDialog = bloodGroupModal?.querySelector('.how-blood-dialog');
  const bloodGroupTitle = bloodGroupModal?.querySelector('#how-blood-dialog-title');
  const bloodGroupExplanation = bloodGroupModal?.querySelector('#how-blood-dialog-explanation');
  const compatibleGroupList = bloodGroupModal?.querySelector('.how-blood-compatible-list');
  const bloodGroupClose = bloodGroupModal?.querySelector('.how-blood-close');
  let selectedBloodGroup = '';
  let previouslyFocusedCard = null;

  const groupExplanations = {
    'A+': 'A positive red blood cells carry the A antigen and the Rh(D) antigen.',
    'A-': 'A negative red blood cells carry the A antigen and do not carry the Rh(D) antigen.',
    'B+': 'B positive red blood cells carry the B antigen and the Rh(D) antigen.',
    'B-': 'B negative red blood cells carry the B antigen and do not carry the Rh(D) antigen.',
    'AB+': 'AB positive red blood cells carry A, B, and Rh(D) antigens.',
    'AB-': 'AB negative red blood cells carry A and B antigens and do not carry the Rh(D) antigen.',
    'O+': 'O positive red blood cells do not carry A or B antigens and carry the Rh(D) antigen.',
    'O-': 'O negative red blood cells do not carry A, B, or Rh(D) antigens.',
  };

  const closeBloodGroupModal = () => {
    if (!bloodGroupModal || bloodGroupModal.hidden) return;
    bloodGroupModal.hidden = true;
    bloodGroupModal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('how-blood-modal-open');
    previouslyFocusedCard?.focus();
    previouslyFocusedCard = null;
  };

  bloodGroupGrid?.addEventListener('click', (event) => {
    const card = event.target.closest('.how-blood-card');
    if (!card || !bloodGroupModal || !bloodGroupDialog || !bloodGroupTitle
        || !bloodGroupExplanation || !compatibleGroupList) return;

    selectedBloodGroup = card.dataset.bloodGroup || '';
    if (!groupExplanations[selectedBloodGroup]) return;

    bloodGroupGrid.querySelectorAll('.how-blood-card').forEach((item) => {
      const selected = item === card;
      item.classList.toggle('is-selected', selected);
      item.setAttribute('aria-pressed', String(selected));
    });

    previouslyFocusedCard = card;
    bloodGroupTitle.textContent = `${selectedBloodGroup} blood group`;
    bloodGroupExplanation.textContent = groupExplanations[selectedBloodGroup];
    compatibleGroupList.replaceChildren();
    (card.dataset.compatibleGroups || '').split('|').filter(Boolean).forEach((group) => {
      const badge = document.createElement('span');
      badge.className = 'how-blood-compatible';
      badge.textContent = group;
      compatibleGroupList.append(badge);
    });
    bloodGroupModal.hidden = false;
    bloodGroupModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('how-blood-modal-open');
    bloodGroupDialog.focus();
  });

  bloodGroupClose?.addEventListener('click', closeBloodGroupModal);
  bloodGroupModal?.addEventListener('click', (event) => {
    if (event.target === bloodGroupModal) closeBloodGroupModal();
  });
  bloodGroupModal?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeBloodGroupModal();
      return;
    }
    if (event.key !== 'Tab' || !bloodGroupDialog) return;
    const focusable = [...bloodGroupDialog.querySelectorAll('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) {
      event.preventDefault();
      bloodGroupDialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  const heroPhoto = document.querySelector('.hero-photo');
  heroPhoto?.addEventListener('error', () => {
    heroPhoto.hidden = true;
    heroPhoto.closest('.hero-art')?.classList.add('hero-art-fallback');
  }, { once: true });

  document.querySelectorAll('img:not(.hero-photo)').forEach((image) => {
    const showFallback = () => {
      image.hidden = true;
      image.closest('.about-photo,.auth-illustration,.donor-art-panel,.request-gate-art,.find-donors-heading,.emergency-photo,.bank-hero-art,.contact-art,.how-details-art,.dashboard-photo,.admin-page-heading')
        ?.classList.add('image-fallback');
    };
    if (image.complete && image.naturalWidth === 0) showFallback();
    else image.addEventListener('error', showFallback, { once: true });
  });

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const counters = document.querySelectorAll('[data-counter]');
  const formatCount = (value) => new Intl.NumberFormat().format(value);
  const animateCounter = (element) => {
    const target = Number(element.dataset.counter);
    if (!Number.isSafeInteger(target) || target < 0) return;
    if (reduceMotion || target === 0) {
      element.textContent = formatCount(target);
      return;
    }

    const startTime = performance.now();
    const duration = 850;
    const update = (now) => {
      const progress = Math.min((now - startTime) / duration, 1);
      const eased = 1 - ((1 - progress) ** 3);
      element.textContent = formatCount(Math.round(target * eased));
      if (progress < 1) requestAnimationFrame(update);
    };
    requestAnimationFrame(update);
  };

  if ('IntersectionObserver' in window && !reduceMotion) {
    document.documentElement.classList.add('has-motion');
    const revealObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.12 });
    document.querySelectorAll('.reveal').forEach((element) => revealObserver.observe(element));

    const counterObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        animateCounter(entry.target);
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.5 });
    counters.forEach((element) => counterObserver.observe(element));
  } else {
    counters.forEach(animateCounter);
  }

  document.querySelectorAll('form:not([data-no-loading])').forEach((form) => {
    form.addEventListener('submit', (event) => {
      if (event.defaultPrevented) return;
      const submitButton = event.submitter || form.querySelector('button[type="submit"], button:not([type])');
      if (!submitButton || submitButton.disabled) return;
      const loadingLabel = form.dataset.loadingText
        ? submitButton.querySelector('[data-loading-label]')
        : null;
      if (loadingLabel) loadingLabel.textContent = form.dataset.loadingText;
      submitButton.disabled = true;
      submitButton.setAttribute('aria-busy', 'true');
      submitButton.classList.add('is-loading');
    });
  });
});
