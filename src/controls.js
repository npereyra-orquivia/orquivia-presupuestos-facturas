/** Styled form controls; native fields remain the source of truth for FormData. */
let nextControlId = 0;
let openControl = null;

const weekdays = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
const monthFormatter = new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayFormatter = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const fold = value => String(value).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('es');
const create = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
const button = (className, text, label) => {
  const element = create('button', className, text);
  element.type = 'button';
  if (label) element.setAttribute('aria-label', label);
  return element;
};
function civilDate(year, month, day = 1) {
  const date = new Date(0);
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCFullYear(year, month, day);
  return date;
}
function parts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]) - 1, day = Number(match[3]);
  if (year < 1 || month < 0 || month > 11 || day < 1 || day > 31) return null;
  const date = civilDate(year, month, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day ? { year, month, day } : null;
}
function iso(date) {
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}
function currentISO() {
  const now = new Date();
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now).filter(item => item.type !== 'literal').map(item => [item.type, item.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
function labelFor(source) {
  const label = source.closest('label');
  const caption = label?.querySelector(':scope > span');
  if (caption && !caption.id) caption.id = `oc-label-${++nextControlId}`;
  return { caption, text: caption?.textContent?.trim() || source.getAttribute('aria-label') || source.name || 'Seleccionar' };
}
function dispatchValue(source, value) {
  source.value = value;
  source.dispatchEvent(new Event('input', { bubbles: true }));
  source.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Open popups in the top layer when supported, still within their form's DOM. */
function popupController(wrapper, popup, trigger, render) {
  let expanded = false;
  const signals = new AbortController();
  popup.hidden = true;
  popup.setAttribute('popover', 'manual');
  const place = () => {
    if (!expanded || !trigger.isConnected) return;
    const calendar = popup.classList.contains('oc-calendar');
    const anchor = (calendar ? wrapper : trigger).getBoundingClientRect();
    const width = Math.min(calendar ? 300 : anchor.width, innerWidth - 24);
    popup.style.width = `${width}px`;
    popup.style.maxHeight = `${Math.max(150, Math.min(420, innerHeight - 24))}px`;
    const height = popup.getBoundingClientRect().height;
    const spaceBelow = innerHeight - anchor.bottom - 12;
    const spaceAbove = anchor.top - 12;
    const top = spaceBelow >= Math.min(height, 260) || spaceBelow >= spaceAbove
      ? Math.min(anchor.bottom + 7, Math.max(12, innerHeight - height - 12))
      : Math.max(12, anchor.top - height - 7);
    popup.style.left = `${Math.max(12, Math.min(anchor.left, innerWidth - width - 12))}px`;
    popup.style.top = `${Math.max(12, top)}px`;
  };
  const controller = {
    get isOpen() { return expanded; },
    open() {
      if (expanded) return;
      openControl?.close();
      openControl = controller;
      expanded = true;
      render();
      popup.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      try { popup.showPopover?.(); } catch { /* Fixed-position fallback. */ }
      place();
    },
    close(returnFocus = false) {
      if (!expanded) return;
      expanded = false;
      try { popup.hidePopover?.(); } catch { /* Popup may have been detached. */ }
      popup.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      trigger.removeAttribute('aria-activedescendant');
      if (openControl === controller) openControl = null;
      if (returnFocus && trigger.isConnected) trigger.focus();
    },
    place,
    dispose() { controller.close(); signals.abort(); }
  };
  document.addEventListener('pointerdown', event => {
    if (expanded && !wrapper.contains(event.target)) controller.close();
  }, { capture: true, signal: signals.signal });
  wrapper.addEventListener('focusout', event => {
    if (expanded && event.relatedTarget && !wrapper.contains(event.relatedTarget)) controller.close();
  }, { signal: signals.signal });
  wrapper.addEventListener('keydown', event => {
    if (event.key === 'Escape' && expanded) {
      event.preventDefault();
      event.stopPropagation();
      controller.close(true);
    }
  }, { signal: signals.signal });
  window.addEventListener('resize', place, { passive: true, signal: signals.signal });
  document.addEventListener('scroll', place, { capture: true, passive: true, signal: signals.signal });
  return controller;
}

function enhanceSelect(source, onCreateClient) {
  const signals = new AbortController();
  const original = { hidden: source.hidden, ariaHidden: source.getAttribute('aria-hidden'), tabIndex: source.getAttribute('tabindex') };
  const { caption, text: label } = labelFor(source);
  const client = source.name === 'clientId' || source.dataset.control === 'client';
  const searchable = client || source.dataset.searchable === 'true';
  const wrapper = create('div', 'oc-control oc-select');
  const trigger = button('oc-trigger');
  const value = create('span', 'oc-value');
  const caret = create('span', 'oc-caret');
  caret.setAttribute('aria-hidden', 'true');
  trigger.append(value, caret);
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  if (caption) trigger.setAttribute('aria-labelledby', caption.id);
  else trigger.setAttribute('aria-label', label);
  const popup = create('div', 'oc-popup oc-select-popup');
  const list = create('div', 'oc-options');
  const listId = `oc-options-${++nextControlId}`;
  value.id = `${listId}-value`;
  trigger.setAttribute('aria-describedby', value.id);
  popup.id = `oc-popup-${nextControlId}`;
  list.id = listId;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', label);
  trigger.setAttribute('aria-controls', listId);
  const search = searchable ? create('input', 'oc-search') : null;
  if (search) {
    search.type = 'search';
    search.placeholder = client ? 'Buscar cliente…' : 'Buscar…';
    search.autocomplete = 'off';
    search.setAttribute('aria-label', client ? 'Buscar cliente por nombre' : `Buscar en ${label}`);
    search.setAttribute('aria-controls', listId);
    popup.append(search);
  }
  const resultCount = create('span', 'oc-sr');
  resultCount.setAttribute('role', 'status');
  resultCount.setAttribute('aria-live', 'polite');
  popup.append(list, resultCount);
  const createClient = client && typeof onCreateClient === 'function' ? button('oc-create', 'Crear cliente') : null;
  if (createClient) {
    const plus = create('span', 'oc-create-plus', '+');
    plus.setAttribute('aria-hidden', 'true');
    createClient.prepend(plus);
    popup.append(createClient);
  }
  source.before(wrapper);
  wrapper.append(source, trigger, popup);
  source.hidden = true;
  source.setAttribute('aria-hidden', 'true');
  source.tabIndex = -1;
  source.dataset.ocEnhanced = 'select';

  let optionButtons = [], activeIndex = -1;
  const enabled = () => !source.matches(':disabled');
  const update = () => {
    value.textContent = source.selectedOptions[0]?.label || (client ? 'Selecciona un cliente' : 'Selecciona una opción');
    trigger.disabled = !enabled();
    trigger.setAttribute('aria-required', String(source.required));
    if (!enabled()) controller.close();
  };
  const setActive = index => {
    if (!optionButtons.length) { activeIndex = -1; trigger.removeAttribute('aria-activedescendant'); search?.removeAttribute('aria-activedescendant'); return; }
    activeIndex = Math.max(0, Math.min(index, optionButtons.length - 1));
    optionButtons.forEach((item, i) => item.classList.toggle('is-active', i === activeIndex));
    const active = optionButtons[activeIndex];
    trigger.setAttribute('aria-activedescendant', active.id);
    search?.setAttribute('aria-activedescendant', active.id);
    active.scrollIntoView?.({ block: 'nearest' });
  };
  const choose = option => {
    if (!enabled() || option.disabled || option.parentElement?.disabled) return;
    dispatchValue(source, option.value);
    trigger.removeAttribute('aria-invalid');
    update();
    controller.close(true);
  };
  const renderOptions = () => {
    list.replaceChildren();
    optionButtons = [];
    const term = fold(search?.value || '');
    let lastGroup = null;
    [...source.options].forEach((option, index) => {
      if (option.hidden || !fold(option.label).includes(term)) return;
      const group = option.parentElement?.tagName === 'OPTGROUP' ? option.parentElement : null;
      if (group && group !== lastGroup) {
        const heading = create('div', 'oc-group', group.label);
        heading.setAttribute('role', 'presentation');
        list.append(heading);
      }
      lastGroup = group;
      const item = button('oc-option', option.label);
      item.id = `${listId}-${index}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(option.selected));
      item.tabIndex = -1;
      item.disabled = option.disabled || Boolean(group?.disabled);
      item.classList.toggle('is-selected', option.selected);
      item.addEventListener('click', event => { event.preventDefault(); choose(option); });
      item.addEventListener('pointermove', () => { if (!item.disabled) setActive(optionButtons.indexOf(item)); });
      list.append(item);
      if (!item.disabled) optionButtons.push(item);
    });
    if (!list.childElementCount) list.append(create('div', 'oc-no-results', client ? 'No hay clientes con ese nombre.' : 'No hay resultados.'));
    resultCount.textContent = `${optionButtons.length} ${optionButtons.length === 1 ? 'opción disponible' : 'opciones disponibles'}`;
    const selected = optionButtons.findIndex(item => item.getAttribute('aria-selected') === 'true');
    setActive(selected < 0 ? 0 : selected);
    controller?.place();
  };
  const controller = popupController(wrapper, popup, trigger, () => {
    if (search) search.value = '';
    renderOptions();
  });
  const open = (last = false) => {
    update();
    if (!enabled()) return;
    controller.open();
    if (last) setActive(optionButtons.length - 1);
    if (search) search.focus();
  };
  trigger.addEventListener('click', event => {
    event.preventDefault();
    controller.isOpen ? controller.close() : open();
  }, { signal: signals.signal });
  caption?.addEventListener('click', event => {
    event.preventDefault();
    if (enabled()) trigger.focus();
  }, { signal: signals.signal });
  const keydown = event => {
    if (!enabled()) return;
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (!controller.isOpen) { open(event.key === 'ArrowUp' || event.key === 'End'); return; }
      setActive(event.key === 'Home' ? 0 : event.key === 'End' ? optionButtons.length - 1 : activeIndex + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Enter' || event.key === ' ' && event.target === trigger) {
      event.preventDefault();
      if (!controller.isOpen) open();
      else optionButtons[activeIndex]?.click();
    } else if (!search && !event.ctrlKey && !event.metaKey && event.key.length === 1) {
      open();
      const matched = optionButtons.findIndex(item => fold(item.textContent).startsWith(fold(event.key)));
      if (matched >= 0) setActive(matched);
    }
  };
  trigger.addEventListener('keydown', keydown, { signal: signals.signal });
  if (search) {
    search.addEventListener('input', renderOptions, { signal: signals.signal });
    search.addEventListener('keydown', keydown, { signal: signals.signal });
  }
  createClient?.addEventListener('click', event => {
    event.preventDefault();
    if (!enabled()) return;
    controller.close();
    onCreateClient(source);
  }, { signal: signals.signal });
  source.addEventListener('change', () => { update(); if (controller.isOpen) renderOptions(); }, { signal: signals.signal });
  source.addEventListener('invalid', event => { event.preventDefault(); trigger.setAttribute('aria-invalid', 'true'); open(); trigger.focus(); }, { signal: signals.signal });
  source.form?.addEventListener('reset', () => queueMicrotask(update), { signal: signals.signal });
  const observer = new MutationObserver(() => { update(); if (controller.isOpen) renderOptions(); });
  observer.observe(source, { attributes: true, childList: true, subtree: true });
  update();
  return () => {
    controller.dispose(); signals.abort(); observer.disconnect();
    source.hidden = original.hidden;
    original.ariaHidden === null ? source.removeAttribute('aria-hidden') : source.setAttribute('aria-hidden', original.ariaHidden);
    original.tabIndex === null ? source.removeAttribute('tabindex') : source.setAttribute('tabindex', original.tabIndex);
    delete source.dataset.ocEnhanced;
    wrapper.before(source); wrapper.remove();
  };
}

function enhanceDate(source) {
  const signals = new AbortController();
  const { caption, text: label } = labelFor(source);
  const wrapper = create('div', 'oc-control oc-date');
  const trigger = button('oc-date-trigger', '', `Abrir calendario: ${label}`);
  const calendarIcon = create('span', 'oc-calendar-icon');
  calendarIcon.setAttribute('aria-hidden', 'true');
  trigger.append(calendarIcon);
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-expanded', 'false');
  const popup = create('div', 'oc-popup oc-calendar');
  popup.id = `oc-calendar-${++nextControlId}`;
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', `Elegir ${label.toLocaleLowerCase('es')}`);
  trigger.setAttribute('aria-controls', popup.id);
  const header = create('div', 'oc-calendar-header');
  const previous = button('oc-month-nav', '‹', 'Mes anterior');
  const monthLabel = create('strong', 'oc-month-label');
  monthLabel.id = `${popup.id}-month`;
  monthLabel.setAttribute('aria-live', 'polite');
  const next = button('oc-month-nav', '›', 'Mes siguiente');
  header.append(previous, monthLabel, next);
  const grid = create('div', 'oc-calendar-grid');
  grid.setAttribute('role', 'grid');
  grid.setAttribute('aria-labelledby', monthLabel.id);
  const footer = create('div', 'oc-calendar-footer');
  const today = button('oc-calendar-link', 'Hoy');
  const clear = button('oc-calendar-link oc-calendar-clear', 'Quitar fecha');
  footer.append(today, clear);
  const manualHint = create('p', 'oc-calendar-hint', 'También puedes escribir la fecha en el campo.');
  popup.append(header, grid, footer, manualHint);
  source.before(wrapper);
  wrapper.append(source, trigger, popup);
  source.classList.add('oc-date-input');
  source.dataset.ocEnhanced = 'date';

  let focusDate = currentISO(), viewYear = 0, viewMonth = 0;
  const allowed = value => Boolean(parts(value)) && (!parts(source.min) || value >= source.min) && (!parts(source.max) || value <= source.max);
  const bounded = value => {
    if (parts(source.min) && value < source.min) return source.min;
    if (parts(source.max) && value > source.max) return source.max;
    return value;
  };
  const editable = () => !source.matches(':disabled') && !source.readOnly;
  const updateLabel = () => {
    const currentLabel = labelFor(source).text;
    trigger.setAttribute('aria-label', `Abrir calendario: ${currentLabel}`);
    popup.setAttribute('aria-label', `Elegir ${currentLabel.toLocaleLowerCase('es')}`);
  };
  const update = () => {
    updateLabel();
    trigger.disabled = !editable();
    wrapper.classList.toggle('is-readonly', !editable());
    if (!editable()) controller.close();
    clear.hidden = source.required;
    today.disabled = !allowed(currentISO());
  };
  const selectDate = value => {
    if (!editable() || value && !allowed(value) || !value && source.required) return;
    dispatchValue(source, value);
    controller.close();
    source.focus();
  };
  const renderCalendar = () => {
    const todayISO = currentISO();
    const first = civilDate(viewYear, viewMonth);
    const firstISO = iso(first);
    const lastISO = iso(civilDate(viewYear, viewMonth + 1, 0));
    const title = monthFormatter.format(first);
    monthLabel.textContent = title.charAt(0).toLocaleUpperCase('es') + title.slice(1);
    previous.disabled = viewYear <= 1 && viewMonth === 0 || Boolean(parts(source.min) && firstISO <= source.min);
    next.disabled = viewYear >= 9999 && viewMonth === 11 || Boolean(parts(source.max) && lastISO >= source.max);
    clear.hidden = source.required;
    today.disabled = !allowed(todayISO);
    grid.replaceChildren();
    const headings = create('div', 'oc-calendar-week');
    headings.setAttribute('role', 'row');
    weekdays.forEach((day, index) => {
      const heading = create('span', 'oc-weekday', ['L', 'M', 'X', 'J', 'V', 'S', 'D'][index]);
      heading.setAttribute('role', 'columnheader');
      heading.setAttribute('aria-label', day);
      headings.append(heading);
    });
    grid.append(headings);
    const offset = (first.getUTCDay() + 6) % 7;
    for (let week = 0; week < 6; week++) {
      const row = create('div', 'oc-calendar-week');
      row.setAttribute('role', 'row');
      for (let day = 0; day < 7; day++) {
        const date = civilDate(viewYear, viewMonth, week * 7 + day - offset + 1);
        const value = iso(date);
        const cell = create('span', 'oc-day-cell');
        cell.setAttribute('role', 'gridcell');
        cell.setAttribute('aria-selected', String(value === source.value));
        const pick = button('oc-day', String(date.getUTCDate()), dayFormatter.format(date));
        pick.dataset.date = value;
        pick.tabIndex = value === focusDate ? 0 : -1;
        pick.disabled = !allowed(value);
        pick.classList.toggle('is-outside', date.getUTCMonth() !== viewMonth);
        pick.classList.toggle('is-selected', value === source.value);
        if (value === todayISO) pick.setAttribute('aria-current', 'date');
        pick.addEventListener('click', event => { event.preventDefault(); selectDate(value); });
        cell.append(pick); row.append(cell);
      }
      grid.append(row);
    }
    if (!grid.querySelector('.oc-day[tabindex="0"]:not(:disabled)')) {
      const firstAllowed = grid.querySelector('.oc-day:not(:disabled):not(.is-outside)') || grid.querySelector('.oc-day:not(:disabled)');
      if (firstAllowed) { firstAllowed.tabIndex = 0; focusDate = firstAllowed.dataset.date; }
    }
    controller?.place();
  };
  const controller = popupController(wrapper, popup, trigger, () => {
    updateLabel();
    focusDate = bounded(parts(source.value) ? source.value : currentISO());
    const selected = parts(focusDate);
    viewYear = selected.year; viewMonth = selected.month;
    renderCalendar();
  });
  const focusDay = value => {
    const candidate = bounded(value), selected = parts(candidate);
    if (!selected) return;
    focusDate = candidate; viewYear = selected.year; viewMonth = selected.month;
    renderCalendar();
    grid.querySelector(`.oc-day[data-date="${candidate}"]`)?.focus();
  };
  const moveMonth = amount => {
    const selected = parts(focusDate) || { day: 1 };
    const target = civilDate(viewYear, viewMonth + amount);
    if (target.getUTCFullYear() < 1 || target.getUTCFullYear() > 9999) return;
    viewYear = target.getUTCFullYear(); viewMonth = target.getUTCMonth();
    const days = civilDate(viewYear, viewMonth + 1, 0).getUTCDate();
    focusDate = bounded(iso(civilDate(viewYear, viewMonth, Math.min(selected.day, days))));
    renderCalendar();
  };
  trigger.addEventListener('click', event => {
    event.preventDefault(); update();
    if (!editable()) return;
    if (controller.isOpen) { controller.close(true); return; }
    controller.open(); grid.querySelector('.oc-day[tabindex="0"]:not(:disabled)')?.focus();
  }, { signal: signals.signal });
  source.addEventListener('keydown', event => {
    if (event.altKey && event.key === 'ArrowDown' && editable()) { event.preventDefault(); trigger.click(); }
  }, { signal: signals.signal });
  grid.addEventListener('keydown', event => {
    const picked = event.target.closest('.oc-day');
    if (!picked) return;
    const selected = parts(picked.dataset.date);
    const date = civilDate(selected.year, selected.month, selected.day);
    let target = null;
    if (event.key === 'ArrowLeft') target = iso(civilDate(selected.year, selected.month, selected.day - 1));
    if (event.key === 'ArrowRight') target = iso(civilDate(selected.year, selected.month, selected.day + 1));
    if (event.key === 'ArrowUp') target = iso(civilDate(selected.year, selected.month, selected.day - 7));
    if (event.key === 'ArrowDown') target = iso(civilDate(selected.year, selected.month, selected.day + 7));
    if (event.key === 'Home') target = iso(civilDate(selected.year, selected.month, selected.day - (date.getUTCDay() + 6) % 7));
    if (event.key === 'End') target = iso(civilDate(selected.year, selected.month, selected.day + 6 - (date.getUTCDay() + 6) % 7));
    if (event.key === 'PageUp' || event.key === 'PageDown') {
      const months = (event.key === 'PageUp' ? -1 : 1) * (event.shiftKey ? 12 : 1);
      const month = civilDate(selected.year, selected.month + months);
      const days = civilDate(month.getUTCFullYear(), month.getUTCMonth() + 1, 0).getUTCDate();
      target = iso(civilDate(month.getUTCFullYear(), month.getUTCMonth(), Math.min(selected.day, days)));
    }
    if (target) { event.preventDefault(); focusDay(target); }
  }, { signal: signals.signal });
  previous.addEventListener('click', event => { event.preventDefault(); if (!previous.disabled) moveMonth(-1); }, { signal: signals.signal });
  next.addEventListener('click', event => { event.preventDefault(); if (!next.disabled) moveMonth(1); }, { signal: signals.signal });
  today.addEventListener('click', event => { event.preventDefault(); selectDate(currentISO()); }, { signal: signals.signal });
  clear.addEventListener('click', event => { event.preventDefault(); selectDate(''); }, { signal: signals.signal });
  source.addEventListener('change', () => { update(); if (controller.isOpen) renderCalendar(); }, { signal: signals.signal });
  source.form?.addEventListener('reset', () => queueMicrotask(() => { controller.close(); update(); }), { signal: signals.signal });
  const observer = new MutationObserver(() => { update(); if (controller.isOpen) renderCalendar(); });
  observer.observe(source, { attributes: true });
  const captionObserver = caption ? new MutationObserver(updateLabel) : null;
  captionObserver?.observe(caption, { childList: true, characterData: true, subtree: true });
  update();
  return () => {
    controller.dispose(); signals.abort(); observer.disconnect(); captionObserver?.disconnect();
    source.classList.remove('oc-date-input'); delete source.dataset.ocEnhanced;
    wrapper.before(source); wrapper.remove();
  };
}

/**
 * Call after setting disabled/readOnly attributes. Dispose before replacing the
 * surrounding form or modal. onCreateClient receives the original client select.
 */
export function enhanceControls(root, { onCreateClient } = {}) {
  const disposers = [];
  root.querySelectorAll('select:not([multiple]):not([data-native-control]):not([data-oc-enhanced])').forEach(source => {
    disposers.push(enhanceSelect(source, onCreateClient));
  });
  root.querySelectorAll('input[type="date"]:not([data-native-control]):not([data-oc-enhanced])').forEach(source => {
    disposers.push(enhanceDate(source));
  });
  return () => disposers.forEach(dispose => dispose());
}
