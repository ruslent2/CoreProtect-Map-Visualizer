// Власний випадаючий список поверх прихованого <select>. Нативний попап браузера
// закривається від будь-якого скролу (зокрема від плавної прокрутки колеса миші),
// а цей закривається лише вибором, Esc, кліком поза списком або втратою фокуса.
// <select> лишається джерелом значення: value і подія change працюють як раніше.

export function enhanceSelect(select: HTMLSelectElement): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'dropdown';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'dropdown-button';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  const list = document.createElement('div');
  list.className = 'dropdown-list';
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  // mousedown у списку не забирає фокус у кнопки, тож blur не закриє список до кліку.
  list.addEventListener('mousedown', (event) => event.preventDefault());

  if (select.parentNode) select.replaceWith(wrap);
  select.hidden = true;
  wrap.append(select, button, list);

  let active = select.selectedIndex;
  const isOpen = () => !list.hidden;

  const syncButton = () => {
    button.textContent = select.selectedOptions[0]?.textContent ?? '';
    const label = select.getAttribute('aria-label');
    if (label) button.setAttribute('aria-label', label);
  };

  const highlight = () => {
    Array.from(list.children).forEach((child, index) => {
      child.classList.toggle('active', index === active);
      if (index === active) (child as HTMLElement).scrollIntoView({ block: 'nearest' });
    });
  };

  const onOutsidePointer = (event: Event) => {
    if (!wrap.isConnected) {
      document.removeEventListener('pointerdown', onOutsidePointer, true);
    } else if (!wrap.contains(event.target as Node)) {
      close();
    }
  };

  function close() {
    list.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutsidePointer, true);
  }

  function choose(index: number) {
    const changed = index !== select.selectedIndex;
    select.selectedIndex = index;
    syncButton();
    close();
    if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function open() {
    list.replaceChildren(
      ...Array.from(select.options).map((option, index) => {
        const item = document.createElement('div');
        item.className = 'dropdown-option' + (index === select.selectedIndex ? ' selected' : '');
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(index === select.selectedIndex));
        item.textContent = option.textContent;
        item.addEventListener('click', () => choose(index));
        item.addEventListener('mouseenter', () => {
          active = index;
          highlight();
        });
        return item;
      }),
    );
    active = Math.max(0, select.selectedIndex);
    list.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    highlight();
    document.addEventListener('pointerdown', onOutsidePointer, true);
  }

  button.addEventListener('click', () => (isOpen() ? close() : open()));
  button.addEventListener('blur', () => close());
  button.addEventListener('keydown', (event) => {
    const count = select.options.length;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        if (!isOpen()) {
          open();
          return;
        }
        active = (active + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
        highlight();
        return;
      }
      case 'Home':
      case 'End':
        if (!isOpen()) return;
        event.preventDefault();
        active = event.key === 'Home' ? 0 : count - 1;
        highlight();
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (isOpen()) choose(active);
        else open();
        return;
      case 'Escape':
        if (isOpen()) {
          event.preventDefault();
          close();
        }
        return;
    }
  });

  syncButton();
  return wrap;
}
