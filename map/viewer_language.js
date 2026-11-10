// MCManager viewer language: local UI only; tile URLs and collection are unchanged.
function mcmanagerMapLanguage() {
  let saved;
  try { saved = localStorage.getItem('mcmanager.language'); } catch { /* Sandboxed viewer. */ }
  const requested = new URL(location.href).searchParams.get('lang') || saved;
  if (requested === 'en' || requested === 'zh-CN') return requested;
  return /^zh(?:-|$)/i.test(navigator.language) ? 'zh-CN' : 'en';
}
function mcmanagerMapText(chinese, english) {
  return mcmanagerMapLanguage() === 'en' ? english : chinese;
}
function mcmanagerMapLanguageControl(parent) {
  document.documentElement.lang = mcmanagerMapLanguage();
  const label = document.createElement('label');
  label.style.cssText = 'margin-left:auto;flex:0 0 auto;color:#ead9fa;font:13px sans-serif';
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Language / 语言');
  select.style.cssText = 'background:#302039;color:#fff;border:0;padding:4px';
  for (const [value, text] of [['zh-CN','简体中文'],['en','English']]) {
    const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option);
  }
  select.value = mcmanagerMapLanguage();
  select.addEventListener('change', () => {
    try { localStorage.setItem('mcmanager.language',select.value); } catch { /* URL fallback. */ }
    const url = new URL(location.href); url.searchParams.set('lang',select.value); location.assign(url.href);
  });
  label.append(select); parent.append(label);
}
