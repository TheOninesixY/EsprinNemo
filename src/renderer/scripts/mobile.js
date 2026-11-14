const MOBILE_MEDIA_QUERY = window.matchMedia('(max-width: 860px)');

let mobileInitialized = false;
let mobileResizeTimer = 0;
let mobileTabbarObserver = null;

function isMobileWeb() {
    return document.documentElement.classList.contains('web-mode') && MOBILE_MEDIA_QUERY.matches;
}

function isMobileSheetOpen() {
    const bar = document.getElementById('mobile-tabbar');
    return !!bar && bar.classList.contains('sheet-open');
}

function setMobileSheetOpen(open) {
    const bar = document.getElementById('mobile-tabbar');
    const fab = document.getElementById('btn-mobile-fab');
    if (!bar) return;

    const next = !!open && isMobileWeb();
    bar.classList.toggle('sheet-open', next);
    if (fab) fab.setAttribute('aria-expanded', next ? 'true' : 'false');
}

function updateMobileTabbarHeight() {
    const bar = document.getElementById('mobile-tabbar');
    if (!bar) return;
    const height = Math.round(bar.getBoundingClientRect().height);
    document.documentElement.style.setProperty('--mobile-tabbar-height', `${height}px`);
}

function syncMobileThemeColor() {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    const value = getComputedStyle(document.documentElement).getPropertyValue('--bg-titlebar').trim();
    if (value) meta.setAttribute('content', value);
}

function bindMobileKeyboardInset() {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const apply = () => {
        const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
        document.documentElement.style.setProperty('--keyboard-inset', `${Math.round(inset)}px`);
        document.documentElement.classList.toggle('keyboard-open', isMobileWeb() && inset > 80);
    };

    viewport.addEventListener('resize', apply);
    viewport.addEventListener('scroll', apply);
    apply();
}

function syncMobileNav() {
    const bar = document.getElementById('mobile-tabbar');
    if (!bar) return;

    const trashMode = State.currentFilter === 'trash';
    bar.classList.toggle('trash-mode', trashMode);

    const fab = document.getElementById('btn-mobile-fab');
    if (fab) fab.setAttribute('aria-controls', trashMode ? 'mobile-trash-sheet' : 'mobile-new-sheet');

    const icon = document.getElementById('btn-mobile-fab-icon');
    if (icon) icon.textContent = trashMode ? 'delete_forever' : 'add';

    const current = State.currentFilter.startsWith('folder:') || State.currentFilter.startsWith('tag:')
        ? 'all'
        : State.currentFilter;

    document.querySelectorAll('.mobile-tab[data-filter]').forEach((tab) => {
        tab.classList.toggle('active', tab.getAttribute('data-filter') === current);
    });

    updateMobileTabbarHeight();
}

function applyMobileFilter(filter) {
    if (!filter) return;
    setMobileSheetOpen(false);
    if (typeof flushPendingSave === 'function') flushPendingSave();
    State.currentFilter = filter;
    renderApp();
    const box = document.getElementById('notes-list-box');
    if (box) box.scrollTop = 0;
}

function selectMobileFilter(filter) {
    if (!filter) return;
    setMobileSheetOpen(false);
    if (filter === State.currentFilter) return;
    applyMobileFilter(filter);
}

function hideMobileMoreMenu() {
    const menu = document.getElementById('mobile-more-menu');
    if (menu) menu.classList.add('hidden');
}

function showMobileMoreMenu(anchor) {
    const menu = document.getElementById('mobile-more-menu');
    if (!menu || !anchor) return;

    menu.innerHTML = '';
    const entries = [];

    if (typeof isAiEnabled !== 'function' || isAiEnabled()) {
        entries.push({
            icon: 'chat_bubble',
            label: 'AI 助手',
            run: () => {
                const button = document.getElementById('btn-ai-assistant');
                if (button) button.click();
            }
        });
    }

    entries.push({
        icon: 'search',
        label: '搜索',
        run: () => {
            const input = document.getElementById('input-search');
            if (input) input.focus();
        }
    });

    entries.push({
        icon: 'settings',
        label: '设置',
        run: () => {
            if (typeof openSettingsTab === 'function') openSettingsTab();
        }
    });

    entries.push({
        icon: 'contrast',
        label: '切换主题',
        run: () => {
            const button = document.getElementById('btn-theme-toggle');
            if (button) button.click();
        }
    });

    if (IS_WEB_RUNTIME) {
        entries.push({
            icon: 'fullscreen',
            label: '全屏',
            run: () => {
                const button = document.getElementById('btn-fullscreen');
                if (button) button.click();
            }
        });
    }

    entries.forEach((entry) => {
        const item = document.createElement('div');
        item.className = 'context-menu-item';

        const icon = document.createElement('span');
        icon.className = 'ms-icon sm';
        icon.textContent = entry.icon;

        const label = document.createElement('span');
        label.textContent = entry.label;

        item.append(icon, label);
        item.onclick = () => {
            hideMobileMoreMenu();
            entry.run();
        };
        menu.appendChild(item);
    });

    menu.style.left = '0px';
    menu.style.top = '0px';
    menu.classList.remove('hidden');

    const rect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const left = Math.max(4, Math.min(rect.right - menuRect.width, window.innerWidth - menuRect.width - 4));
    const top = Math.max(4, Math.min(rect.bottom + 4, window.innerHeight - menuRect.height - 4));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
}

function applyEditorActionsPlacement() {
    const actions = document.querySelector('.editor-actions');
    const topbar = document.getElementById('editor-topbar');
    const footer = document.querySelector('.editor-footer');
    if (!actions || !topbar || !footer) return;

    if (isMobileWeb()) {
        if (actions.parentElement !== footer) footer.appendChild(actions);
    } else if (actions.parentElement !== topbar) {
        topbar.appendChild(actions);
    }
}

function handleMobileViewportChange() {
    updateMobileTabbarHeight();
    applyEditorActionsPlacement();

    if (!isMobileWeb()) {
        setMobileSheetOpen(false);
        hideMobileMoreMenu();
        const noteMenu = document.getElementById('note-context-menu');
        const folderMenu = document.getElementById('folder-context-menu');
        if (noteMenu && !noteMenu.classList.contains('hidden') && typeof hideContextMenu === 'function') hideContextMenu();
        if (folderMenu && !folderMenu.classList.contains('hidden') && typeof hideFolderContextMenu === 'function') hideFolderContextMenu();
    }
}

function bindMobileFilterSwipe() {
    let startX = 0;
    let startY = 0;
    let tracking = false;
    let axis = '';

    document.addEventListener('touchstart', (event) => {
        if (!isMobileWeb() || event.touches.length !== 1) return;
        const target = event.target;
        if (!(target instanceof Element) || !target.closest('.notes-panel')) return;
        if (target.closest('button, input, textarea, select')) return;

        tracking = true;
        axis = '';
        startX = event.touches[0].clientX;
        startY = event.touches[0].clientY;
    }, { passive: true });

    document.addEventListener('touchmove', (event) => {
        if (!tracking) return;
        const touch = event.touches[0];
        const dx = touch.clientX - startX;
        const dy = touch.clientY - startY;

        if (!axis) {
            if (Math.abs(dy) > 30) {
                tracking = false;
                return;
            }
            if (Math.abs(dx) < 8) return;
            axis = 'x';
        }
    }, { passive: true });

    document.addEventListener('touchend', (event) => {
        if (!tracking) return;
        tracking = false;
        if (axis !== 'x') return;

        const dx = event.changedTouches[0].clientX - startX;
        if (Math.abs(dx) < 48) return;

        const filters = ['all', 'todos', 'trash'];
        const from = filters.indexOf(State.currentFilter);
        if (from === -1) return;

        const next = filters[from + (dx < 0 ? 1 : -1)];
        if (next) selectMobileFilter(next);
    }, { passive: true });

    document.addEventListener('touchcancel', () => {
        tracking = false;
        axis = '';
    }, { passive: true });
}

function bindMobileEvents() {
    const bar = document.getElementById('mobile-tabbar');
    const fab = document.getElementById('btn-mobile-fab');
    if (fab) fab.onclick = () => setMobileSheetOpen(!isMobileSheetOpen());

    document.querySelectorAll('.mobile-tab[data-filter]').forEach((tab) => {
        tab.onclick = () => selectMobileFilter(tab.getAttribute('data-filter'));
    });

    const newNote = document.getElementById('mobile-new-note');
    if (newNote) {
        newNote.onclick = () => {
            setMobileSheetOpen(false);
            createNewNote();
        };
    }

    const newTodo = document.getElementById('mobile-new-todo');
    if (newTodo) {
        newTodo.onclick = () => {
            setMobileSheetOpen(false);
            createNewTodo();
        };
    }

    const trashClear = document.getElementById('mobile-trash-clear');
    if (trashClear) {
        trashClear.onclick = () => {
            setMobileSheetOpen(false);
            clearTrash();
        };
    }

    const trashCancel = document.getElementById('mobile-trash-cancel');
    if (trashCancel) trashCancel.onclick = () => setMobileSheetOpen(false);

    const sheetMask = document.getElementById('mobile-sheet-mask');
    if (sheetMask) {
        sheetMask.onclick = () => {
            setMobileSheetOpen(false);
            hideMobileMoreMenu();
            if (typeof hideContextMenu === 'function') hideContextMenu();
            if (typeof hideFolderContextMenu === 'function') hideFolderContextMenu();
        };
    }

    const aiMask = document.getElementById('mobile-ai-mask');
    if (aiMask) {
        aiMask.onclick = () => {
            if (typeof setAiPanelOpen === 'function') setAiPanelOpen(false);
        };
    }

    const searchMask = document.getElementById('mobile-search-mask');
    if (searchMask) {
        searchMask.onclick = () => {
            const input = document.getElementById('input-search');
            if (input && document.activeElement === input) input.blur();
        };
    }

    const mobileMenu = document.getElementById('btn-mobile-menu');
    if (mobileMenu) {
        mobileMenu.onclick = (event) => {
            event.stopPropagation();
            const menu = document.getElementById('mobile-more-menu');
            if (menu && !menu.classList.contains('hidden')) {
                hideMobileMoreMenu();
                return;
            }
            setMobileSheetOpen(false);
            if (typeof hideContextMenu === 'function') hideContextMenu();
            if (typeof hideFolderContextMenu === 'function') hideFolderContextMenu();
            showMobileMoreMenu(mobileMenu);
        };
    }

    const editorBack = document.getElementById('btn-editor-back');
    if (editorBack) {
        editorBack.onclick = () => {
            const back = document.getElementById('btn-tabs-back');
            if (back) back.click();
        };
    }

    const editorAi = document.getElementById('btn-editor-ai');
    if (editorAi) {
        editorAi.onclick = () => {
            if (typeof toggleAiAssistant === 'function') toggleAiAssistant();
        };
    }

    document.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (!target.closest('#mobile-more-menu') && !target.closest('#btn-mobile-menu')) {
            hideMobileMoreMenu();
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || !isMobileWeb()) return;

        const menu = document.getElementById('mobile-more-menu');
        if (menu && !menu.classList.contains('hidden')) {
            hideMobileMoreMenu();
            return;
        }
        if (isMobileSheetOpen()) {
            setMobileSheetOpen(false);
            return;
        }

        const noteMenu = document.getElementById('note-context-menu');
        const folderMenu = document.getElementById('folder-context-menu');
        if ((noteMenu && !noteMenu.classList.contains('hidden')) || (folderMenu && !folderMenu.classList.contains('hidden'))) {
            if (typeof hideContextMenu === 'function') hideContextMenu();
            if (typeof hideFolderContextMenu === 'function') hideFolderContextMenu();
            return;
        }

        const settingsView = document.getElementById('settings-view');
        if (settingsView && !settingsView.classList.contains('hidden') && settingsView.classList.contains('is-subpage')) {
            if (typeof setSettingsSubpageOpen === 'function') setSettingsSubpageOpen(false);
            return;
        }

        if (State.activeNoteId) {
            const back = document.getElementById('btn-tabs-back');
            if (back) back.click();
        }
    });

    window.addEventListener('resize', () => {
        clearTimeout(mobileResizeTimer);
        mobileResizeTimer = setTimeout(handleMobileViewportChange, 80);
    });

    if (typeof ResizeObserver === 'function' && bar) {
        mobileTabbarObserver = new ResizeObserver(() => updateMobileTabbarHeight());
        mobileTabbarObserver.observe(bar);
    }
}

function initMobile() {
    if (mobileInitialized) return;
    mobileInitialized = true;

    bindMobileEvents();
    bindMobileFilterSwipe();
    bindMobileKeyboardInset();
    applyEditorActionsPlacement();
    syncMobileThemeColor();
    syncMobileNav();

    if (typeof MOBILE_MEDIA_QUERY.addEventListener === 'function') {
        MOBILE_MEDIA_QUERY.addEventListener('change', handleMobileViewportChange);
    }

    if (typeof MutationObserver === 'function') {
        new MutationObserver(syncMobileThemeColor).observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['class', 'style', 'data-theme-style']
        });
    }
}

window.addEventListener('load', () => {
    if (typeof initMobile === 'function') initMobile();
});
