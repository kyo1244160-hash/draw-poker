'use strict';

function redactLogText(value, max = 4000) {
  const text = typeof value === 'string' ? value.slice(0, max) : '';
  return text
    .replace(/https?:\/\/[^\s<>"']+/gi, value => {
      try {
        const url = new URL(value);
        return `${url.origin}${url.pathname}`;
      } catch { return '[url]'; }
    })
    .replace(/\b(?:Bearer\s+\S+|socket:[A-Za-z0-9_.-]+|bot:[^\s"']+)/gi, '[credential]')
    .replace(/\b(?:token|secret|password|authorization|cookie)\b\s*[:=]\s*[^\s,;]+/gi, '[credential]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b\d{18,}\b/g, '[account]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '?');
}

module.exports = { redactLogText };
