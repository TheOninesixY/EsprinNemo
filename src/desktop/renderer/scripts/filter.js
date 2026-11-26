function filterDrawerElement() {
    return document.getElementById('filter-drawer');
}

function isFilterDrawerOpen() {
    const drawer = filterDrawerElement();
    return !!drawer && drawer.classList.contains('open');
}

function openFilterDrawer() {
    const drawer = filterDrawerElement();
    if (!drawer) return;
    renderFilterDrawer();
    drawer.classList.add('open');
}

function closeFilterDrawer() {
    const drawer = filterDrawerElement();
    if (!drawer) return;
    drawer.classList.remove('open');
}

function filterRefinementLabel() {
    const parts = [];
    if (State.filterFolder) parts.push(State.filterFolder);
    if (State.filterTag) parts.push(`#${State.filterTag}`);
    return parts.length ? ` · ${parts.join(' · ')}` : '';
}

function setFilterSelection(kind, value) {
    if (kind === 'folder') {
        State.filterFolder = State.filterFolder === value ? '' : value;
    } else {
        State.filterTag = State.filterTag === value ? '' : value;
    }
    renderApp();
    renderFilterDrawer();
}

function refreshFilterDrawerIfOpen() {
    if (!isFilterDrawerOpen()) return;
    renderFilterDrawer();
}

function renderFilterDrawer() {
    const folderBox = document.getElementById('filter-folder-chips');
    const tagBox = document.getElementById('filter-tag-chips');
    if (!folderBox || !tagBox) return;

    const folders = Array.isArray(State.folders) ? State.folders : [];
    const tags = typeof getAllTags === 'function' ? getAllTags() : [];

    const folderSignature = `${State.filterFolder}\u0001${folders.join('\u0001')}`;
    if (folderBox.dataset.signature !== folderSignature) {
        folderBox.dataset.signature = folderSignature;
        folderBox.innerHTML = '';
        folders.forEach((folder) => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'filter-chip';
            chip.dataset.kind = 'folder';
            chip.dataset.value = folder;
            chip.innerHTML = `<span class="icon xs" data-lucide="folder" aria-hidden="true"></span><span>${escapeHTML(folder)}</span>`;
            chip.onclick = () => setFilterSelection('folder', folder);
            chip.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                showFolderContextMenu(e.clientX, e.clientY, folder);
            });
            folderBox.appendChild(chip);
        });
    }

    const tagSignature = `${State.filterTag}\u0001${tags.join('\u0001')}`;
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
            chip.innerHTML = `<span class="icon xs" data-lucide="tag" aria-hidden="true"></span><span>#${escapeHTML(tag)}</span>`;
            chip.onclick = () => setFilterSelection('tag', tag);
            tagBox.appendChild(chip);
        });
    }

    document.querySelectorAll('#filter-drawer .filter-chip').forEach((chip) => {
        const value = chip.dataset.value || '';
        const active = chip.dataset.kind === 'folder'
            ? State.filterFolder === value
            : State.filterTag === value;
        chip.classList.toggle('active', active);
        chip.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
}

function initFilterDrawer() {
    const searchInput = document.getElementById('input-search');
    if (searchInput) {
        searchInput.addEventListener('focus', () => openFilterDrawer());
    }

    document.addEventListener('mousedown', (event) => {
        if (!isFilterDrawerOpen()) return;
        if (event.target.closest('#filter-drawer')) return;
        if (event.target.closest('.notes-panel-search-row')) return;
        closeFilterDrawer();
    });

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        if (!isFilterDrawerOpen()) return;
        closeFilterDrawer();
    });
}
