document.documentElement.lang = window.currentLang;
document.querySelectorAll('[data-i18n]').forEach(element => {
  element.textContent = window.t(element.dataset.i18n);
});
