/* 自绘下拉菜单：弹出层由界面自己绘制，不再使用 Chromium 原生 <select> 的下拉列表，
   输入框 + <datalist> 的候选列表（设置 → AI 助手 → 模型）同样走这里。

   原生 <select> / <datalist> 仍留在页面里（见 styles/dropdown.css 的 .dropdown-source），
   继续充当数据源与事件源——选项、value、change 事件都照旧，因此其他脚本里的
   `select.value = ...` 与 `select.onchange` 都不需要改动：
   升级时会把原生 value / selectedIndex 的访问器包一层，程序化赋值同样能刷新自绘界面。

   用法：启动时调用一次 initCustomDropdowns()，主窗口里的下拉与候选列表都会升级。 */

// 已升级的下拉：{ select, root, trigger, label, menu, highlight, dirty }
const CUSTOM_SELECTS = [];
// 同时最多展开一个下拉
let activeCustomSelect = null;

// 原生 value / selectedIndex 的访问器：升级时包装到具体元素上，用于感知程序化赋值
const NATIVE_SELECT_VALUE = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
const NATIVE_SELECT_INDEX = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');

// 触发器上显示的文字：当前选中项的文本（原生 select 没有选中项时为空）
function customSelectLabelText(select) {
    const option = select.selectedIndex >= 0 ? select.options[select.selectedIndex] : null;
    return option ? (option.textContent || '').trim() : '';
}

// 菜单里可键盘高亮的选项（跳过禁用项）
function customSelectOptions(entry) {
    return Array.from(entry.menu.querySelectorAll('.dropdown-option')).filter((option) => !option.disabled);
}

function createCustomSelectOption(entry, option) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dropdown-option';
    button.dataset.value = option.value;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', 'false');
    button.disabled = !!option.disabled;

    // 文字靠左顶格，选中标记贴右边（未选中时占位隐藏，右边界保持对齐）
    const text = document.createElement('span');
    text.className = 'dropdown-option-text';
    text.textContent = (option.textContent || '').trim();

    const check = document.createElement('span');
    check.className = 'ms-icon xs dropdown-check';
    check.textContent = 'check';

    button.append(text, check);
    button.onclick = () => chooseCustomSelectValue(entry, option.value);
    return button;
}

// 按当前选项重建菜单内容（optgroup 渲染为分组标题）
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
                menu.appendChild(createCustomSelectOption(entry, option));
            });
            return;
        }
        if (child.tagName === 'OPTION') {
            menu.appendChild(createCustomSelectOption(entry, child));
        }
    });
    entry.dirty = false;
}

// 自绘界面与原生 select 对齐：显示文字、选中态、禁用态
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

// 菜单贴着触发器左对齐展开（下方放不下就翻到上方，仅当右边界超出窗口时才向左让位）
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
    // 菜单至少与触发器同宽，触发器很窄（如列表排序）时也留出可读的宽度
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
        // 还没高亮过：先把高亮落到当前选中项上，这样打开后按方向键不会跳档
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

    // 选项可能在两次展开之间变过（字体列表异步载入、文件夹列表重建），按需重建一次
    if (entry.dirty || !entry.menu.childElementCount) buildCustomSelectMenu(entry);
    refreshCustomSelect(entry);

    entry.menu.hidden = false;
    entry.root.classList.add('open');
    entry.trigger.setAttribute('aria-expanded', 'true');
    activeCustomSelect = entry;

    // 先展开再量尺寸，得到真实高度后才能判断向上还是向下
    positionCustomSelectMenu(entry);
    // 打开时不给选中项铺底色（选中状态靠强调色文字 + 右侧勾选标记表示），
    // 键盘高亮留到按方向键时再出现
    entry.highlight = -1;
}

function toggleCustomSelect(entry) {
    if (activeCustomSelect === entry) closeCustomSelect();
    else openCustomSelect(entry);
}

// 选中某一项：写回原生 select（走包装后的 setter），再补上原生组件会派发的 input / change
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

// Enter / Space：有高亮的项就选它，没有则等同确认当前选中项（不改设置，只收起菜单）
function confirmCustomSelectValue(entry, options) {
    const highlighted = entry.highlight >= 0 ? options[entry.highlight] : null;
    const target = highlighted || options.find((option) => option.classList.contains('active'));
    if (target) chooseCustomSelectValue(entry, target.dataset.value);
    else closeCustomSelect();
}

function handleCustomSelectKeydown(entry, event) {
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

// 把一个原生 <select> 升级成自绘下拉（同一个 select 只升级一次）
function upgradeSelectToCustom(select) {
    if (!select || select.dataset.customDropdown === '1') return null;

    const root = document.createElement('div');
    root.className = 'dropdown';

    // 触发器沿用原生 select 的类名：边框、内边距、圆角等既有样式自动生效
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
    arrow.className = 'ms-icon xs dropdown-arrow';
    arrow.textContent = 'expand_more';
    trigger.append(label, arrow);

    const menu = document.createElement('div');
    menu.className = 'dropdown-menu';
    menu.setAttribute('role', 'listbox');
    menu.hidden = true;
    // 挂在 <body> 下：菜单用 fixed 定位，放在页面里会被可滚动的设置面板裁掉，
    // 也可能被祖先的 transform 改变定位基准
    document.body.appendChild(menu);

    // 原生 select 退到触发器之下：不再绘制、不再抢焦点，但仍是数据源与事件源
    select.dataset.customDropdown = '1';
    select.classList.add('dropdown-source');
    select.setAttribute('tabindex', '-1');
    select.parentNode.insertBefore(root, select);
    root.append(trigger, select);

    const entry = { select, root, trigger, label, menu, highlight: -1, dirty: false };

    trigger.addEventListener('click', (event) => {
        event.preventDefault();
        toggleCustomSelect(entry);
    });
    trigger.addEventListener('keydown', (event) => handleCustomSelectKeydown(entry, event));

    // 程序化赋值（select.value = ...）也要即时刷新自绘界面
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

    // 选项变动（字体列表异步载入、文件夹列表重建）与禁用态变化都要跟上
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

/* 输入框 + <datalist> 的候选列表（设置 → AI 助手 → 模型）：同样不用 Chromium 自带的候选弹层。
   <datalist> 仍留在页面里作为候选数据源，输入框照旧可以自由填写；
   输入内容或按 ↓ 时弹出匹配的候选，↑ / ↓ 选择、Enter 填入、Esc 收起。 */

// 候选最多渲染这么多条：模型列表可能很长，挑得到即可
const DATALIST_SUGGEST_LIMIT = 100;

function customDatalistMatches(entry) {
    const keyword = (entry.input.value || '').trim().toLowerCase();
    const values = Array.from(entry.list.options)
        .map((option) => option.value)
        .filter((value) => !!value);
    const matched = keyword ? values.filter((value) => value.toLowerCase().includes(keyword)) : values;
    return matched.slice(0, DATALIST_SUGGEST_LIMIT);
}

// 按当前输入重建候选，返回是否还有可展示的候选
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
    // 已经在展开中（继续输入）：只换内容与位置，不重新展开，免得每次都重放淡入动画
    if (!wasOpen) {
        closeCustomSelect();
        entry.menu.hidden = false;
        entry.input.setAttribute('aria-expanded', 'true');
        activeCustomSelect = entry;
    }
    // 先展开再量尺寸：候选项按输入框宽度铺开
    positionCustomSelectMenu(entry);
}

function chooseCustomDatalistValue(entry, value) {
    entry.input.value = value;
    entry.input.focus();
    // 走一遍 input / change：设置页原有的保存逻辑照常执行（期间可能重开菜单，随后统一收起）
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
        // 有高亮的候选项就填进去；否则保持输入框内容、直接收起
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

// 把「输入框 + datalist」升级为自绘候选列表
function upgradeDatalistToCustom(input) {
    const listId = input.getAttribute('list');
    const list = listId ? document.getElementById(listId) : null;
    if (!list || input.dataset.customDatalist === '1') return null;

    input.dataset.customDatalist = '1';
    // 关掉 Chromium 自带的候选弹层；<datalist> 留在页面里继续充当候选数据源
    input.removeAttribute('list');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('aria-haspopup', 'listbox');
    input.setAttribute('aria-expanded', 'false');

    const menu = document.createElement('div');
    menu.className = 'dropdown-menu';
    menu.setAttribute('role', 'listbox');
    menu.hidden = true;
    // 按住候选项时不让输入框失焦，否则点击还没生效菜单就先关了
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

// 把主窗口里的原生 select 统一升级为自绘下拉，并接上关闭时机
function initCustomDropdowns() {
    document.querySelectorAll('select').forEach((select) => upgradeSelectToCustom(select));
    // 输入框 + <datalist> 的候选列表（设置 → AI 助手 → 模型）同样自绘
    document.querySelectorAll('input[list]').forEach((input) => upgradeDatalistToCustom(input));

    // 点空白处 / 按 Esc 收起
    document.addEventListener('pointerdown', (event) => {
        const entry = activeCustomSelect;
        if (!entry) return;
        if (entry.root.contains(event.target) || entry.menu.contains(event.target)) return;
        closeCustomSelect();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && activeCustomSelect) closeCustomSelect();
    });
    // 触发器等被滚动带离原位、窗口尺寸变化或失去焦点时，菜单不再贴着触发器，直接收起
    window.addEventListener('scroll', (event) => {
        const entry = activeCustomSelect;
        if (!entry) return;
        if (entry.menu.contains(event.target)) return;
        closeCustomSelect();
    }, true);
    window.addEventListener('resize', closeCustomSelect);
    window.addEventListener('blur', closeCustomSelect);
}
