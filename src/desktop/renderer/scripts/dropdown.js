const CUSTOM_SELECTS = [];

let activeCustomSelect = null;

const NATIVE_SELECT_VALUE = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
const NATIVE_SELECT_INDEX = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');

function customSelectLabelText(select) {
    const option = select.selectedIndex >= 0 ? select.options[select.selectedIndex] : null;
    return option ? (option.textContent || '').trim() : '';
}

function customSelectOptions(entry) {
    return Array.from(entry.menu.querySelectorAll('.dropdown-option')).filter((option) => !option.disabled);
}

function usesNativeMenu() {
    return typeof nativeMenuBridge !== 'undefined' && !!nativeMenuBridge && nativeMenuBridge.isMac;
}

function nativeOptionEntry(option) {
    const label = (option.textContent || '').trim();
    if (!label) return null;
    return {
        action: String(option.value),
        label,
        disabled: !!option.disabled
    };
}

function nativeSelectEntries(entry) {
    const entries = [];
    Array.from(entry.select.children).forEach((child) => {
        if (child.tagName === 'OPTGROUP') {
            const items = Array.from(child.children)
                .filter((option) => option.tagName === 'OPTION' && !option.hasAttribute('data-placeholder'))
                .map(nativeOptionEntry)
                .filter(Boolean);
            if (items.length) entries.push({ type: 'submenu', label: child.label || '…', items });
            return;
        }
        if (child.tagName !== 'OPTION' || child.hasAttribute('data-placeholder')) return;
        const option = nativeOptionEntry(child);
        if (option) entries.push(option);
    });
    return entries;
}

let nativeMenuOpening = false;

function openNativeSelect(entry) {
    if (nativeMenuOpening) return;
    const entries = nativeSelectEntries(entry);
    if (!entries.length) return;
    nativeMenuOpening = true;
    nativeMenuBridge.popup(entries).then((action) => {
        if (typeof action === 'string') chooseCustomSelectValue(entry, action);
    }).catch(() => {}).finally(() => {
        nativeMenuOpening = false;
    });
}

function createCustomSelectOption(entry, option) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dropdown-option';
    button.dataset.value = option.value;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', 'false');
    button.disabled = !!option.disabled;

const text = document.createElement('span');
    text.className = 'dropdown-option-text';
    text.textContent = (option.textContent || '').trim();

    const check = document.createElement('span');
    check.className = 'icon xs dropdown-check';
    setLucideIcon(check, 'check');

    button.append(text, check);
    button.onclick = () => chooseCustomSelectValue(entry, option.value);
    return button;
}

function buildCustomSelectMenu(entry) {
    const { select, menu } = entry;
    menu.innerHTML = '';
    Array.from(select.children).forEach((child) => {
        if (child.tagName === 'OPTGROUP') {
            const groupLabel = document.createElement('div');
            groupLabel.className = 'dropdown-group-label';
            groupLabel.textContent = child.label || '';
            menu.appendChild(groupLabel);
            Array.from(child.children).forEach((option) => {
                if (option.hasAttribute('data-placeholder')) return;
                menu.appendChild(createCustomSelectOption(entry, option));
            });
            return;
        }
        if (child.tagName === 'OPTION') {
            if (child.hasAttribute('data-placeholder')) return;
            menu.appendChild(createCustomSelectOption(entry, child));
        }
    });
    entry.dirty = false;
}

function refreshCustomSelect(entry) {
    const { select, trigger, label, menu } = entry;
    label.textContent = customSelectLabelText(select);
    trigger.disabled = !!select.disabled;
    trigger.classList.toggle('disabled', !!select.disabled);
    menu.querySelectorAll('.dropdown-option').forEach((option) => {
        const active = option.dataset.value === select.value;
        option.classList.toggle('active', active);
        option.setAttribute('aria-selected', active ? 'true' : 'false');
    });
}

function positionCustomSelectMenu(entry) {
    const { trigger, menu } = entry;
    const anchor = trigger.getBoundingClientRect();
    const box = menu.getBoundingClientRect();
    const gap = 4;
    const margin = 8;

    let left = anchor.left;
    if (left + box.width > window.innerWidth - margin) {
        left = Math.max(margin, window.innerWidth - margin - box.width);
    }
    let top = anchor.bottom + gap;
    if (top + box.height > window.innerHeight - margin) {
        const above = anchor.top - gap - box.height;
        top = above >= margin ? above : Math.max(margin, window.innerHeight - margin - box.height);
    }

    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;

    menu.style.minWidth = `${Math.max(120, Math.round(anchor.width))}px`;
}

function setCustomSelectHighlight(entry, index) {
    const options = customSelectOptions(entry);
    entry.menu.querySelectorAll('.dropdown-option').forEach((option) => option.classList.remove('highlight'));
    if (!options.length) {
        entry.highlight = -1;
        return;
    }
    entry.highlight = Math.min(Math.max(index, 0), options.length - 1);
    const current = options[entry.highlight];
    current.classList.add('highlight');
    current.scrollIntoView({ block: 'nearest' });
}

function moveCustomSelectHighlight(entry, delta) {
    const options = customSelectOptions(entry);
    if (!options.length) return;
    if (entry.highlight < 0) {

        const activeIndex = options.findIndex((option) => option.classList.contains('active'));
        setCustomSelectHighlight(entry, activeIndex >= 0 ? activeIndex : (delta > 0 ? 0 : options.length - 1));
        return;
    }
    setCustomSelectHighlight(entry, (entry.highlight + delta + options.length) % options.length);
}

function closeCustomSelect() {
    if (!activeCustomSelect) return;
    const entry = activeCustomSelect;
    activeCustomSelect = null;

    entry.menu.hidden = true;
    entry.menu.style.left = '';
    entry.menu.style.top = '';
    entry.menu.style.minWidth = '';
    entry.root.classList.remove('open');
    entry.trigger.setAttribute('aria-expanded', 'false');
    entry.highlight = -1;
    entry.menu.querySelectorAll('.dropdown-option.highlight').forEach((option) => option.classList.remove('highlight'));
}

function openCustomSelect(entry) {
    if (activeCustomSelect === entry) return;
    closeCustomSelect();

if (entry.dirty || !entry.menu.childElementCount) buildCustomSelectMenu(entry);
    refreshCustomSelect(entry);

    entry.menu.hidden = false;
    entry.root.classList.add('open');
    entry.trigger.setAttribute('aria-expanded', 'true');
    activeCustomSelect = entry;

positionCustomSelectMenu(entry);

entry.highlight = -1;
}

function toggleCustomSelect(entry) {
    if (activeCustomSelect === entry) closeCustomSelect();
    else openCustomSelect(entry);
}

function chooseCustomSelectValue(entry, value) {
    const { select } = entry;
    const changed = select.value !== value;
    select.value = value;
    closeCustomSelect();
    entry.trigger.focus();
    if (!changed) return;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
}

function confirmCustomSelectValue(entry, options) {
    const highlighted = entry.highlight >= 0 ? options[entry.highlight] : null;
    const target = highlighted || options.find((option) => option.classList.contains('active'));
    if (target) chooseCustomSelectValue(entry, target.dataset.value);
    else closeCustomSelect();
}

function handleCustomSelectKeydown(entry, event) {
    if (usesNativeMenu()) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            openNativeSelect(entry);
        }
        return;
    }

    const isOpen = activeCustomSelect === entry;
    const options = customSelectOptions(entry);

    switch (event.key) {
    case 'ArrowDown':
        event.preventDefault();
        if (!isOpen) openCustomSelect(entry);
        else moveCustomSelectHighlight(entry, 1);
        break;
    case 'ArrowUp':
        event.preventDefault();
        if (!isOpen) openCustomSelect(entry);
        else moveCustomSelectHighlight(entry, -1);
        break;
    case 'Home':
        if (!isOpen) break;
        event.preventDefault();
        setCustomSelectHighlight(entry, 0);
        break;
    case 'End':
        if (!isOpen) break;
        event.preventDefault();
        setCustomSelectHighlight(entry, options.length - 1);
        break;
    case 'Enter':
    case ' ':
        event.preventDefault();
        if (!isOpen) openCustomSelect(entry);
        else confirmCustomSelectValue(entry, options);
        break;
    case 'Escape':
        if (isOpen) {
            event.preventDefault();
            closeCustomSelect();
        }
        break;
    case 'Tab':
        closeCustomSelect();
        break;
    default:
        break;
    }
}

function upgradeSelectToCustom(select) {
    if (!select || select.dataset.customDropdown === '1') return null;

    const root = document.createElement('div');
    root.className = 'dropdown';

const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = `${select.className} dropdown-trigger`.trim();
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    if (select.title) trigger.title = select.title;
    ['aria-label', 'aria-labelledby'].forEach((name) => {
        const value = select.getAttribute(name);
        if (value) trigger.setAttribute(name, value);
    });

    const label = document.createElement('span');
    label.className = 'dropdown-label';
    const arrow = document.createElement('span');
    arrow.className = 'icon xs dropdown-arrow';
    setLucideIcon(arrow, 'chevron-down');
    trigger.append(label, arrow);

    const menu = document.createElement('div');
    menu.className = 'dropdown-menu';
    menu.setAttribute('role', 'listbox');
    menu.hidden = true;

document.body.appendChild(menu);

select.dataset.customDropdown = '1';
    select.classList.add('dropdown-source');
    select.setAttribute('tabindex', '-1');
    select.parentNode.insertBefore(root, select);
    root.append(trigger, select);

    const entry = { select, root, trigger, label, menu, highlight: -1, dirty: false };

    trigger.addEventListener('click', (event) => {
        event.preventDefault();
        if (usesNativeMenu()) {
            openNativeSelect(entry);
            return;
        }
        toggleCustomSelect(entry);
    });
    trigger.addEventListener('keydown', (event) => handleCustomSelectKeydown(entry, event));

Object.defineProperty(select, 'value', {
        configurable: true,
        get() { return NATIVE_SELECT_VALUE.get.call(this); },
        set(next) {
            NATIVE_SELECT_VALUE.set.call(this, next);
            refreshCustomSelect(entry);
        }
    });
    Object.defineProperty(select, 'selectedIndex', {
        configurable: true,
        get() { return NATIVE_SELECT_INDEX.get.call(this); },
        set(next) {
            NATIVE_SELECT_INDEX.set.call(this, next);
            refreshCustomSelect(entry);
        }
    });

const observer = new MutationObserver(() => {
        entry.dirty = true;
        refreshCustomSelect(entry);
        if (activeCustomSelect === entry) {
            buildCustomSelectMenu(entry);
            refreshCustomSelect(entry);
            positionCustomSelectMenu(entry);
        }
    });
    observer.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    entry.observer = observer;

    CUSTOM_SELECTS.push(entry);
    refreshCustomSelect(entry);
    return entry;
}

const DATALIST_SUGGEST_LIMIT = 100;

function customDatalistMatches(entry) {
    const keyword = (entry.input.value || '').trim().toLowerCase();
    const values = Array.from(entry.list.options)
        .map((option) => option.value)
        .filter((value) => !!value);
    const matched = keyword ? values.filter((value) => value.toLowerCase().includes(keyword)) : values;
    return matched.slice(0, DATALIST_SUGGEST_LIMIT);
}

function buildCustomDatalistMenu(entry) {
    const matches = customDatalistMatches(entry);
    entry.menu.innerHTML = '';
    matches.forEach((value) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'dropdown-option';
        button.dataset.value = value;
        button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', value === entry.input.value ? 'true' : 'false');
        button.classList.toggle('active', value === entry.input.value);
        const text = document.createElement('span');
        text.className = 'dropdown-option-text';
        text.textContent = value;
        button.appendChild(text);
        button.onclick = () => chooseCustomDatalistValue(entry, value);
        entry.menu.appendChild(button);
    });
    entry.highlight = -1;
    return matches.length > 0;
}

function openCustomDatalist(entry) {
    const wasOpen = activeCustomSelect === entry;
    if (!buildCustomDatalistMenu(entry)) {
        if (wasOpen) closeCustomSelect();
        return;
    }

    if (!wasOpen) {
        closeCustomSelect();
        entry.menu.hidden = false;
        entry.input.setAttribute('aria-expanded', 'true');
        activeCustomSelect = entry;
    }

    positionCustomSelectMenu(entry);
}

function chooseCustomDatalistValue(entry, value) {
    entry.input.value = value;
    entry.input.focus();

    entry.input.dispatchEvent(new Event('input', { bubbles: true }));
    entry.input.dispatchEvent(new Event('change', { bubbles: true }));
    closeCustomSelect();
}

function handleCustomDatalistKeydown(entry, event) {
    const isOpen = activeCustomSelect === entry;
    const options = isOpen ? customSelectOptions(entry) : [];

    switch (event.key) {
    case 'ArrowDown':
        event.preventDefault();
        if (!isOpen) openCustomDatalist(entry);
        else moveCustomSelectHighlight(entry, 1);
        break;
    case 'ArrowUp':
        event.preventDefault();
        if (!isOpen) openCustomDatalist(entry);
        else moveCustomSelectHighlight(entry, -1);
        break;
    case 'Enter':

        if (isOpen) {
            if (entry.highlight >= 0 && options[entry.highlight]) {
                event.preventDefault();
                chooseCustomDatalistValue(entry, options[entry.highlight].dataset.value);
            } else {
                closeCustomSelect();
            }
        }
        break;
    case 'Escape':
        if (isOpen) {
            event.preventDefault();
            closeCustomSelect();
        }
        break;
    case 'Tab':
        closeCustomSelect();
        break;
    default:
        break;
    }
}

function disposeCustomSelect(select) {
    if (!select) return;
    const index = CUSTOM_SELECTS.findIndex((entry) => entry.select === select);
    if (index === -1) return;

    const [entry] = CUSTOM_SELECTS.splice(index, 1);
    if (activeCustomSelect === entry) closeCustomSelect();
    if (entry.observer) entry.observer.disconnect();
    if (entry.menu && entry.menu.parentNode) entry.menu.parentNode.removeChild(entry.menu);
}

function disposeCustomSelectsIn(container) {
    if (!container) return;
    container.querySelectorAll('select[data-custom-dropdown="1"]').forEach(disposeCustomSelect);
}

function upgradeDatalistToCustom(input) {
    const listId = input.getAttribute('list');
    const list = listId ? document.getElementById(listId) : null;
    if (!list || input.dataset.customDatalist === '1') return null;

    input.dataset.customDatalist = '1';

    input.removeAttribute('list');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('aria-haspopup', 'listbox');
    input.setAttribute('aria-expanded', 'false');

    const menu = document.createElement('div');
    menu.className = 'dropdown-menu';
    menu.setAttribute('role', 'listbox');
    menu.hidden = true;

    menu.addEventListener('pointerdown', (event) => event.preventDefault());
    document.body.appendChild(menu);

    const entry = {
        select: null,
        list,
        input,
        trigger: input,
        root: input.parentElement,
        menu,
        highlight: -1,
        dirty: true
    };

    input.addEventListener('input', () => openCustomDatalist(entry));
    input.addEventListener('keydown', (event) => handleCustomDatalistKeydown(entry, event));
    return entry;
}

function initCustomDropdowns() {
    document.querySelectorAll('select').forEach((select) => upgradeSelectToCustom(select));

    document.querySelectorAll('input[list]').forEach((input) => upgradeDatalistToCustom(input));

document.addEventListener('pointerdown', (event) => {
        const entry = activeCustomSelect;
        if (!entry) return;
        if (entry.root.contains(event.target) || entry.menu.contains(event.target)) return;
        closeCustomSelect();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && activeCustomSelect) closeCustomSelect();
    });

    window.addEventListener('scroll', (event) => {
        const entry = activeCustomSelect;
        if (!entry) return;
        if (entry.menu.contains(event.target)) return;
        closeCustomSelect();
    }, true);
    window.addEventListener('resize', closeCustomSelect);
    window.addEventListener('blur', closeCustomSelect);
}
