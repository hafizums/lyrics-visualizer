// Render font previews consistently, including browsers with native system menus.
(function () {
  'use strict';

  const select = document.getElementById('fontFamilySelect');
  if (!select) return;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.id = 'fontFamilyPicker';
  trigger.className = 'font-picker-trigger';
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', 'fontFamilyListbox');
  trigger.setAttribute('aria-describedby', 'fontFamilyHint');

  const label = document.querySelector('label[for="fontFamilySelect"]');
  label.id = 'fontFamilyLabel';
  label.htmlFor = trigger.id;
  trigger.setAttribute('aria-labelledby', `${label.id} fontFamilySelectedName`);

  const popup = document.createElement('div');
  popup.id = 'fontFamilyListbox';
  popup.className = 'font-picker-popup';
  popup.setAttribute('role', 'listbox');
  popup.setAttribute('aria-labelledby', label.id);
  popup.hidden = true;

  const options = Array.from(select.options);
  const rows = [];
  const groups = [];
  const moodSelect = document.getElementById('fontMoodSelect');
  const hint = document.getElementById('fontFamilyHint');
  let visibleIndexes = options.map((_, index) => index);
  let activeIndex = select.selectedIndex;
  let typeahead = '';
  let lastTypedAt = 0;

  function preview(option) {
    const content = document.createElement('span');
    content.className = 'font-picker-content';
    const parts = option.textContent.match(/^(.*?)\s*\((.*)\)$/);
    const name = document.createElement('span');
    name.className = 'font-picker-name';
    name.style.fontFamily = option.value;
    name.textContent = parts ? parts[1] : option.textContent;
    const description = document.createElement('span');
    description.className = 'font-picker-description';
    description.textContent = parts ? parts[2] : '';
    content.append(name, description);
    return content;
  }

  Array.from(select.children).forEach((sourceGroup, groupIndex) => {
    const group = document.createElement('div');
    group.setAttribute('role', 'group');
    const heading = document.createElement('div');
    heading.id = `fontFamilyGroup-${groupIndex}`;
    heading.className = 'font-picker-group';
    heading.textContent = `${sourceGroup.label} · ${sourceGroup.children.length}`;
    group.setAttribute('aria-labelledby', heading.id);
    group.append(heading);

    Array.from(sourceGroup.children).forEach((option) => {
      const index = options.indexOf(option);
      const row = document.createElement('div');
      row.id = `fontFamilyOption-${index}`;
      row.className = 'font-picker-option';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');
      row.append(preview(option));
      row.addEventListener('click', () => choose(index));
      group.append(row);
      rows.push(row);
    });
    popup.append(group);
    const indexes = Array.from(sourceGroup.children).map((option) => options.indexOf(option));
    groups.push({ element: group, indexes, label: sourceGroup.label });
    moodSelect.add(new Option(`${sourceGroup.label} (${indexes.length})`, String(groupIndex)));
  });

  function filterByMood() {
    close();
    visibleIndexes = [];
    groups.forEach((group, index) => {
      const visible = moodSelect.value === 'all' || moodSelect.value === String(index);
      group.element.hidden = !visible;
      if (visible) visibleIndexes.push(...group.indexes);
    });
    hint.textContent = moodSelect.value === 'all'
      ? `${options.length} fonts across ${groups.length} moods. Find cartoon fonts under Happy & playful.`
      : `${visibleIndexes.length} fonts for ${groups[Number(moodSelect.value)].label}. Open the picker to compare.`;
  }

  function syncSelection() {
    const index = select.selectedIndex;
    if (index < 0) return;
    trigger.replaceChildren(preview(options[index]));
    trigger.querySelector('.font-picker-name').id = 'fontFamilySelectedName';
    const description = trigger.querySelector('.font-picker-description');
    description.textContent = `${options[index].parentElement.label} · ${description.textContent}`;
    rows.forEach((row, i) => row.setAttribute('aria-selected', String(i === index)));
    if (!popup.hidden) setActive(index);
  }

  function positionPopup() {
    const rect = trigger.getBoundingClientRect();
    const margin = 12;
    const gap = 6;
    const below = window.innerHeight - rect.bottom - margin - gap;
    const above = rect.top - margin - gap;
    const openBelow = below >= 260 || below >= above;
    const height = Math.max(0, Math.min(460, openBelow ? below : above));
    const width = Math.min(Math.max(rect.width, 300), window.innerWidth - margin * 2);
    popup.style.width = `${width}px`;
    popup.style.maxHeight = `${height}px`;
    popup.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin))}px`;
    popup.style.top = openBelow ? `${rect.bottom + gap}px` : 'auto';
    popup.style.bottom = openBelow ? 'auto' : `${window.innerHeight - rect.top + gap}px`;
  }

  function setActive(index) {
    activeIndex = visibleIndexes.includes(index) ? index : visibleIndexes[0];
    rows.forEach((row, i) => row.classList.toggle('is-active', i === activeIndex));
    trigger.setAttribute('aria-activedescendant', rows[activeIndex].id);
    rows[activeIndex].scrollIntoView({ block: 'nearest' });
  }

  function open() {
    popup.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    positionPopup();
    setActive(select.selectedIndex);
  }

  function close() {
    popup.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-activedescendant');
    typeahead = '';
  }

  function choose(index) {
    select.value = options[index].value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    close();
    trigger.focus({ preventScroll: true });
  }

  trigger.addEventListener('click', () => popup.hidden ? open() : close());
  trigger.addEventListener('blur', close);
  // Keep focus on the combobox while choosing a preview with a mouse or touch.
  popup.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.font-picker-option')) event.preventDefault();
  });
  trigger.addEventListener('keydown', (event) => {
    const key = event.key;
    if (key === 'Tab') {
      close();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'Escape'].includes(key)) {
      event.preventDefault();
      event.stopPropagation();
      if (key === 'Escape') return close();
      if (key === 'Enter' || key === ' ') return popup.hidden ? open() : choose(activeIndex);
      const wasClosed = popup.hidden;
      if (wasClosed) open();
      if (key === 'Home') setActive(visibleIndexes[0]);
      else if (key === 'End') setActive(visibleIndexes[visibleIndexes.length - 1]);
      else if (!wasClosed) {
        const next = visibleIndexes.indexOf(activeIndex) + (key === 'ArrowDown' ? 1 : -1);
        setActive(visibleIndexes[Math.max(0, Math.min(visibleIndexes.length - 1, next))]);
      }
    } else if (key.length === 1) {
      event.preventDefault();
      event.stopPropagation();
      if (popup.hidden) open();
      const now = Date.now();
      typeahead = now - lastTypedAt > 700 ? key : typeahead + key;
      lastTypedAt = now;
      const query = typeahead.toLowerCase();
      for (let offset = 1; offset <= visibleIndexes.length; offset++) {
        const index = visibleIndexes[(visibleIndexes.indexOf(activeIndex) + offset) % visibleIndexes.length];
        if (options[index].textContent.toLowerCase().startsWith(query)) {
          setActive(index);
          break;
        }
      }
    }
  });
  select.addEventListener('change', syncSelection);
  moodSelect.addEventListener('change', filterByMood);
  document.addEventListener('pointerdown', (event) => {
    if (!trigger.contains(event.target) && !popup.contains(event.target)) close();
  });
  document.addEventListener('scroll', (event) => {
    if (!popup.hidden && !popup.contains(event.target)) close();
  }, true);
  window.addEventListener('resize', () => { if (!popup.hidden) positionPopup(); });

  select.after(trigger);
  document.body.append(popup);
  select.hidden = true;
  moodSelect.options[0].textContent = `All moods (${options.length})`;
  document.getElementById('fontMoodControls').hidden = false;
  filterByMood();
  syncSelection();
})();
