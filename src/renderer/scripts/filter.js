const FILTER_POPOVER_GAP = 8;
const FILTER_POPOVER_MARGIN = 8;

function filterPopoverElement() {
    return document.getElementById('filter-popover');
}

function isFilterPopoverOpen() {
    const popover = filterPopoverElement();
    return !!popover && !popover.classList.contains('hidden');
}

function positionFilterPopover() {
    const popover = filterPopoverElement();
    const button = document.getElementById('btn-search-filter');
    if (!popover || !button) return;

    const anchor = button.getBoundingClientRect();
    popover.style.left = '0px';
    popover.style.top = '0px';
    const box = popover.getBoundingClientRect();

    let left = anchor.right + FILTER_POPOVER_GAP;
    if (left + box.width > window.innerWidth - FILTER_POPOVER_MARGIN) {
        left = anchor.left - box.width - FILTER_POPOVER_GAP;
    }
    left = Math.max(FILTER_POPOVER_MARGIN, Math.min(left, window.innerWidth - box.width - FILTER_POPOVER_MARGIN));

    let top = anchor.top;
    top = Math.max(FILTER_POPOVER_MARGIN, Math.min(top, window.innerHeight - box.height - FILTER_POPOVER_MARGIN));

    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
}

function openFilterPopover() {
    const popover = filterPopoverElement();
    if (!popover) return;
    renderFilterPopover();
    popover.classList.remove('hidden');
    positionFilterPopover();
    syncFilterTriggerState();
}

function closeFilterPopover() {
    const popover = filterPopoverElement();
    if (!popover) return;
    popover.classList.add('hidden');
    syncFilterTriggerState();
}

function toggleFilterPopover() {
    if (isFilterPopoverOpen()) {
        closeFilterPopover();
        return;
    }
    openFilterPopover();
}

function syncFilterTriggerState() {
    const button = document.getElementById('btn-search-filter');
    if (!button) return;
    const active = isFilterPopoverOpen()
        || State.currentFilter.startsWith('folder:')
        || State.currentFilter.startsWith('tag:');
    button.classList.toggle('active', active);
    button.setAttribute('aria-expanded', isFilterPopoverOpen() ? 'true' : 'false');
}

function setFilterSelection(kind, value) {
    const next = `${kind}:${value}`;
    State.currentFilter = State.currentFilter === next ? 'all' : next;
    renderApp();
    renderFilterPopover();
}

function clearFilterSelection() {
    State.currentFilter = 'all';
    renderApp();
    renderFilterPopover();
}

function refreshFilterPopoverIfOpen() {
    if (!isFilterPopoverOpen()) return;
    renderFilterPopover();
}

function renderFilterPopover() {
    const folderBox = document.getElementById('filter-folder-chips');
    const tagBox = document.getElementById('filter-tag-chips');
    if (!folderBox || !tagBox) return;

    const folders = Array.isArray(State.folders) ? State.folders : [];
    const tags = typeof getAllTags === 'function' ? getAllTags() : [];

    const folderSignature = `${State.currentFilter}\u0001${folders.join('\u0001')}`;
    if (folderBox.dataset.signature !== folderSignature) {
        folderBox.dataset.signature = folderSignature;
        folderBox.innerHTML = '';
        folders.forEach((folder) => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'filter-chip';
            chip.dataset.kind = 'folder';
            chip.dataset.value = folder;
            chip.innerHTML = `<span class="ms-icon xs">folder</span><span>${escapeHTML(folder)}</span>`;
            chip.onclick = () => setFilterSelection('folder', folder);
            chip.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                showFolderContextMenu(e.clientX, e.clientY, folder);
            });
            folderBox.appendChild(chip);
        });
    }

    const tagSignature = `${State.currentFilter}\u0001${tags.join('\u0001')}`;
    if (tagBox.dataset.signature !== tagSignature) {
        tagBox.dataset.signature = tagSignature;
        tagBox.innerHTML = '';
        if (!tags.length) {
            tagBox.innerHTML = '<span class="filter-empty">还没有任何标签</span>';
        }
        tags.forEach((tag) => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'filter-chip';
            chip.dataset.kind = 'tag';
            chip.dataset.value = tag;
            chip.innerHTML = `<span class="ms-icon xs">sell</span><span>#${escapeHTML(tag)}</span>`;
            chip.onclick = () => setFilterSelection('tag', tag);
            tagBox.appendChild(chip);
        });
    }

    document.querySelectorAll('#filter-popover .filter-chip').forEach((chip) => {
        const value = chip.dataset.value || '';
        const active = chip.dataset.kind === 'folder'
            ? State.currentFilter === `folder:${value}`
            : State.currentFilter === `tag:${value}`;
        chip.classList.toggle('active', active);
        chip.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
}

function initFilterPopover() {
    const filterButton = document.getElementById('btn-search-filter');
    if (filterButton) filterButton.onclick = () => toggleFilterPopover();

    const closeButton = document.getElementById('btn-filter-close');
    if (closeButton) closeButton.onclick = () => closeFilterPopover();

    const clearButton = document.getElementById('btn-filter-all');
    if (clearButton) clearButton.onclick = () => clearFilterSelection();

    document.addEventListener('click', (event) => {
        if (!isFilterPopoverOpen()) return;
        if (event.target.closest('#filter-popover')) return;
        if (event.target.closest('#btn-search-filter')) return;
        closeFilterPopover();
    });

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        if (!isFilterPopoverOpen()) return;
        closeFilterPopover();
    });

    window.addEventListener('resize', () => {
        if (isFilterPopoverOpen()) positionFilterPopover();
    });

    syncFilterTriggerState();
}
