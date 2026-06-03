(function () {
  'use strict';

  // === State ===
  let riskMap = {};
  let currentModule = null;
  let currentAction = null; // 'dry-run' | 'run'
  const runningControllers = {}; // module -> AbortController
  const runningStates = {};      // module -> { active: bool, elapsedInterval: id }

  // Cached data across navigations
  const _cache = {
    status: null,        // { data, timestamp }
    analyze: null,       // { data, timestamp }
    history: null,       // { data, timestamp }
    'dry-run': {},       // module -> [lines]
  };

  // === DOM refs ===
  const $ = (id) => document.getElementById(id);
  const titlebarTitle = document.querySelector('.titlebar-title');
  const navItems = document.querySelectorAll('.nav-item');
  const themeToggle = $('theme-toggle');
  const statusbarStatus = $('statusbar-status');
  const statusbarDisk = $('statusbar-disk');
  const overlay = $('risk-overlay');
  const sheetTitle = $('sheet-title');
  const sheetRiskLabel = $('sheet-risk-label');
  const sheetAffects = $('sheet-affects');
  const sheetSafezones = $('sheet-safezones');
  const sheetConsent = $('risk-consent');
  const sheetCancel = $('sheet-cancel');
  const sheetConfirm = $('sheet-confirm');
  const infoDesc = $('info-desc');
  const infoRisk = $('info-risk');
  const riskIndicator = $('risk-indicator');
  const riskAffects = $('risk-affects');
  const riskSafezones = $('risk-safezones');

  // === Module Metadata ===
  const MODULES = {
    status:  { label: '🩺 系统健康',   risk: 'none',   writable: false, interactive: false },
    clean:   { label: '🧹 深度清理',   risk: 'medium', writable: true, interactive: true },
    uninstall:{ label: '🗑️ 卸载应用',  risk: 'high',   writable: true, interactive: true },
    purge:   { label: '🏗️ 构建产物',   risk: 'low',    writable: true,  interactive: true },
    optimize:{ label: '⚙️ 系统优化',   risk: 'medium', writable: true,  interactive: false },
    installer:{ label: '🗂️ 安装包清理',risk: 'low',    writable: true,  interactive: true },
    analyze: { label: '📊 磁盘分析',   risk: 'none',   writable: false, interactive: false },
    history: { label: '📋 操作历史',   risk: 'none',   writable: false, interactive: false },
  };

  // Modules that benefit from dry-run parsing
  const PARSE_MODULES = ['clean', 'purge', 'installer'];

  // === Theme ===
  function loadTheme() {
    const saved = localStorage.getItem('mole-theme');
    if (saved === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
      themeToggle.textContent = '☀️';
    } else {
      document.documentElement.removeAttribute('data-theme');
      themeToggle.textContent = '🌙';
    }
  }

  function toggleTheme() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (isDark) {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem('mole-theme', 'light');
      themeToggle.textContent = '🌙';
    } else {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('mole-theme', 'dark');
      themeToggle.textContent = '☀️';
    }
  }

  themeToggle.addEventListener('click', toggleTheme);
  loadTheme();

  // === Nav Item Click Handler ===
  navItems.forEach(function(item) {
    item.addEventListener('click', function(e) {
      e.preventDefault();
      var mod = this.dataset.module;
      if (mod) {
        navigate('#' + mod);
        if (location.hash !== '#' + mod) {
          location.hash = '#' + mod;
        }
      }
    });
  });

  // === Risk Map Load ===
  async function loadRiskMap() {
    try {
      const res = await fetch('/api/risk-map');
      riskMap = await res.json();
    } catch (e) {
      console.warn('Failed to load risk map:', e);
    }
  }

  // === Info Panel ===
  function updateInfoPanel(module) {
    const meta = MODULES[module];
    if (!meta) return;
    infoDesc.textContent = getModuleDesc(module);

    const risk = riskMap[module];
    if (risk) {
      infoRisk.classList.remove('hidden');
      riskIndicator.textContent = risk.risk_label;
      riskIndicator.style.background = risk.color + '22';
      riskIndicator.style.color = risk.color;

      riskAffects.innerHTML = '';
      risk.affects.forEach(a => {
        const li = document.createElement('li');
        li.textContent = a;
        riskAffects.appendChild(li);
      });

      riskSafezones.innerHTML = '';
      risk.safe_zones.forEach(z => {
        const li = document.createElement('li');
        li.textContent = z;
        riskSafezones.appendChild(li);
      });
    } else {
      infoRisk.classList.add('hidden');
    }
  }

  function getModuleDesc(module) {
    const descs = {
      status:    '检查系统磁盘使用、内存、CPU 状态。只读操作，不修改任何文件。',
      clean:     '清理系统缓存、用户缓存、浏览器缓存、日志等。缓存会自动重建。',
      uninstall: '彻底卸载应用及所有残留数据。此操作不可恢复，请谨慎使用。',
      purge:     '清理 node_modules、target、build 等构建产物。可被包管理器重建。',
      optimize:  '刷新系统服务、重置 DNS 缓存。执行期间可能短暂卡顿。',
      installer: '清理已下载的 .dmg / .pkg 安装包。不影响已安装的应用。',
      analyze:   '扫描磁盘使用情况，分析大文件和可清理空间。只读操作。',
      history:   '查看历史操作记录（来自 mole）。',
    };
    return descs[module] || '';
  }

  // === Navigation ===
  function navigate(hash) {
    var module = (hash || '').replace('#', '') || '';
    // Empty module means welcome page
    if (!module) {
      navItems.forEach(function(item) { item.classList.remove('active'); });
      document.querySelectorAll('.page').forEach(function(p) { p.classList.add('hidden'); });
      var welcome = document.getElementById('page-placeholder');
      if (welcome) welcome.classList.remove('hidden');
      titlebarTitle.textContent = 'MacCleaner';
      setStatusbar('就绪', '');
      return;
    }
    if (!MODULES[module]) return;

    currentModule = module;

    navItems.forEach(item => {
      item.classList.toggle('active', item.dataset.module === module);
    });

    document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
    const page = $('page-' + module);
    if (page) page.classList.remove('hidden');

    titlebarTitle.textContent = 'MacCleaner — ' + MODULES[module].label;

    updateInfoPanel(module);
    setStatusbar(MODULES[module].label, '');
    loadPageData(module);

    if (page) page.scrollTop = 0;
  }

  window.addEventListener('hashchange', function () {
    navigate(location.hash);
  });

  // === Welcome Card Click Handler ===
  document.addEventListener('click', function (e) {
    var card = e.target.closest('.welcome-card');
    if (!card) return;
    var mod = card.dataset.module;
    if (mod) location.hash = '#' + mod;
  });

  // === Page Data Loading ===
  function loadPageData(module) {
    if (module === 'status') {
      // Use cache if available
      if (_cache.status) {
        renderStatusData($('status-body'), _cache.status);
      } else {
        fetchStatus();
      }
    } else if (module === 'analyze') {
      if (_cache.analyze) {
        renderAnalyzeData($('analyze-body'), _cache.analyze);
      } else {
        fetchAnalyze();
      }
    } else if (module === 'history') {
      if (_cache.history) {
        renderHistoryData($('history-body'), _cache.history);
      } else {
        fetchHistory();
      }
    } else if (module === 'uninstall') {
      loadUninstallList();
    } else if (PARSE_MODULES.includes(module)) {
      // Show cached dry-run results if available
      renderInteractiveModule(module);
    }
  }

  // === Interactive Modules (clean/purge/installer) ===
  let _moduleItems = {};  // module -> [{name, size, path, selected}]

  function renderInteractiveModule(module) {
    const body = document.getElementById('output-' + module);
    if (!body) return;
    const items = _moduleItems[module] || null;

    // Show scan button area
    const scanArea = document.getElementById('interactive-header-' + module);
    if (!items || items.length === 0) {
      if (scanArea) scanArea.style.display = '';
    }

    // If no parsed items, just show text output
    if (!items || items.length === 0) return;

    renderParsedItems(module, items);
  }

  function renderParsedItems(module, items) {
    const body = document.getElementById('output-' + module);
    if (!body) return;
    const totalSize = items.reduce((s, i) => s + parseSize(i.size), 0);
    const selectedCount = items.filter(i => i.selected !== false).length;

    let html = '<div class="module-items-header">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">';
    html += '<span style="font-weight:600;font-size:14px">📋 共发现 ' + items.length + ' 项</span>';
    html += '<span style="font-size:13px;color:var(--text-secondary)">总计 ' + formatBytes(totalSize) + '</span>';
    html += '</div>';

    // For modules that support selective action (like installer with checkboxes)
    if (MODULES[module] && MODULES[module].interactive) {
      html += '<div class="module-items-actions" style="margin-bottom:8px">';
      html += '<label style="font-size:13px;display:flex;align-items:center;gap:6px">';
      html += '<input type="checkbox" onchange="toggleAllItems(\'' + module + '\', this.checked)" checked>';
      html += '全选/取消</label>';
      html += '</div>';
    }
    html += '</div>';

    html += '<div class="module-items-list" style="max-height:400px;overflow-y:auto;border:1px solid var(--border-subtle);border-radius:8px">';

    // Render each item
    items.forEach(function(item, idx) {
      const selected = item.selected !== false;
      const sizeStr = item.size || '--';
      const checked = selected ? 'checked' : '';
      html += '<div class="module-item" data-module="' + module + '" data-index="' + idx + '" style="display:flex;align-items:center;padding:8px 12px;border-bottom:1px solid var(--border-subtle);font-size:13px">';
      if (MODULES[module].interactive) {
        html += '<input type="checkbox" class="item-checkbox" ' + checked + ' onchange="toggleModuleItem(\'' + module + '\',' + idx + ',this.checked)" style="margin-right:10px">';
      }
      html += '<span style="flex:1">' + escapeHtml(item.name || '') + '</span>';
      if (item.path && item.path !== item.name) {
        html += '<span style="font-size:11px;color:var(--text-tertiary);margin:0 12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(item.path) + '</span>';
      }
      html += '<span class="item-size" style="color:var(--text-secondary);white-space:nowrap;min-width:70px;text-align:right">' + sizeStr + '</span>';
      html += '</div>';
    });

    html += '</div>';

    // Summary + action
    html += '<div class="module-items-footer" style="display:flex;justify-content:space-between;align-items:center;margin-top:12px">';
    html += '<span style="font-size:13px;color:var(--text-secondary)">已选 ' + selectedCount + ' / ' + items.length + ' 项</span>';
    html += '<button class="btn btn-primary" onclick="executeModuleAction(\'' + module + '\')">⚡ 执行清理</button>';
    html += '</div>';

    body.innerHTML = html;
  }

  function toggleAllItems(module, checked) {
    if (!_moduleItems[module]) return;
    _moduleItems[module].forEach(function(item) {
      item.selected = checked;
    });
    renderParsedItems(module, _moduleItems[module]);
  }

  function toggleModuleItem(module, index, checked) {
    if (!_moduleItems[module] || !_moduleItems[module][index]) return;
    _moduleItems[module][index].selected = checked;
    renderParsedItems(module, _moduleItems[module]);
  }

  function executeModuleAction(module) {
    // For installer/purge: bypass mo CLI TUI entirely, use direct file deletion
    if (module === 'installer' || module === 'purge') {
      var items = _moduleItems[module] || [];
      var selectedItems = items.filter(function(i) { return i.selected !== false; });
      // Filter out items with empty or invalid paths
      selectedItems = selectedItems.filter(function(i) { return i.path && i.path.trim() !== ''; });
      if (selectedItems.length === 0) {
        setStatusbar('没有选中要清理的项目', 'error');
        return;
      }
      // Always use direct deletion - backend will resolve paths
      executeModuleDeleteStream(module, selectedItems);
      return;
    }
    // Default: execute via mo CLI
    executeAction(module, 'run');
  }

  async function executeModuleDeleteStream(module, items) {
    var outputEl = document.getElementById('output-' + module);
    if (!outputEl) return;
    outputEl.innerHTML = '';

    var controller = new AbortController();
    runningControllers[module] = controller;
    showProgressIndicator(module);
    addStopButton(module);

    // Disable buttons
    var btnDry = document.querySelector('.btn[data-module="' + module + '"][data-action="dry-run"]');
    var btnRun = document.querySelector('.btn[data-module="' + module + '"][data-action="run"]');
    if (btnDry) btnDry.disabled = true;
    if (btnRun) btnRun.disabled = true;

    try {
      var res = await fetch('/api/module/delete-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ module: module, items: items }),
        signal: controller.signal,
      });
      if (!res.ok) {
        outputEl.innerHTML += '<div class="line-stderr">❌ HTTP ' + res.status + '</div>';
        cleanup(module);
        setStatusbar('删除失败', 'error');
        return;
      }

      var decoder = new TextDecoder();
      var reader = res.body.getReader();
      var buffer = '';

      function readStream() {
        reader.read().then(function(result) {
          if (result.done) {
            // Process remaining buffer
            if (buffer.trim()) {
              var parts = buffer.split('\n\n');
              for (var pi = 0; pi < parts.length; pi++) {
                if (parts[pi].trim()) processSSEEvent(outputEl, parts[pi]);
              }
            }
            // Parse exit code from done event
            var exitCode = 0;
            var summaryText = '';
            if (buffer.trim()) {
              var lines = buffer.split('\n\n');
              for (var li = 0; li < lines.length; li++) {
                if (lines[li].startsWith('data: ')) {
                  try {
                    var doneData = JSON.parse(lines[li].slice(6));
                    if (doneData.exit_code !== undefined) exitCode = doneData.exit_code;
                    if (doneData.summary) summaryText = doneData.summary;
                  } catch(e) {}
                }
              }
            }
            // Clear module items after successful deletion
            _moduleItems[module] = null;
            if (exitCode === 0) {
              setStatusbar(summaryText || (module === 'installer' ? '安装包清理完成' : '构建产物清理完成'), 'success');
            } else if (exitCode === -1) {
              setStatusbar('已取消', '');
            } else {
              setStatusbar(summaryText || '执行失败', 'error');
            }
            cleanup(module);
            return;
          }

          buffer += decoder.decode(result.value, { stream: true });
          var parts = buffer.split('\n\n');
          buffer = parts.pop() || '';

          for (var pi = 0; pi < parts.length; pi++) {
            processSSEEvent(outputEl, parts[pi]);
          }

          readStream();
        }).catch(function(err) {
          if (err.name === 'AbortError') {
            outputEl.innerHTML += '<div class="line-stderr">⏹️ 已手动停止</div>';
            setStatusbar('已停止', '');
          } else {
            outputEl.innerHTML += '<div class="line-stderr">❌ 读取错误: ' + err.message + '</div>';
            setStatusbar('读取错误', 'error');
          }
          cleanup(module);
        });
      }

      readStream();
    } catch (err) {
      if (err.name === 'AbortError') {
        outputEl.innerHTML += '<div class="line-stderr">⏹️ 已手动停止</div>';
        setStatusbar('已停止', '');
      } else {
        outputEl.innerHTML += '<div class="line-stderr">❌ 连接失败: ' + err.message + '</div>';
        setStatusbar('连接失败', 'error');
      }
      cleanup(module);
    }
  }

  // === ANSI stripping and output parsing ===
  function stripAnsi(str) {
    return str.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '').replace(/\u001b\][0-9;]*[^\u001b]*(\u001b\\)?/g, '').replace(/\r/g, '').trim();
  }

  function parseDryRunOutput(module, lines) {
    // Parse the SSE output lines to extract items
    const items = [];
    const seen = new Set();

    for (const raw of lines) {
      // Strip ANSI
      let text = stripAnsi(raw);

      // Skip empty lines and header/status lines
      if (!text || text.startsWith('→') || text.startsWith('DRY RUN') || text.startsWith('Select') || text.startsWith('[') || text.match(/^[\d\/]+/)) continue;

      // Match lines with ○ (item marker) - common in mo TUI output
      // Pattern: [optional ➤] ○ Name    Size | Location
      // Or: item name followed by size
      const itemMatch = text.match(/[○➤]\s+(.+?)\s+([\d.]+(?:MB|GB|KB|B))\s*(?:\|\s*(.+))?/);
      if (itemMatch) {
        const name = itemMatch[1].trim();
        if (!seen.has(name)) {
          seen.add(name);
          items.push({
            name: name,
            size: itemMatch[2],
            path: (itemMatch[3] || '').trim(),
            selected: true,
          });
        }
        continue;
      }

      // Also match lines with size info without ○ (for purge output)
      // e.g. "node_modules    123.5MB   /path/to/project"
      const altMatch = text.match(/^(.+?)\s+([\d.]+(?:MB|GB|KB|B))\s+(.+)/);
      if (altMatch) {
        const name = altMatch[1].trim();
        if (!seen.has(name) && name.length > 2 && !name.startsWith('[') && !name.startsWith('*')) {
          seen.add(name);
          items.push({
            name: name,
            size: altMatch[2],
            path: altMatch[3].trim(),
            selected: true,
          });
        }
        continue;
      }
    }

    return items;
  }

  function parseSize(str) {
    if (!str) return 0;
    const m = str.match(/^([\d.]+)\s*(B|KB|MB|GB|TB)$/i);
    if (!m) return 0;
    const num = parseFloat(m[1]);
    const unit = m[2].toUpperCase();
    if (unit === 'B') return num;
    if (unit === 'KB') return num * 1024;
    if (unit === 'MB') return num * 1024 * 1024;
    if (unit === 'GB') return num * 1024 * 1024 * 1024;
    if (unit === 'TB') return num * 1024 * 1024 * 1024 * 1024;
    return 0;
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(1) + units[i];
  }

  // === Status Module ===
  let _statusFetching = false;

  async function fetchStatus() {
    if (_statusFetching) return;
    _statusFetching = true;
    const body = $('status-body');
    body.innerHTML = '<div class="loading">正在检查系统状态...</div>';
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      _cache.status = data;
      renderStatusData(body, data);
    } catch (e) {
      body.innerHTML = `<div class="loading" style="color:var(--red)">❌ 获取状态失败: ${e.message}</div>`;
    } finally {
      _statusFetching = false;
    }
  }

  function refreshStatus() {
    _cache.status = null;
    fetchStatus();
  }

  function renderStatusData(el, data) {
    if (data.error) {
      el.innerHTML = `<div class="loading" style="color:var(--red)">\u274c ${escapeHtml(data.error)}</div>`;
      return;
    }
    const disk = data.disks && data.disks[0] ? data.disks[0] : {};
    const diskUsedPercent = disk.used_percent || 0;
    const diskTotalGb = disk.total ? (disk.total / 1024**3).toFixed(1) : 'N/A';
    const diskUsedGb = disk.used ? (disk.used / 1024**3).toFixed(1) : 'N/A';
    const diskAvailGb = disk.total && disk.used ? ((disk.total - disk.used) / 1024**3).toFixed(1) : 'N/A';
    const health = data.health_score ?? 'N/A';
    const cpuUsage = data.cpu && data.cpu.usage != null ? data.cpu.usage.toFixed(1) : 'N/A';
    const cpuCore = data.cpu && data.cpu.core_count ? data.cpu.core_count : 'N/A';
    const cpuLoad = data.cpu && data.cpu.load1 != null ? data.cpu.load1.toFixed(2) : 'N/A';
    const memPercent = data.memory && data.memory.used_percent != null ? data.memory.used_percent.toFixed(1) : 'N/A';
    const memUsed = data.memory && data.memory.used ? (data.memory.used / 1024**3).toFixed(1) : 'N/A';
    const memTotal = data.memory && data.memory.total ? (data.memory.total / 1024**3).toFixed(1) : 'N/A';
    const healthMsg = data.health_score_msg || '';
    const host = data.host || (data.hardware && data.hardware.model) || '\u672a\u77e5';
    const platform = (data.platform || '').trim() || 'macOS';
    const osVer = (data.hardware && data.hardware.os_version) || '';
    statusbarDisk.textContent = `\u78c1\u76d8: ${diskAvailGb}GB \u53ef\u7528 / \u5171 ${diskTotalGb}GB`;

    let html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">';
    html += '<span style="font-size:12px;color:var(--text-tertiary)">最后更新: ' + new Date().toLocaleTimeString() + '</span>';
    html += '<button class="btn btn-secondary btn-sm" onclick="refreshStatus()" style="font-size:12px;padding:4px 12px">🔄 刷新</button>';
    html += '</div>';
    html += '<div class="stat-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:12px">';
    html += '<div class="stat-card" style="grid-column:1/-1;background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:10px;padding:16px;font-size:13px;line-height:1.6">';
    html += '<div style="display:flex;gap:16px;flex-wrap:wrap">';
    html += `<span>\ud83d\udda5\ufe0f <strong>${host}</strong></span>`;
    html += `<span>\u2699\ufe0f ${platform}${osVer ? ' ' + osVer : ''}</span>`;
    html += `<span>\ud83d\udd32 ${cpuCore} \u6838</span>`;
    html += '</div></div>';
    html += statCard('\ud83d\udcbe \u78c1\u76d8\u4f7f\u7528', `${diskUsedPercent.toFixed(1)}%`, `${diskUsedGb}GB / ${diskTotalGb}GB`);
    html += statCard('\ud83e\uddea \u5065\u5eb7\u8bc4\u5206', `${health}/100`, healthMsg);
    html += statCard('\ud83e\udde0 CPU \u4f7f\u7528', `${cpuUsage}%`, `\u8d1f\u8f7d ${cpuLoad}`);
    html += statCard('\ud83d\udcc0 \u5185\u5b58\u4f7f\u7528', `${memPercent}%`, `${memUsed}GB / ${memTotal}GB`);
    html += '</div>';
    el.innerHTML = html;
  }

  function statCard(iconLabel, value, sub) {
    return `<div class="stat-card" style="background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:10px;padding:16px">
      <div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">${iconLabel}</div>
      <div style="font-size:24px;font-weight:700">${value}</div>
      ${sub ? `<div style="font-size:11px;color:var(--text-tertiary);margin-top:2px">${sub}</div>` : ''}
    </div>`;
  }

  // === Analyze Module ===
  async function fetchAnalyze() {
    const body = $('analyze-body');
    body.innerHTML = '<div class="loading">正在分析磁盘...</div>';
    try {
      const res = await fetch('/api/analyze');
      const data = await res.json();
      _cache.analyze = data;
      renderAnalyzeData(body, data);
    } catch (e) {
      body.innerHTML = `<div class="loading" style="color:var(--red)">❌ 分析失败: ${e.message}</div>`;
    }
  }

  function renderAnalyzeData(el, data) {
    if (data.error) {
      el.innerHTML = `<div class="loading" style="color:var(--orange)">${escapeHtml(data.error)}</div>`;
      return;
    }

    const entries = data.entries || [];
    const totalSize = data.total_size || 0;
    const insightItems = entries.filter(function(e) { return e.insight; });

    // Sort by size descending
    const sorted = entries.slice().sort(function(a, b) { return (b.size || 0) - (a.size || 0); });
    const top5 = sorted.slice(0, 5);

    // Build summary HTML
    let html = '<div class="analyze-summary" style="margin-bottom:16px">';
    html += '<h3 style="font-size:16px;margin:0 0 12px">📊 磁盘分析概览</h3>';

    // Total card
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:12px">';
    html += '<div class="stat-card" style="background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:10px;padding:14px">';
    html += '<div style="font-size:12px;color:var(--text-secondary)">💾 扫描总大小</div>';
    html += '<div style="font-size:20px;font-weight:700;margin-top:4px">' + formatBytes(totalSize) + '</div>';
    html += '<div style="font-size:11px;color:var(--text-tertiary);margin-top:2px">共 ' + entries.length + ' 个目录</div>';
    html += '</div>';

    const cleanableSize = insightItems.reduce(function(s, e) { return s + (e.size || 0); }, 0);
    html += '<div class="stat-card" style="background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:10px;padding:14px">';
    html += '<div style="font-size:12px;color:var(--text-secondary)">🧹 可清理空间</div>';
    html += '<div style="font-size:20px;font-weight:700;color:var(--orange);margin-top:4px">' + formatBytes(cleanableSize) + '</div>';
    html += '<div style="font-size:11px;color:var(--text-tertiary);margin-top:2px">' + insightItems.length + ' 个可清理项</div>';
    html += '</div>';
    html += '</div>';

    // Top 5 largest
    html += '<div style="margin-bottom:12px">';
    html += '<h4 style="font-size:13px;margin:0 0 8px;color:var(--text-secondary)">📁 占用空间最大的目录</h4>';
    html += '<div style="border:1px solid var(--border-subtle);border-radius:8px;overflow:hidden">';
    top5.forEach(function(e, i) {
      const pct = totalSize > 0 ? ((e.size / totalSize) * 100).toFixed(1) : 0;
      const barWidth = Math.min(pct * 2, 100);
      html += '<div style="display:flex;align-items:center;padding:8px 12px;border-bottom:' + (i < top5.length - 1 ? '1px solid var(--border-subtle)' : 'none') + ';font-size:13px">';
      html += '<span style="width:20px;color:var(--text-tertiary);font-size:11px">#' + (i+1) + '</span>';
      html += '<span style="flex:1">' + escapeHtml(e.name || 'Unknown') + '</span>';
      html += '<span style="width:80px;text-align:right;font-weight:500">' + formatBytes(e.size || 0) + '</span>';
      html += '<div style="width:80px;margin-left:10px"><div style="height:6px;background:var(--border-subtle);border-radius:3px;overflow:hidden"><div style="height:100%;width:' + barWidth + '%;background:' + (e.insight ? 'var(--orange)' : 'var(--accent)') + ';border-radius:3px"></div></div></div>';
      html += '<span style="width:40px;text-align:right;font-size:11px;color:var(--text-tertiary)">' + pct + '%</span>';
      html += '</div>';
    });
    html += '</div></div>';

    // Actionable insights
    if (insightItems.length > 0) {
      html += '<div style="margin-bottom:12px">';
      html += '<h4 style="font-size:13px;margin:0 0 8px;color:var(--orange)">💡 可清理建议</h4>';
      html += '<div style="border:1px solid var(--orange);border-radius:8px;padding:12px;background:rgba(255,159,10,0.08)">';
      html += '<ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.8">';
      insightItems.forEach(function(e) {
        html += '<li><strong>' + escapeHtml(e.name || '') + '</strong> — ' + formatBytes(e.size || 0) + ' <span style="color:var(--text-tertiary);font-size:12px">(' + escapeHtml(e.path || '') + ')</span></li>';
      });
      html += '</ul>';
      html += '<div style="margin-top:10px;font-size:13px;color:var(--text-secondary)">';
      html += '💡 建议前往 <strong>深度清理</strong> 或 <strong>构建产物</strong> 模块执行清理操作，可释放约 ' + formatBytes(cleanableSize) + ' 空间。';
      html += '</div>';
      html += '</div></div>';
    }

    // Priority-ordered next steps
    if (insightItems.length > 0) {
      // Sort insights by size descending
      const sortedInsights = insightItems.slice().sort(function(a, b) { return (b.size || 0) - (a.size || 0); });
      html += '<div style="background:var(--bg-card);border:1px solid var(--accent);border-radius:10px;padding:16px;margin-bottom:12px">';
      html += '<h4 style="font-size:14px;margin:0 0 10px">🎯 下一步建议</h4>';
      html += '<div style="font-size:13px;color:var(--text-secondary);margin-bottom:10px;line-height:1.5">';
      html += '根据分析结果，建议按以下优先级操作：</div>';
      html += '<ol style="margin:0 0 12px 0;padding-left:20px;font-size:13px;line-height:2">';
      for (var si = 0; si < sortedInsights.length; si++) {
        var e = sortedInsights[si];
        var moduleHint = '';
        var pathLower = (e.path || '').toLowerCase();
        if (pathLower.includes('cache') || pathLower.includes('log')) moduleHint = ' \u2192 建议使用 <strong>深度清理</strong>';
        else if (pathLower.includes('download')) moduleHint = ' \u2192 建议前往 <strong>安装包清理</strong>';
        else if (pathLower.includes('node_modules') || pathLower.includes('target') || pathLower.includes('build')) moduleHint = ' \u2192 建议使用 <strong>构建产物</strong>';
        html += '<li><strong>' + escapeHtml(e.name || '') + '</strong> \u2014 ' + formatBytes(e.size || 0) + moduleHint + '</li>';
      }
      html += '</ol>';
      html += '<div style="display:flex;gap:8px;flex-wrap:wrap;border-top:1px solid var(--border-subtle);padding-top:10px">';
      html += '<span style="font-size:12px;color:var(--text-secondary);line-height:28px">快捷操作：</span>';
      html += '<button class="btn btn-secondary btn-sm" onclick="location.hash=\'#clean\'">🧹 深度清理</button>';
      html += '<button class="btn btn-secondary btn-sm" onclick="location.hash=\'#purge\'">🏗️ 构建产物</button>';
      html += '<button class="btn btn-secondary btn-sm" onclick="location.hash=\'#installer\'">🗂️ 安装包清理</button>';
      html += '</div></div>';
    }

    html += '</div>';

    // Add the raw data as collapsible
    html += '<details style="margin-top:8px">';
    html += '<summary style="cursor:pointer;font-size:12px;color:var(--text-tertiary);padding:4px 0">📄 查看原始数据</summary>';
    const formatted = JSON.stringify(data, null, 2);
    html += `<pre style="font-family:SF Mono,Menlo,monospace;font-size:11px;line-height:1.6;white-space:pre-wrap;color:var(--text-secondary);background:var(--output-bg);padding:12px;border-radius:6px;border:1px solid var(--border);margin-top:8px">${escapeHtml(formatted)}</pre>`;
    html += '</details>';

    el.innerHTML = html;
  }

  // === History Module ===
  let _historyFetching = false;

  async function fetchHistory() {
    if (_historyFetching) return;
    _historyFetching = true;
    const body = $('history-body');
    body.innerHTML = '<div class="loading">加载历史记录...</div>';
    try {
      const res = await fetch('/api/history');
      const data = await res.json();
      _cache.history = data;
      renderHistoryData(body, data);
    } catch (e) {
      body.innerHTML = `<div class="loading" style="color:var(--red)">❌ 加载失败: ${e.message}</div>`;
    } finally {
      _historyFetching = false;
    }
  }

  function renderHistoryData(el, data) {
    if (data.error) {
      el.innerHTML = `<div class="loading" style="color:var(--orange)">${escapeHtml(data.error)}</div>`;
      return;
    }
    const sessions = data.sessions || [];
    if (sessions.length === 0) {
      el.innerHTML = '<div class="uninstall-empty">✨ 暂无操作记录</div>';
      return;
    }

    // Action descriptions for each command type
    const actionLabels = {
      'clean': '🧹 深度清理',
      'uninstall': '🗑️ 卸载应用',
      'purge': '🏗️ 构建产物清理',
      'optimize': '⚙️ 系统优化',
      'installer': '🗂️ 安装包清理',
    };

    let html = '<table class="uninstall-table"><thead><tr>' +
      '<th style="width:150px">操作时间</th>' +
      '<th style="width:120px">操作动作</th>' +
      '<th>执行动作简介</th>' +
      '</tr></thead><tbody>';
    for (const s of sessions) {
      const time = s.started_at || '-';
      const cmd = s.command || '-';
      const label = actionLabels[cmd] || cmd;
      const actions = s.actions || {};

      // Build a concise description
      const descParts = [];
      if (s.items > 0) descParts.push('处理 ' + s.items + ' 项');
      if (s.size && s.size !== '0B') descParts.push('释放 ' + s.size);
      if (actions.removed > 0) descParts.push('删除 ' + actions.removed + ' 项');
      if (actions.trashed > 0) descParts.push('移入废纸篓 ' + actions.trashed + ' 项');
      if (actions.failed > 0) descParts.push('失败 ' + actions.failed + ' 项');
      if (actions.skipped > 0) descParts.push('跳过 ' + actions.skipped + ' 项');
      const description = descParts.length > 0 ? descParts.join('，') : (s.operation_count > 0 ? '操作完成' : '无变更');

      html += '<tr><td>' + escapeHtml(time) + '</td>' +
        '<td><strong>' + escapeHtml(label) + '</strong></td>' +
        '<td>' + escapeHtml(description) + '</td></tr>';
    }
    html += '</tbody></table>';
    el.innerHTML = html;
  }

  // === Uninstall Module ===
  let uninstallApps = [];
  let uninstallSelected = new Set();

  async function loadUninstallList() {
    const body = $('uninstall-list');
    body.innerHTML = '<div class="loading">🔍 正在扫描已安装的应用...</div>';
    try {
      const res = await fetch('/api/uninstall/list');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error('Unexpected response format');
      uninstallApps = data;
      renderUninstallList();
    } catch (e) {
      body.innerHTML = '<div class="uninstall-empty">\u274c \u52a0\u8f7d\u5931\u8d25: ' + escapeHtml(e.message) + '</div>';
    }
  }

  function renderUninstallList() {
    const body = $('uninstall-list');
    const countEl = $('uninstall-count');
    const selBtn = $('uninstall-selected');

    if (!uninstallApps.length) {
      body.innerHTML = '<div class="uninstall-empty">\u2728 \u672a\u53d1\u73b0\u53ef\u5378\u8f7d\u7684\u5e94\u7528</div>';
      if (countEl) countEl.textContent = '\u5171 0 \u4e2a\u5e94\u7528';
      if (selBtn) { selBtn.disabled = true; selBtn.textContent = '\U0001f5d1\ufe0f \u5378\u8f7d\u9009\u4e2d (0)'; }
      return;
    }

    if (countEl) countEl.textContent = '共 ' + uninstallApps.length + ' 个应用';

    // Sort by size descending
    uninstallApps.sort(function(a, b) {
      return parseSize(b.size || '0') - parseSize(a.size || '0');
    });

    let html = '<table class="uninstall-table"><thead><tr>';
    html += '<th style="width:36px"><input type="checkbox" class="app-checkbox" id="select-all" onchange="toggleSelectAll(this)"></th>';
    html += '<th>应用名称</th>';
    html += '<th style="width:100px">大小</th>';
    html += '<th style="width:60px">来源</th>';
    html += '<th style="width:90px">操作</th>';
    html += '</tr></thead><tbody>';

    for (let i = 0; i < uninstallApps.length; i++) {
      const app = uninstallApps[i];
      const appName = app.uninstall_name || app.name || '';
      const size = app.size || '--';
      const source = app.source || 'App';
      const checked = uninstallSelected.has(i) ? 'checked' : '';
      const isSelected = uninstallSelected.has(i);
      const rowClass = isSelected ? ' class="selected-row"' : '';
      html += '<tr' + rowClass + '>';
      html += '<td><input type="checkbox" class="app-checkbox" data-index="' + i + '" ' + checked + ' onchange="toggleAppSelect(' + i + ', this.checked)"></td>';
      html += '<td><div class="app-name">' + escapeHtml(app.name || '') + '</div>';
      if (app.path) html += '<div class="app-path">' + escapeHtml(app.path) + '</div>';
      html += '</td>';
      html += '<td class="app-size">' + escapeHtml(size) + '</td>';
      html += '<td><span class="app-source">' + escapeHtml(source) + '</span></td>';
      html += '<td><button class="btn-uninstall-single" data-app="' + escapeHtml(appName) + '" onclick="confirmSingleUninstall(this)">卸载</button></td>';
      html += '</tr>';
    }

    html += '</tbody></table>';
    body.innerHTML = html;
  }

  function toggleSelectAll(el) {
    const checkboxes = document.querySelectorAll('.uninstall-table .app-checkbox[data-index]');
    checkboxes.forEach((cb, i) => {
      cb.checked = el.checked;
      if (el.checked) uninstallSelected.add(parseInt(cb.dataset.index));
      else uninstallSelected.delete(parseInt(cb.dataset.index));
    });
    updateSelectedBtn();
  }

  function toggleAppSelect(index, checked) {
    if (checked) uninstallSelected.add(index);
    else uninstallSelected.delete(index);
    const selectAll = $('select-all');
    if (selectAll) {
      const total = uninstallApps.length;
      selectAll.checked = uninstallSelected.size === total;
      selectAll.indeterminate = uninstallSelected.size > 0 && uninstallSelected.size < total;
    }
    updateSelectedBtn();
  }

  function updateSelectedBtn() {
    const selBtn = $('uninstall-selected');
    if (!selBtn) return;
    const count = uninstallSelected.size;
    selBtn.textContent = '🗑️ 卸载选中 (' + count + ')';
    selBtn.disabled = count === 0;
  }

  function confirmSingleUninstall(btn) {
    const appName = btn.dataset.app;
    if (!appName) return;
    // Find the full app data in uninstallApps
    var appData = null;
    for (var i = 0; i < uninstallApps.length; i++) {
      var a = uninstallApps[i];
      if ((a.uninstall_name || a.name || '') === appName) {
        appData = { name: appName, path: a.path || '', bundle_id: a.bundle_id || '' };
        break;
      }
    }
    if (!appData) {
      appData = { name: appName, path: '', bundle_id: '' };
    }
    currentModule = 'uninstall';
    currentAction = 'run-selected';
    executeUninstall([appData]);
  }

  function cleanupUninstall() {
    const scanBtn = $('uninstall-scan');
    const selBtn = $('uninstall-selected');
    if (scanBtn) scanBtn.disabled = false;
    if (selBtn) selBtn.disabled = uninstallSelected.size === 0;
    cleanup('uninstall');
  }

  window.toggleSelectAll = toggleSelectAll;
  window.toggleAppSelect = toggleAppSelect;
  window.confirmSingleUninstall = confirmSingleUninstall;
  window.refreshStatus = refreshStatus;
  window.toggleAllItems = toggleAllItems;
  window.toggleModuleItem = toggleModuleItem;
  window.executeModuleAction = executeModuleAction;

  async function scanModuleForCleanup(module) {
    const outputEl = document.getElementById('output-' + module);
    if (!outputEl) return;
    outputEl.innerHTML = '<div class="loading">🔍 正在扫描...</div>';

    const btnDry = document.querySelector('.btn[data-module="' + module + '"][data-action="dry-run"]');
    const btnRun = document.querySelector('.btn[data-module="' + module + '"][data-action="run"]');
    if (btnDry) btnDry.disabled = true;
    if (btnRun) btnRun.disabled = true;

    try {
      var res = await fetch('/api/' + module + '/scan');
      var items = await res.json();

      // Check for error from backend
      if (items && items.error) {
        outputEl.innerHTML = '<div class="line-stderr">❌ 扫描失败: ' + escapeHtml(items.error) + '</div>';
        setStatusbar('扫描失败', 'error');
        cleanup(module);
        return;
      }

      // Format items for _moduleItems
      var formattedItems = (items || []).map(function(item) {
        return {
          name: item.name || item.path || '',
          size: item.size_str || formatBytes(item.size || 0) || '--',
          path: item.path || '',
          selected: true,
        };
      });

      _moduleItems[module] = formattedItems;

      if (formattedItems.length > 0) {
        outputEl.innerHTML = ''; // Clear loading message
        renderParsedItems(module, formattedItems);
        setStatusbar(MODULES[module] ? MODULES[module].label + ' 扫描完成' : module + ' 扫描完成', 'success');
      } else {
        outputEl.innerHTML = '<div class="loading">未发现可清理的项目</div>';
        setStatusbar('未发现可清理的项目', '');
      }
    } catch (e) {
      outputEl.innerHTML = '<div class="line-stderr">❌ 扫描失败: ' + escapeHtml(e.message) + '</div>';
      setStatusbar('扫描失败', 'error');
    }

    cleanup(module);
  }

  // === SSE Execution (for clean/purge/installer/optimize) ===
  async function executeAction(module, action) {
    const outputEl = document.getElementById('output-' + module);
    if (!outputEl) return;
    // For installer/purge dry-run, use Go native scan instead of mo CLI
    if ((module === 'installer' || module === 'purge') && action === 'dry-run') {
      return scanModuleForCleanup(module);
    }
    outputEl.innerHTML = '';
    const endpoint = '/api/' + module + '/' + action;
    const controller = new AbortController();
    runningControllers[module] = controller;
    showProgressIndicator(module);
    addStopButton(module);

    // Disable buttons
    const btnDry = document.querySelector(`.btn[data-module="${module}"][data-action="dry-run"]`);
    const btnRun = document.querySelector(`.btn[data-module="${module}"][data-action="run"]`);
    if (btnDry) btnDry.disabled = true;
    if (btnRun) btnRun.disabled = true;

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        signal: controller.signal,
      });
      if (!res.ok) {
        outputEl.innerHTML += `<div class="line-stderr">❌ HTTP ${res.status}</div>`;
        hideProgressIndicator(module);
        removeStopButton(module);
        cleanup(module);
        return;
      }

      const decoder = new TextDecoder();
      const reader = res.body.getReader();
      let buffer = '';
      let hasReceivedData = false;
      let allLines = [];

      function readStream() {
        reader.read().then(({ done, value }) => {
          if (done) {
            // For dry-run PARSE_MODULES, suppress raw output
            if (action === 'dry-run' && PARSE_MODULES.includes(module)) {
              // Don't show raw SSE output - we'll render parsed items
            } else {
              processSSEBuffer(outputEl, buffer);
            }

            // After dry-run completes, try to parse items
            if (action === 'dry-run' && PARSE_MODULES.includes(module)) {
              _moduleItems[module] = parseDryRunOutput(module, allLines);
              if (_moduleItems[module] && _moduleItems[module].length > 0) {
                outputEl.innerHTML = ''; // Clear scanning message
                renderParsedItems(module, _moduleItems[module]);
              } else {
                outputEl.innerHTML = '<div class="loading">未发现可清理的项目</div>';
              }
            }

            setStatusbar(module === 'status' ? '就绪' : MODULES[module] ? MODULES[module].label + ' 完成' : module + ' 完成', 'success');
            hideProgressIndicator(module);
            removeStopButton(module);
            cleanup(module);
            return;
          }

          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\n\n');
          buffer = parts.pop() || '';

          const isDryRunParse = (action === 'dry-run' && PARSE_MODULES.includes(module));
          for (const part of parts) {
            if (isDryRunParse) {
              // Collect lines without displaying raw output
              const lines = part.split('\n');
              let dataStr = '';
              for (const line of lines) {
                if (line.startsWith('data: ')) dataStr = line.slice(6);
              }
              if (dataStr) {
                try {
                  const data = JSON.parse(dataStr);
                  if (data.line) allLines.push(data.line);
                } catch(e) {
                  allLines.push(dataStr);
                }
              }
              // Show scanning progress periodically
              if (allLines.length > 0 && allLines.length % 10 === 0) {
                outputEl.innerHTML = '<div class="loading">🔍 正在扫描... (已处理 ' + allLines.length + ' 项)</div>';
              } else if (allLines.length === 1) {
                outputEl.innerHTML = '<div class="loading">🔍 正在扫描...</div>';
              }
            } else {
              const hadData = processSSEEvent(outputEl, part, allLines);
              if (hadData) hasReceivedData = true;
            }
          }

          if (hasReceivedData) {
            hideProgressIndicator(module);
          }

          readStream();
        }).catch(err => {
          if (err.name === 'AbortError') {
            outputEl.innerHTML += `<div class="line-stderr">⏹️ 已手动停止</div>`;
            setStatusbar('已停止', '');
          } else {
            outputEl.innerHTML += `<div class="line-stderr">❌ 读取错误: ${err.message}</div>`;
            setStatusbar('读取错误', 'error');
          }
          hideProgressIndicator(module);
          removeStopButton(module);
          cleanup(module);
        });
      }

      readStream();
    } catch (err) {
      if (err.name === 'AbortError') {
        outputEl.innerHTML += `<div class="line-stderr">⏹️ 已手动停止</div>`;
        setStatusbar('已停止', '');
      } else {
        outputEl.innerHTML += `<div class="line-stderr">❌ 连接失败: ${err.message}</div>`;
        setStatusbar('连接失败', 'error');
      }
      hideProgressIndicator(module);
      removeStopButton(module);
      cleanup(module);
    }
  }

  // === SSE Execution (for clean/purge/installer/optimize) ===
  function cleanup(module) {
    const btnDry = document.querySelector(`.btn[data-module="${module}"][data-action="dry-run"]`);
    const btnRun = document.querySelector(`.btn[data-module="${module}"][data-action="run"]`);
    if (btnDry) btnDry.disabled = false;
    if (btnRun) btnRun.disabled = false;
    delete runningControllers[module];
    hideProgressIndicator(module);
    removeStopButton(module);
  }

  function processSSEEvent(el, eventBlock, lineCollector) {
    const lines = eventBlock.split('\n');
    let eventType = '';
    let dataStr = '';
    for (const line of lines) {
      if (line.startsWith('event: ')) eventType = line.slice(7);
      if (line.startsWith('data: ')) dataStr = line.slice(6);
    }
    if (!dataStr) return false;
    try {
      const data = JSON.parse(dataStr);
      if (lineCollector && data.line) lineCollector.push(data.line);
      appendOutputLine(el, eventType, data);
      return true;
    } catch (e) {
      if (lineCollector) lineCollector.push(dataStr);
      appendOutputLine(el, eventType, { line: dataStr, stream: 'stdout' });
      return true;
    }
  }

  function processSSEBuffer(el, remaining) {
    if (!remaining.trim()) return;
    const parts = remaining.split('\n\n');
    for (const part of parts) {
      if (part.trim()) processSSEEvent(el, part);
    }
  }

  function appendOutputLine(el, eventType, data) {
    const div = document.createElement('div');
    const text = data.line || '';
    if (eventType === 'done') {
      if (data.exit_code === 0) {
        div.className = 'line-done-success';
        div.textContent = `✅ 执行完成 (${data.duration_ms || 0}ms)`;
      } else if (data.exit_code === -1) {
        div.className = 'line-done-error';
        div.textContent = '⏹️ 已取消';
      } else {
        div.className = 'line-done-error';
        div.textContent = `❌ 执行失败 (exit: ${data.exit_code})`;
      }
    } else if (eventType === 'stderr' || data.stream === 'stderr') {
      div.className = 'line-stderr';
      // Strip ANSI for cleaner display
      div.textContent = stripAnsi(text);
    } else {
      div.className = 'line-stdout';
      div.textContent = stripAnsi(text);
    }
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  }

  // === Button Clicks (Dry-run / Run) ===
  document.addEventListener('click', function (e) {
    const btn = e.target.closest('.btn[data-action]');
    if (!btn) return;
    const module = btn.dataset.module;
    const action = btn.dataset.action;
    if (!module || !action) return;
    if (btn.disabled) return;
    // For interactive modules (installer/purge), redirect to delete-stream
    if (action === 'run' && (module === 'installer' || module === 'purge')) {
      if (_moduleItems[module] && _moduleItems[module].length > 0) {
        executeModuleAction(module);
        return;
      }
      executeAction(module, 'dry-run');
      return;
    }
    if (action === 'run' && module === 'clean') {
      executeAction(module, 'dry-run');
      return;
    }
    // Directly execute since user already chose the action
    executeAction(module, action === 'run' ? 'run' : 'dry-run');
  });

  // === Uninstall button handlers ===
  document.addEventListener('click', function (e) {
    var scanBtn = e.target.closest('#uninstall-scan');
    if (scanBtn && !scanBtn.disabled) {
      loadUninstallList();
      return;
    }
    var selBtn = e.target.closest('#uninstall-selected');
    if (selBtn && !selBtn.disabled) {
      var appsToUninstall = [];
      uninstallSelected.forEach(function(idx) {
        var app = uninstallApps[idx];
        if (app) {
          appsToUninstall.push({
            name: app.uninstall_name || app.name || '',
            path: app.path || '',
            bundle_id: app.bundle_id || ''
          });
        }
      });
      if (appsToUninstall.length === 0) return;
      executeUninstall(appsToUninstall);
      return;
    }
  });

  // === Risk Sheet ===
  function showRiskSheet(module) {
    currentModule = module;
    currentAction = 'run';

    const meta = MODULES[module];
    const risk = riskMap[module];

    sheetTitle.textContent = '确认 ' + (meta ? meta.label : module);
    sheetRiskLabel.textContent = risk ? risk.risk_label : '';
    sheetRiskLabel.style.background = risk ? risk.color + '22' : '';
    sheetRiskLabel.style.color = risk ? risk.color : '';

    sheetAffects.innerHTML = '';
    if (risk) {
      risk.affects.forEach(function(a) {
        var li = document.createElement('li');
        li.textContent = a;
        sheetAffects.appendChild(li);
      });
    }

    // For uninstall with selected apps, list them
    if (module === 'uninstall' && currentAction === 'run-selected') {
      var appNames = [];
      uninstallSelected.forEach(function(idx) {
        var app = uninstallApps[idx];
        if (app) appNames.push(app.name || app.uninstall_name || '');
      });
      if (appNames.length > 0) {
        sheetAffects.innerHTML = '';
        var h = document.createElement('li');
        h.style.fontWeight = '600';
        h.textContent = '将卸载以下 ' + appNames.length + ' 个应用:';
        sheetAffects.appendChild(h);
        appNames.forEach(function(name) {
          var li = document.createElement('li');
          li.textContent = '  • ' + name;
          sheetAffects.appendChild(li);
        });
      }
    }

    // For interactive modules with selected items
    if (PARSE_MODULES.includes(module) && _moduleItems[module] && _moduleItems[module].length > 0) {
      var selected = _moduleItems[module].filter(function(i) { return i.selected !== false; });
      if (selected.length > 0 && selected.length < _moduleItems[module].length) {
        sheetAffects.innerHTML = '';
        var h = document.createElement('li');
        h.style.fontWeight = '600';
        h.textContent = '将清理以下 ' + selected.length + ' 项:';
        sheetAffects.appendChild(h);
        selected.forEach(function(item) {
          var li = document.createElement('li');
          li.textContent = '  • ' + (item.name || '') + ' (' + (item.size || '') + ')';
          sheetAffects.appendChild(li);
        });
      }
    }

    sheetSafezones.innerHTML = '';
    if (risk) {
      risk.safe_zones.forEach(function(z) {
        var li = document.createElement('li');
        li.textContent = z;
        sheetSafezones.appendChild(li);
      });
    }

    sheetConsent.checked = false;
    sheetConfirm.disabled = true;
    overlay.classList.remove('hidden');
  }

  sheetConsent.addEventListener('change', function () {
    sheetConfirm.disabled = !sheetConsent.checked;
  });

  sheetCancel.addEventListener('click', function () {
    overlay.classList.add('hidden');
  });

  sheetConfirm.addEventListener('click', function () {
    overlay.classList.add('hidden');
    if (currentModule === 'uninstall' && currentAction === 'run-selected') {
      var appNames = [];
      uninstallSelected.forEach(function(idx) {
        var app = uninstallApps[idx];
        if (app) appNames.push(app.uninstall_name || app.name || '');
      });
      if (appNames.length > 0) {
        executeUninstall(appNames);
      }
    } else if (currentModule && currentAction === 'run') {
      executeAction(currentModule, 'run');
    }
  });

  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) {
      overlay.classList.add('hidden');
    }
  });

  // === Uninstall Execution ===
  async function executeUninstall(apps) {
    const outputEl = $('output-uninstall');
    if (!outputEl) return;
    outputEl.innerHTML = '';

    const scanBtn = $('uninstall-scan');
    const selBtn = $('uninstall-selected');
    if (scanBtn) scanBtn.disabled = true;
    if (selBtn) selBtn.disabled = true;

    showProgressIndicator('uninstall');
    addStopButton('uninstall');

    try {
      const res = await fetch('/api/uninstall/run-selected', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apps: apps }),
      });
      if (!res.ok) {
        outputEl.innerHTML += `<div class="line-stderr">❌ HTTP ${res.status}</div>`;
        cleanupUninstall();
        return;
      }

      const decoder = new TextDecoder();
      const reader = res.body.getReader();
      let buffer = '';

      function readStream() {
        reader.read().then(({ done, value }) => {
          if (done) {
            // Parse the done event for exit code
            var exitCode = 0;
            if (buffer.trim()) {
              var lines = buffer.split('\n\n');
              for (var li = 0; li < lines.length; li++) {
                if (lines[li].startsWith('data: ')) {
                  try {
                    var doneData = JSON.parse(lines[li].slice(6));
                    if (doneData.exit_code !== undefined) exitCode = doneData.exit_code;
                  } catch(e) {}
                }
              }
            }
            processSSEBuffer(outputEl, buffer);
            // Clear selection
            uninstallSelected.clear();
            // On success, remove uninstalled apps from the list
            if (exitCode === 0 && apps && apps.length > 0) {
              var nameSet = {};
              apps.forEach(function(a) { nameSet[a.name] = true; });
              uninstallApps = uninstallApps.filter(function(app) {
                var appName = app.uninstall_name || app.name || '';
                return !nameSet[appName];
              });
            }
            renderUninstallList();
            setStatusbar(exitCode === 0 ? '卸载完成' : '卸载失败', exitCode === 0 ? 'success' : 'error');
            cleanupUninstall();
            return;
          }

          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\n\n');
          buffer = parts.pop() || '';

          for (const part of parts) {
            processSSEEvent(outputEl, part);
          }

          readStream();
        }).catch(err => {
          outputEl.innerHTML += `<div class="line-stderr">❌ ${err.message}</div>`;
          cleanupUninstall();
        });
      }

      readStream();
    } catch (e) {
      outputEl.innerHTML += `<div class="line-stderr">❌ 连接失败: ${e.message}</div>`;
      cleanupUninstall();
    }
  }

  // === Progress Indicator ===
  function showProgressIndicator(module) {
    const outputEl = document.getElementById('output-' + module) || $('output-uninstall');
    if (!outputEl) return;
    // Remove existing indicator
    hideProgressIndicator(module);
    const indicator = document.createElement('div');
    indicator.className = 'progress-indicator';
    indicator.id = 'progress-' + module;
    indicator.innerHTML = '<div class="progress-bar"><div class="progress-fill"></div></div><span class="progress-text">执行中...</span>';
    if (outputEl.parentNode) outputEl.parentNode.insertBefore(indicator, outputEl);
  }

  function hideProgressIndicator(module) {
    const el = document.getElementById('progress-' + module);
    if (el) el.remove();
  }

  function addStopButton(module) {
    removeStopButton(module);
    const outputEl = document.getElementById('output-' + module);
    if (!outputEl) return;
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary btn-stop';
    btn.id = 'stopbtn-' + module;
    btn.textContent = '⏹️ 停止';
    btn.style.cssText = 'margin-bottom:8px;font-size:12px;padding:4px 12px';
    btn.addEventListener('click', function () {
      this.disabled = true;
      this.textContent = '正在停止...';
      stopAction(module);
    });
    outputEl.parentNode.insertBefore(btn, outputEl);
  }

  function removeStopButton(module) {
    const btn = document.getElementById('stopbtn-' + module);
    if (btn) btn.remove();
  }

  async function stopAction(module) {
    try {
      const res = await fetch('/api/stop?module=' + encodeURIComponent(module), { method: 'POST' });
      const data = await res.json();
      if (data.status === 'cancelled') {
        setStatusbar('已发送停止信号', '');
      }
    } catch (e) {
      console.warn('Stop failed:', e);
    }
  }

  // === Status Bar ===
  function setStatusbar(text, type) {
    statusbarStatus.textContent = text;
    statusbarStatus.style.color = type === 'error' ? 'var(--red)' : type === 'success' ? 'var(--green)' : '';
    if (type === 'success') {
      setTimeout(() => {
        statusbarStatus.textContent = '就绪';
        statusbarStatus.style.color = '';
      }, 5000);
    }
  }

  // === Helpers ===
  function escapeHtml(str) {
    if (typeof str !== 'string') return String(str);
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }


  // === Whitelist Management ===
  const DEFAULT_EXTENSIONS = ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.pdf', '.jpg', '.png', '.mp4'];

  function loadWhitelist() {
    try {
      var saved = localStorage.getItem('mac-cleaner-whitelist');
      if (saved) return JSON.parse(saved);
    } catch(e) {}
    return DEFAULT_EXTENSIONS.slice();
  }

  function saveWhitelist(exts) {
    localStorage.setItem('mac-cleaner-whitelist', JSON.stringify(exts));
  }

  function renderWhitelistTags() {
    var container = document.getElementById('whitelist-tags');
    if (!container) return;
    var exts = loadWhitelist();
    if (exts.length === 0) {
      container.innerHTML = '<span style="font-size:12px;color:var(--text-tertiary)">未设置白名单，所有文件均可被删除</span>';
      return;
    }
    container.innerHTML = '';
    exts.forEach(function(ext) {
      var tag = document.createElement('span');
      tag.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:2px 8px;background:var(--bg-sidebar);border:1px solid var(--border-subtle);border-radius:4px;font-size:12px;color:var(--text-primary)';
      tag.innerHTML = '<span>' + escapeHtml(ext) + '</span><span class="whitelist-remove" data-ext="' + escapeHtml(ext) + '" style="cursor:pointer;color:var(--red);font-weight:bold;margin-left:2px">×</span>';
      container.appendChild(tag);
    });
    // Bind remove handlers
    container.querySelectorAll('.whitelist-remove').forEach(function(el) {
      el.addEventListener('click', function() {
        var ext = this.dataset.ext;
        var exts = loadWhitelist().filter(function(e) { return e !== ext; });
        saveWhitelist(exts);
        renderWhitelistTags();
        // Re-scan current path if results are visible
        if (cleanCurrentPath && document.getElementById('clean-results').style.display !== 'none') {
          scanDisk(cleanCurrentPath);
        }
      });
    });
  }

  function initWhitelistUI() {
    var toggle = document.getElementById('whitelist-toggle');
    var panel = document.getElementById('whitelist-panel');
    var input = document.getElementById('whitelist-input');
    var addBtn = document.getElementById('whitelist-add-btn');
    var resetBtn = document.getElementById('whitelist-reset-btn');

    if (toggle && panel) {
      toggle.addEventListener('click', function() {
        var isHidden = panel.style.display === 'none' || panel.style.display === '';
        panel.style.display = isHidden ? 'block' : 'none';
        toggle.textContent = isHidden ? '收起设置 ▾' : '展开设置 ▸';
        if (isHidden) renderWhitelistTags();
      });
    }

    if (addBtn && input) {
      function addWhitelistExt() {
        var ext = input.value.trim();
        if (!ext) return;
        if (!ext.startsWith('.')) ext = '.' + ext;
        var exts = loadWhitelist();
        if (!exts.includes(ext)) {
          exts.push(ext);
          saveWhitelist(exts);
          renderWhitelistTags();
          // Re-scan current path if results are visible
          if (cleanCurrentPath && document.getElementById('clean-results').style.display !== 'none') {
            scanDisk(cleanCurrentPath);
          }
        }
        input.value = '';
      }
      addBtn.addEventListener('click', addWhitelistExt);
      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') addWhitelistExt();
      });
    }

    if (resetBtn) {
      resetBtn.addEventListener('click', function() {
        saveWhitelist(DEFAULT_EXTENSIONS.slice());
        renderWhitelistTags();
        if (cleanCurrentPath && document.getElementById('clean-results').style.display !== 'none') {
          scanDisk(cleanCurrentPath);
        }
      });
    }

    renderWhitelistTags();
  }

  function isWhitelisted(filename) {
    if (!filename) return false;
    var exts = loadWhitelist();
    var lower = filename.toLowerCase();
    return exts.some(function(ext) { return lower.endsWith(ext.toLowerCase()); });
  }

  // === Clean Module: Disk Scan ===
  let cleanEntries = [];
  let cleanCurrentPath = '';
  let cleanPathHistory = [];

  function initCleanEventHandlers() {
    initWhitelistUI();
    // Path preset buttons
    document.querySelectorAll('.clean-path-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var path = this.dataset.path;
        var input = document.getElementById('clean-custom-path');
        if (input) input.value = path;
        scanDisk(path);
      });
    });

    // Scan button
    var scanBtn = document.getElementById('clean-scan-btn');
    if (scanBtn) {
      scanBtn.addEventListener('click', function() {
        var input = document.getElementById('clean-custom-path');
        var path = input ? input.value.trim() : '';
        if (path) scanDisk(path);
      });
    }

    // Custom path enter key
    var pathInput = document.getElementById('clean-custom-path');
    if (pathInput) {
      pathInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
          var path = this.value.trim();
          if (path) scanDisk(path);
        }
      });
    }

    // Select all checkbox
    var selectAll = document.getElementById('clean-select-all');
    if (selectAll) {
      selectAll.addEventListener('change', function() {
        var checkboxes = document.querySelectorAll('#clean-table-body .clean-item-checkbox');
        checkboxes.forEach(function(cb) { cb.checked = this.checked; }, this);
        updateCleanExecBtn();
      });
    }

    // Up button
    var upBtn = document.getElementById('clean-up-btn');
    if (upBtn) {
      upBtn.addEventListener('click', goUpClean);
    }

    // Execute clean button
    var execBtn = document.getElementById('clean-execute-btn');
    if (execBtn) {
      execBtn.addEventListener('click', cleanSelectedItems);
    }

    // Event delegation for drill-down on directory links and buttons
    document.addEventListener('click', function(e) {
      var drillBtn = e.target.closest('.clean-drill-btn');
      if (drillBtn && drillBtn.dataset.path) {
        var path = drillBtn.dataset.path;
        cleanPathHistory.push(cleanCurrentPath);
        scanDisk(path);
        return;
      }
      var dirLink = e.target.closest('.clean-dir-link');
      if (dirLink && dirLink.dataset.path) {
        e.preventDefault();
        var path = dirLink.dataset.path;
        cleanPathHistory.push(cleanCurrentPath);
        scanDisk(path);
        return;
      }
    });
  }

  async function scanDisk(path) {
    if (!path) return;
    var resultsEl = document.getElementById('clean-results');
    var tableBody = document.getElementById('clean-table-body');
    if (!tableBody) return;

    if (resultsEl) resultsEl.style.display = 'block';
    tableBody.innerHTML = '<tr><td colspan="4" style="padding:20px;text-align:center;color:var(--text-tertiary)"><span class="loading">🔍 正在扫描...</span></td></tr>';

    var pathDisplay = document.getElementById('clean-current-path');
    if (pathDisplay) pathDisplay.textContent = path;

    try {
      var res = await fetch('/api/disk/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: path }),
      });
      if (!res.ok) {
        var errData = await res.json().catch(function() { return { error: 'HTTP ' + res.status }; });
        tableBody.innerHTML = '<tr><td colspan="4" style="padding:20px;text-align:center;color:var(--red)">❌ ' + escapeHtml(errData.error || '扫描失败') + '</td></tr>';
        return;
      }
      var data = await res.json();
      cleanCurrentPath = data.path || path;
      cleanEntries = data.entries || [];
      renderCleanResults(data);
    } catch (e) {
      tableBody.innerHTML = '<tr><td colspan="4" style="padding:20px;text-align:center;color:var(--red)">❌ 连接失败: ' + escapeHtml(e.message) + '</td></tr>';
    }
  }

    function renderCleanResults(data) {
    var tableBody = document.getElementById('clean-table-body');
    var totalSizeEl = document.getElementById('clean-total-size');
    var upBtn = document.getElementById('clean-up-btn');
    var selectAll = document.getElementById('clean-select-all');

    var entries = data.entries || [];
    var totalSize = 0;
    var whitelistExcluded = 0;
    entries.forEach(function(e) { totalSize += e.size || 0; });

    if (totalSizeEl) totalSizeEl.textContent = '总计 ' + formatBytes(totalSize);

    if (upBtn) {
      upBtn.style.display = (cleanPathHistory.length > 0) ? '' : 'none';
    }

    if (selectAll) selectAll.checked = true;

    // Filter out whitelisted files
    var whitelistExcluded = 0;
    var filteredEntries = entries.filter(function(e) {
      if (!e.is_dir && isWhitelisted(e.name)) {
        whitelistExcluded++;
        return false;
      }
      return true;
    });

    if (filteredEntries.length === 0) {
      var msg = whitelistExcluded > 0 ? '📭 所有文件均被白名单保护。可展开上方"🛡️ 文件白名单"调整设置。' : '📭 此目录为空';
      tableBody.innerHTML = '<tr><td colspan="4" style="padding:20px;text-align:center;color:var(--text-tertiary)">' + msg + '</td></tr>';
      updateCleanExecBtn();
      return;
    }

    var html = '';
    if (whitelistExcluded > 0) {
      html += '<tr><td colspan="4" style="padding:4px 10px;text-align:center;font-size:12px;color:var(--text-tertiary)">🛡️ 白名单已过滤 ' + whitelistExcluded + ' 个文件（.doc/.pdf 等）</td></tr>';
    }
    for (var i = 0; i < filteredEntries.length; i++) {
      var e = filteredEntries[i];
      var icon = e.is_dir ? '📁' : '📄';
      var nameDisplay = escapeHtml(e.name || '');
      var sizeDisplay = e.size_str || '--';

      html += '<tr>';
      html += '<td style="padding:6px 10px;text-align:center"><input type="checkbox" class="clean-item-checkbox" data-index="' + i + '" checked onchange="updateCleanExecBtn()"></td>';
      html += '<td style="padding:6px 10px">';
      if (e.is_dir) {
        html += '<a href="#" class="clean-dir-link" data-path="' + escapeHtml(e.path) + '" style="text-decoration:none;color:var(--text-primary);cursor:pointer;display:flex;align-items:center;gap:6px">';
        html += '<span>' + icon + '</span><span>' + nameDisplay + '</span>';
        html += '</a>';
      } else {
        html += '<span style="display:flex;align-items:center;gap:6px"><span>' + icon + '</span><span>' + nameDisplay + '</span></span>';
      }
      html += '</td>';
      html += '<td style="padding:6px 10px;text-align:right;font-size:12px;color:var(--text-secondary);font-variant-numeric:tabular-nums">' + sizeDisplay + '</td>';
      html += '<td style="padding:6px 10px;text-align:center">';
      if (e.is_dir) {
        html += '<button class="btn btn-secondary btn-sm clean-drill-btn" data-path="' + escapeHtml(e.path) + '" style="font-size:11px;padding:2px 8px">📂 下钻</button>';
      }
      html += '</td>';
      html += '</tr>';
    }

    tableBody.innerHTML = html;
    updateCleanExecBtn();
  }

    function drillCleanPath(path) {
    if (!path) return;
    cleanPathHistory.push(cleanCurrentPath);
    scanDisk(path);
  }

  function goUpClean() {
    if (cleanPathHistory.length === 0) {
      // Go to parent of current path
      var parent = cleanCurrentPath.substring(0, cleanCurrentPath.lastIndexOf('/'));
      if (parent === '') parent = '/';
      // Don't push to history for simple parent navigation from root
      scanDisk(parent);
      return;
    }
    var prev = cleanPathHistory.pop();
    scanDisk(prev);
  }

  function updateCleanExecBtn() {
    var execBtn = document.getElementById('clean-execute-btn');
    var selectAll = document.getElementById('clean-select-all');
    if (!execBtn) return;

    var checkboxes = document.querySelectorAll('#clean-table-body .clean-item-checkbox');
    var checkedCount = 0;
    checkboxes.forEach(function(cb) {
      if (cb.checked) checkedCount++;
    });

    execBtn.disabled = checkedCount === 0;
    execBtn.textContent = checkedCount > 0 ? '🧹 清理选中 (' + checkedCount + ')' : '🧹 清理选中项';

    // Update select-all state
    if (selectAll && checkboxes.length > 0) {
      selectAll.checked = checkedCount === checkboxes.length;
      selectAll.indeterminate = checkedCount > 0 && checkedCount < checkboxes.length;
    }
  }

  async function cleanSelectedItems() {
    var checkboxes = document.querySelectorAll('#clean-table-body .clean-item-checkbox:checked');
    if (checkboxes.length === 0) return;

    var paths = [];
    var names = [];
    var totalSize = 0;

    checkboxes.forEach(function(cb) {
      var idx = parseInt(cb.dataset.index);
      var entry = cleanEntries[idx];
      if (entry) {
        paths.push(entry.path);
        names.push(entry.name);
        totalSize += entry.size || 0;
      }
    });

    if (paths.length === 0) return;

    // Remove whitelisted paths from deletion
    var filteredPaths = [];
    var filteredNames = [];
    var whitelistBlocked = 0;
    for (var pi = 0; pi < paths.length; pi++) {
      if (isWhitelisted(names[pi])) {
        whitelistBlocked++;
      } else {
        filteredPaths.push(paths[pi]);
        filteredNames.push(names[pi]);
      }
    }
    if (whitelistBlocked > 0) {
      setStatusbar('🛡️ 白名单阻止了 ' + whitelistBlocked + ' 个文件被删除', '');
    }
    if (filteredPaths.length === 0) {
      setStatusbar('没有可删除的文件（均被白名单保护）', 'error');
      if (execBtn) execBtn.disabled = false;
      return;
    }

    // Directly execute since user already chose items to clean
    doCleanDelete(filteredPaths, filteredNames);
  }

  async function doCleanDelete(paths, names) {
    var execBtn = document.getElementById('clean-execute-btn');
    if (execBtn) execBtn.disabled = true;

    // Show loading in table
    var tableBody = document.getElementById('clean-table-body');
    if (tableBody) {
      tableBody.innerHTML = '<tr><td colspan="4" style="padding:20px;text-align:center"><span class="loading">🧹 正在删除 ' + paths.length + ' 项...</span></td></tr>';
    }

    try {
      var res = await fetch('/api/disk/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: paths }),
      });
      var data = await res.json();

      var results = data.results || [];
      var removed = results.filter(function(r) { return r.removed; }).length;
      var failed = results.filter(function(r) { return r.error; }).length;

      // Refresh the scan
      await scanDisk(cleanCurrentPath);

      setStatusbar('已删除 ' + removed + ' 项' + (failed > 0 ? '，' + failed + ' 项失败' : ''), failed > 0 ? 'error' : 'success');
    } catch (e) {
      if (tableBody) {
        tableBody.innerHTML = '<tr><td colspan="4" style="padding:20px;text-align:center;color:var(--red)">❌ 删除失败: ' + escapeHtml(e.message) + '</td></tr>';
      }
      setStatusbar('删除失败', 'error');
    }
    if (execBtn) execBtn.disabled = false;
  }

  // Make functions accessible from HTML onclick
  // (drillCleanPath and updateCleanExecBtn are used in onclick attributes)
  window.drillCleanPath = drillCleanPath;
  window.updateCleanExecBtn = updateCleanExecBtn;

  // === Init ===
  async function init() {
    initCleanEventHandlers();
    await loadRiskMap();
    // Show welcome page by default, navigate to specific module if hash is set
    if (location.hash && location.hash !== '#') {
      navigate(location.hash);
    }
    // If no hash, welcome page (#page-placeholder) stays visible
  }

  init();
})();
