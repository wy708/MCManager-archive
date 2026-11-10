export function resolveLocale(preference, browserLanguage = 'zh-CN') {
  if (preference === 'en' || preference === 'zh-CN') return preference
  return /^zh(?:-|$)/i.test(browserLanguage) ? 'zh-CN' : 'en'
}

export function interpolate(message, values = []) {
  return message.replace(/\{(\d+)\}/g, (token, index) =>
    Number(index) < values.length ? String(values[Number(index)] ?? '') : token,
  )
}
