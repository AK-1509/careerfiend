/**
 * In-page scripts, kept as plain JavaScript strings. (tsx/esbuild inject a
 * `__name` helper into named functions, which throws inside page.evaluate;
 * strings avoid that entirely.)
 */

export interface RawOption {
  cfId: string;
  label: string;
  checked: boolean;
}

export interface RawControl {
  cfId: string;
  tag: string;
  inputType: string;
  control: "text" | "email" | "tel" | "url" | "number" | "date" | "textarea" | "select" | "radio" | "checkbox" | "file" | "combobox" | "unsupported";
  name: string;
  autocomplete: string;
  label: string;
  context: string;
  required: boolean;
  options: string[];
  members: RawOption[];
  value: string;
  validation: string;
  invalid: boolean;
}

export interface RawButton {
  cfId: string;
  name: string;
  type: string;
  tag: string;
  submitsForm: boolean;
  nearbyText: string;
}

export interface PageState {
  url: string;
  title: string;
  captcha: boolean;
  login: boolean;
  confirmation: boolean;
  assessment: boolean;
  bodyTextSample: string;
  visibleErrors: string[];
  heading: string;
}

const HELPERS = `
  var cfVis = function (el) {
    if (!el || !el.isConnected) return false;
    if (el.closest('[hidden]')) return false;
    var s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  };
  var cfTxt = function (el) { return el ? String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim() : ''; };
  var cfMark = function (el) {
    if (!el.dataset.cfId) { window.__cfSeq = (window.__cfSeq || 0) + 1; el.dataset.cfId = 'cf' + window.__cfSeq; }
    return el.dataset.cfId;
  };
  var cfLabel = function (el) {
    var ids = el.getAttribute('aria-labelledby');
    if (ids) {
      var t = ids.split(/\\s+/).map(function (i) { return cfTxt(document.getElementById(i)); }).join(' ').trim();
      if (t) return t;
    }
    var al = el.getAttribute('aria-label');
    if (al) return al.trim();
    if (el.id) {
      var l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (l) return cfTxt(l);
    }
    var wrap = el.closest('label');
    if (wrap) return cfTxt(wrap);
    if (el.getAttribute('placeholder')) return el.getAttribute('placeholder');
    if (el.getAttribute('title')) return el.getAttribute('title');
    return '';
  };
  var cfLegend = function (el) {
    var fs = el.closest('fieldset');
    var lg = fs && fs.querySelector('legend');
    return lg ? cfTxt(lg) : '';
  };
  var cfValidation = function (el) {
    var out = [];
    var d = el.getAttribute('aria-describedby');
    if (d) d.split(/\\s+/).forEach(function (i) { var n = document.getElementById(i); if (n && cfVis(n)) out.push(cfTxt(n)); });
    var sib = el.parentElement && el.parentElement.querySelector('.error, [role=alert]');
    if (sib && cfVis(sib)) out.push(cfTxt(sib));
    return out.filter(Boolean).join(' ');
  };
`;

export const INSPECT_SCRIPT = `(() => {
  ${HELPERS}
  var out = [];
  var seen = {};
  var nodes = document.querySelectorAll('input, select, textarea');
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    var tag = el.tagName.toLowerCase();
    var type = tag === 'input' ? String(el.getAttribute('type') || 'text').toLowerCase() : tag;
    if (['hidden', 'submit', 'button', 'reset', 'image', 'password'].indexOf(type) >= 0) continue;
    if (el.disabled) continue;
    var visible = cfVis(el);
    if (!visible && type !== 'file') continue;
    if (type === 'file' && !cfVis(el.closest('label, div, section, form') || el)) continue;
    var labelRaw = cfLabel(el);
    var legend = cfLegend(el);
    if (type === 'radio' || (type === 'checkbox' && el.name && document.querySelectorAll('input[type=checkbox][name="' + CSS.escape(el.name) + '"]').length > 1)) {
      var key = type + ':' + el.name;
      if (seen[key]) continue;
      seen[key] = true;
      var members = Array.prototype.slice.call(document.querySelectorAll('input[type=' + type + '][name="' + CSS.escape(el.name) + '"]')).filter(cfVis);
      var groupLabel = legend || labelRaw;
      out.push({
        cfId: cfMark(el), tag: tag, inputType: type, control: type, name: el.name || '', autocomplete: '',
        label: groupLabel, context: '', required: members.some(function (m) { return m.required || m.getAttribute('aria-required') === 'true'; }) || /\\*|\\(required\\)/i.test(groupLabel),
        options: members.map(function (m) { return cfLabel(m); }),
        members: members.map(function (m) { return { cfId: cfMark(m), label: cfLabel(m), checked: m.checked }; }),
        value: members.filter(function (m) { return m.checked; }).map(function (m) { return cfLabel(m); }).join(', '),
        validation: cfValidation(el), invalid: el.getAttribute('aria-invalid') === 'true'
      });
      continue;
    }
    var control = tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : ['text', 'email', 'tel', 'url', 'number', 'date', 'file', 'checkbox', 'search'].indexOf(type) >= 0 ? (type === 'search' ? 'text' : type) : 'unsupported';
    var options = tag === 'select' ? Array.prototype.map.call(el.options, function (o) { return String(o.textContent || '').trim(); }) : [];
    var val = tag === 'select' ? (el.selectedIndex >= 0 ? String(el.options[el.selectedIndex].textContent || '').trim() : '') : type === 'checkbox' ? (el.checked ? 'true' : '') : type === 'file' ? (el.files && el.files[0] ? el.files[0].name : '') : String(el.value || '');
    out.push({
      cfId: cfMark(el), tag: tag, inputType: type, control: control, name: el.name || el.id || '', autocomplete: el.getAttribute('autocomplete') || '',
      label: labelRaw, context: legend, required: el.required || el.getAttribute('aria-required') === 'true' || /\\*|\\(required\\)/i.test(labelRaw),
      options: options, members: [], value: val, validation: cfValidation(el), invalid: el.getAttribute('aria-invalid') === 'true'
    });
  }
  var widgets = document.querySelectorAll('[role=combobox]:not(input):not(select), [role=checkbox]:not(input)');
  for (var j = 0; j < widgets.length; j++) {
    var w = widgets[j];
    if (!cfVis(w)) continue;
    var role = w.getAttribute('role');
    var lbl = cfLabel(w);
    var opts = [];
    if (role === 'combobox') {
      var lb = document.getElementById(w.getAttribute('aria-controls') || '');
      if (lb) opts = Array.prototype.map.call(lb.querySelectorAll('[role=option]'), function (o) { return cfTxt(o) || String(o.textContent || '').trim(); });
    }
    out.push({
      cfId: cfMark(w), tag: w.tagName.toLowerCase(), inputType: role, control: role === 'combobox' ? 'combobox' : 'checkbox', name: w.id || '', autocomplete: '',
      label: lbl, context: '', required: w.getAttribute('aria-required') === 'true' || /\\*|\\(required\\)/i.test(lbl),
      options: opts, members: [], value: role === 'checkbox' ? (w.getAttribute('aria-checked') === 'true' ? 'true' : '') : (w.dataset.value || ''),
      validation: cfValidation(w), invalid: w.getAttribute('aria-invalid') === 'true'
    });
  }
  return out;
})()`;

/**
 * Like INSPECT_SCRIPT, but also lists the controls of later, still hidden steps
 * of the same form (read-only answer sheets: the steps are never clicked through).
 * Hidden controls outside a form, and CAPTCHA or honeypot inputs, are skipped.
 */
export const INSPECT_ALL_SCRIPT = INSPECT_SCRIPT.replace(
  "if (!visible && type !== 'file') continue;",
  "if (!visible && (!el.closest('form') || /captcha|honeypot|recaptcha/i.test((el.name || '') + ' ' + (el.id || '')))) continue;",
)
  .replace("if (type === 'file' && !cfVis(el.closest('label, div, section, form') || el)) continue;", "")
  .replace(".filter(cfVis);", ";");

export const BUTTONS_SCRIPT = `(() => {
  ${HELPERS}
  var out = [];
  var nodes = document.querySelectorAll('button, input[type=submit], input[type=button], [role=button], a.button, a.btn');
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    if (!cfVis(el) || el.disabled) continue;
    var tag = el.tagName.toLowerCase();
    var type = tag === 'button' ? String(el.getAttribute('type') || (el.form ? 'submit' : 'button')).toLowerCase() : tag === 'input' ? String(el.type).toLowerCase() : 'link';
    var name = String(el.getAttribute('aria-label') || cfTxt(el) || el.value || '').trim();
    var scope = el.closest('section, form, main') || document.body;
    out.push({ cfId: cfMark(el), name: name, type: type, tag: tag, submitsForm: type === 'submit' && !!el.form, nearbyText: cfTxt(scope).slice(0, 600) });
  }
  return out;
})()`;

export const STATE_SCRIPT = `(() => {
  ${HELPERS}
  var body = cfTxt(document.body);
  var captcha = !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], iframe[src*="challenges.cloudflare"], .g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]') || /verify (that )?you are (a )?human|i'?m not a robot|complete the security check/i.test(body);
  var pw = Array.prototype.some.call(document.querySelectorAll('input[type=password]'), cfVis);
  var login = pw || /^(sign in|log in)\\b/i.test(cfTxt(document.querySelector('h1')));
  var confirmation = /thank you for (applying|your application|your interest)|application (has been |was )?(submitted|received)|we('ve| have) received your application|successfully submitted/i.test(body);
  var assessment = /\\b(timed (test|assessment)|this (test|assessment) (will|is timed)|begin (the )?assessment|coding challenge)\\b/i.test(body);
  var errs = Array.prototype.filter.call(document.querySelectorAll('.error, [role=alert], .field-error, .invalid-feedback'), cfVis).map(cfTxt).filter(Boolean);
  return { url: location.href, title: document.title, captcha: captcha, login: login, confirmation: confirmation, assessment: assessment, bodyTextSample: body.slice(0, 500), visibleErrors: errs, heading: cfTxt(document.querySelector('h1, h2')) };
})()`;

/**
 * Submission guard, installed in every page. A form may submit only when the
 * submitter is a button CareerFiend explicitly marked for this click
 * (data-cf-allowed="1"). Programmatic form.submit() and Enter-key submits are
 * blocked. Blocked attempts are counted for the audit trail.
 */
export const GUARD_SCRIPT = `(() => {
  if (window.__cfGuard) return;
  window.__cfGuard = true;
  window.__cfBlockedSubmits = 0;
  document.addEventListener('submit', function (e) {
    var s = e.submitter;
    if (s && s.dataset && s.dataset.cfAllowed === '1') { delete s.dataset.cfAllowed; return; }
    e.preventDefault();
    e.stopImmediatePropagation();
    window.__cfBlockedSubmits++;
  }, true);
  var origSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () {
    if (window.__cfAllowProgrammatic === true) { window.__cfAllowProgrammatic = false; return origSubmit.call(this); }
    window.__cfBlockedSubmits++;
  };
})()`;
