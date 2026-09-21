/* 文件日志（设置 → 数据与存储 → 文件日志）：把服务端那份 journal.log 用起来。

   同步的全部数据都在服务端的一份 append-only 日志里（一行一条 put / del 操作）。
   这里给出两条去路，读取与写盘都在主进程完成（见 src/main/sync_server.js）：

     * 导入文件日志：把日志重放到本地数据目录，等价于「以这份日志为准还原数据」
     * 文件日志转为文件夹：把日志的最终状态摊成一个目录树，不动本地数据目录

   两者都不改动同步进度（已应用到第几号），也不往待推送队列里塞东西：
   它们处理的是「一份本地文件」，而不是一次与服务端的同步。 */

let journalBusy = false;

function setJournalStatus(text, tone) {
    const status = document.getElementById('journal-status');
    if (!status) return;
    status.textContent = text;
    status.dataset.tone = tone || '';
}

function setJournalBusy(busy) {
    journalBusy = busy;
    ['btn-journal-import', 'btn-journal-export'].forEach((id) => {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = busy;
    });
}

function formatJournalSize(bytes) {
    const size = Number(bytes) || 0;
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

// 概览 → 一句话：确认框与状态行共用
function describeJournal(info) {
    const parts = [
        `${info.ops} 条操作（写入 ${info.puts}、删除 ${info.dels}）`,
        `最终 ${info.files} 个文件`,
        formatJournalSize(info.contentBytes)
    ];
    if (info.latestSeq) parts.push(`最新序号 ${info.latestSeq}`);
    if (info.devices && info.devices.length) parts.push(`涉及 ${info.devices.length} 台设备`);
    if (info.invalid) parts.push(`跳过 ${info.invalid} 行无法识别的内容`);
    return parts.join('；');
}

async function pickJournalFile() {
    try {
        const picked = await ipcRenderer.invoke('journal:pick-file');
        if (!picked || picked.canceled || !picked.path) return '';
        return picked.path;
    } catch (err) {
        console.error('打开日志文件选择框失败:', err);
        setJournalStatus('打开文件选择框失败', 'error');
        return '';
    }
}

// 读取日志并回报概览；读不出来时顺手把原因写到状态行
async function inspectJournalFile(filePath) {
    let info = null;
    try {
        info = await ipcRenderer.invoke('journal:inspect', { filePath });
    } catch (err) {
        console.error('读取日志失败:', err);
        setJournalStatus('读取日志失败：与主进程通信异常，请重试', 'error');
        return null;
    }

    if (!info || !info.ok) {
        setJournalStatus(`读不了这份日志：${(info && info.error) || '未返回错误详情'}`, 'error');
        return null;
    }
    return info;
}

/* ---------------- 导入 ---------------- */

async function importJournalFile() {
    if (journalBusy) return;

    const filePath = await pickJournalFile();
    if (!filePath) return;

    setJournalBusy(true);
    setJournalStatus('正在读取日志…');
    try {
        const info = await inspectJournalFile(filePath);
        if (!info) return;

        const confirmed = await showConfirm(`把《${info.fileName}》重放到本地数据？`, {
            title: '导入文件日志',
            detail: `日志：${describeJournal(info)}。\n`
                + '导入按日志内容逐条重放：日志里写过的文件按内容还原，标记为删除的路径在本地同样删除；'
                + '日志里没有提到的文件保持原样（这一点与「首次接入」不同，后者以服务端为准）。\n'
                + '导入不改变同步进度，也不会把内容推给服务端；若日志里含 config.json，本机的偏好设置也会变成日志里的那一份。',
            confirmLabel: '开始导入',
            danger: true
        });
        if (!confirmed) {
            setJournalStatus('已取消导入。');
            return;
        }

        // 编辑器与对话里还没落盘的输入先写回磁盘：导入之后不要再被自动保存覆盖回去
        flushPendingSave();
        flushActiveAiChatSave();

        setJournalStatus('正在重放日志…');
        const result = await ipcRenderer.invoke('journal:import-file', { filePath });
        if (!result || !result.ok) {
            setJournalStatus(`导入失败：${(result && result.error) || '未返回错误详情'}`, 'error');
            return;
        }

        // 本地文件被改过（或删过）了就重新载入一次，界面与磁盘保持一致
        if (result.written || result.deleted) adoptDataDir(DATA_DIR, { message: result.summary });
        const failures = result.errors && result.errors.length
            ? `；有失败项，例如 ${result.errors[0]}`
            : '';
        setJournalStatus(`${result.summary}${failures}`, failures ? 'error' : 'ok');
        showToast(result.summary);
    } catch (err) {
        console.error('导入文件日志失败:', err);
        setJournalStatus('导入失败：与主进程通信异常，请重试', 'error');
    } finally {
        setJournalBusy(false);
    }
}

/* ---------------- 转文件夹 ---------------- */

async function exportJournalFolder() {
    if (journalBusy) return;

    const filePath = await pickJournalFile();
    if (!filePath) return;

    setJournalBusy(true);
    setJournalStatus('正在读取日志…');
    try {
        const info = await inspectJournalFile(filePath);
        if (!info) return;

        const confirmed = await showConfirm(`把《${info.fileName}》摊成一个文件夹？`, {
            title: '文件日志转为文件夹',
            detail: `日志：${describeJournal(info)}。\n`
                + '导出按日志的最终状态写出目录树（notes/、todos/、ai_chats/… 与数据目录同构），'
                + '被删除过的路径不会出现；本地数据目录、同步进度与待推送队列都不受影响。\n'
                + '选一个空文件夹放它：这份目录树可以直接被选成数据存放位置。',
            confirmLabel: '选择导出位置'
        });
        if (!confirmed) {
            setJournalStatus('已取消导出。');
            return;
        }

        let picked = null;
        try {
            picked = await ipcRenderer.invoke('journal:pick-folder');
        } catch (err) {
            console.error('打开文件夹选择框失败:', err);
            setJournalStatus('打开文件夹选择框失败', 'error');
            return;
        }
        if (!picked || picked.canceled || !picked.dir) {
            setJournalStatus('已取消导出。');
            return;
        }

        setJournalStatus('正在导出…');
        const result = await ipcRenderer.invoke('journal:export-folder', { filePath, targetDir: picked.dir });
        if (!result || !result.ok) {
            setJournalStatus(`导出失败：${(result && result.error) || '未返回错误详情'}`, 'error');
            return;
        }

        const failures = result.errors && result.errors.length
            ? `；有失败项，例如 ${result.errors[0]}`
            : '';
        setJournalStatus(`${result.summary}，位置：${result.targetDir}${failures}`, failures ? 'error' : 'ok');
        showToast(`已导出 ${result.files} 个文件`);
    } catch (err) {
        console.error('文件日志转为文件夹失败:', err);
        setJournalStatus('导出失败：与主进程通信异常，请重试', 'error');
    } finally {
        setJournalBusy(false);
    }
}

/* ---------------- 初始化 ---------------- */

function initJournalFileSettings() {
    const importBtn = document.getElementById('btn-journal-import');
    if (importBtn) importBtn.onclick = importJournalFile;

    const exportBtn = document.getElementById('btn-journal-export');
    if (exportBtn) exportBtn.onclick = exportJournalFolder;
}
