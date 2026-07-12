// Real-time Dashboard Core Logic for Follow-up Application (JSONP CORS-Safe Version)
const SPREADSHEET_ID = '1eRp9k1JWjvyFO8IymyEUAu7Sd6woqgu4Oe0D26xY5k4';
const REFRESH_INTERVAL_SECONDS = 30;

let reportsData = [];
let changeRequestsData = [];
let uuidsData = [];

let syncTimer = null;
let secondsRemaining = REFRESH_INTERVAL_SECONDS;

// Chart references for dynamic updates
let typeChart = null;
let countryChart = null;
let timelineChart = null;

// JSONP Script Loader to bypass CORS issues on local files (file:/// URL)
function fetchSheetJSONP(sheetName) {
    return new Promise((resolve, reject) => {
        const callbackName = 'gviz_callback_' + Math.random().toString(36).substring(2, 9);
        
        window[callbackName] = function(response) {
            cleanup();
            if (response.status === 'ok') {
                resolve(response.table);
            } else {
                reject(new Error(`Gviz error for sheet ${sheetName}: ${response.errors?.[0]?.message || 'Unknown error'}`));
            }
        };
        
        const url = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=responseHandler:${callbackName}&sheet=${encodeURIComponent(sheetName)}`;
        
        const script = document.createElement('script');
        script.src = url;
        script.id = 'script_' + callbackName;
        script.onerror = () => {
            cleanup();
            reject(new Error(`Failed to load sheet: ${sheetName}`));
        };
        
        function cleanup() {
            delete window[callbackName];
            const el = document.getElementById('script_' + callbackName);
            if (el) el.remove();
        }
        
        document.head.appendChild(script);
    });
}

// Parse Reports from Google Sheets JSON response format (with first-row headers fallback)
function parseGvizReports(table) {
    if (!table || !table.cols || !table.rows || table.rows.length === 0) return [];
    
    const cols = table.cols;
    
    // Check if the first row contains headers
    const firstRowCells = table.rows[0].c;
    const firstRowValues = firstRowCells ? firstRowCells.map(cell => cell ? String(cell.v).toLowerCase().trim() : '') : [];
    
    const isFirstRowHeader = firstRowValues.includes('timestamp') && firstRowValues.includes('branch id');
    
    const getIndex = (key) => {
        const k = key.toLowerCase().trim();
        
        // Fallback to row 0 if it is a header row
        if (isFirstRowHeader) {
            return firstRowValues.indexOf(k);
        }
        
        // Otherwise, search inside cols labels
        return cols.findIndex(col => {
            const label = col.label.toLowerCase().trim();
            if (label === k) return true;
            if (label.includes(k)) {
                const idx = label.indexOf(k);
                const before = idx > 0 ? label[idx - 1] : ' ';
                const after = idx + k.length < label.length ? label[idx + k.length] : ' ';
                const isBoundary = (char) => /[\s\(\)\[\]_.,-]/.test(char);
                return isBoundary(before) && isBoundary(after);
            }
            return false;
        });
    };
    
    const tsIndex = getIndex('timestamp');
    const branchIdIdx = getIndex('branch id');
    const projIdIdx = getIndex('project id');
    const userstampIdx = getIndex('userstamp');
    const countryIdx = getIndex('q1win1');
    const branchNameIdx = getIndex('q2win1');
    const projNameIdx = getIndex('q1');
    const dateIdx = getIndex('q2');
    const clientIdx = getIndex('q3');
    const valIdx = getIndex('q14');
    const curIdx = getIndex('q16');
    const valUsdIdx = getIndex('q18');
    
    const results = [];
    const startIndex = isFirstRowHeader ? 1 : 0;
    
    table.rows.slice(startIndex).forEach(row => {
        if (!row || !row.c) return;
        
        const cellVal = (idx) => {
            if (idx === -1 || idx >= row.c.length) return null;
            const cell = row.c[idx];
            return cell ? cell.v : null;
        };
        
        const cellFmt = (idx) => {
            if (idx === -1 || idx >= row.c.length) return '';
            const cell = row.c[idx];
            return cell ? (cell.f || String(cell.v || '')) : '';
        };
        
        // Skip sheet key header row if it slips in
        const tsVal = cellVal(tsIndex);
        if (tsVal && String(tsVal).trim().toLowerCase() === 'timestamp') {
            return;
        }
        
        const pId = cellVal(projIdIdx) ? String(cellVal(projIdIdx)).trim() : '';
        const usdVal = parseFloat(cellVal(valUsdIdx)) || 0;
        const localVal = parseFloat(cellVal(valIdx)) || 0;
        
        results.push({
            timestamp: cellVal(tsIndex) || '',
            branchId: cellVal(branchIdIdx) || '',
            projectId: pId,
            userstamp: cellVal(userstampIdx) || '',
            country: cellVal(countryIdx) || '',
            branchName: cellVal(branchNameIdx) || '',
            projectName: cellVal(projNameIdx) || '',
            measurementDate: cellFmt(dateIdx) || cellVal(dateIdx) || '',
            clientName: cellVal(clientIdx) || '',
            contractValue: localVal,
            currency: cellVal(curIdx) || '',
            valueUsd: usdVal,
            isProjectReport: !!(pId && pId !== '')
        });
    });
    
    return results;
}

// Parse Change Requests from Google Sheets JSON response format (with first-row headers fallback)
function parseChangeRequestsGviz(table) {
    if (!table || !table.cols || !table.rows || table.rows.length === 0) return [];
    
    let headers = table.cols.map(col => col.label ? col.label.toLowerCase().trim() : '');
    
    // Check if the first row contains headers
    const firstRowCells = table.rows[0].c;
    const firstRowValues = firstRowCells ? firstRowCells.map(cell => cell ? String(cell.v).toLowerCase().trim() : '') : [];
    
    let startIndex = 0;
    if (firstRowValues.includes('request id')) {
        headers = firstRowValues;
        startIndex = 1; // Skip header row
    }
    
    const getIndex = (key) => headers.indexOf(key.toLowerCase().trim());
    
    const reqIdIdx = getIndex('request id');
    const tsIdx = getIndex('time stamp');
    const uuidIdx = getIndex('uuid');
    const countryIdx = getIndex('country');
    const branchIdx = getIndex('branch');
    const projectIdx = getIndex('project');
    const clientIdx = getIndex('customer');
    const statusIdx = getIndex('status (approved / denied)');
    const newProjIdIdx = getIndex('new project id');
    
    const results = [];
    table.rows.slice(startIndex).forEach(row => {
        if (!row || !row.c) return;
        
        const cellVal = (idx) => {
            if (idx === -1 || idx >= row.c.length) return null;
            const cell = row.c[idx];
            return cell ? cell.v : null;
        };
        
        const reqId = cellVal(reqIdIdx);
        if (!reqId) return;
        
        results.push({
            requestId: String(reqId),
            timestamp: cellVal(tsIdx) || '',
            uuid: cellVal(uuidIdx) || '',
            country: cellVal(countryIdx) || '',
            branch: cellVal(branchIdx) || '',
            project: cellVal(projectIdx) || '',
            client: cellVal(clientIdx) || '',
            status: String(cellVal(statusIdx) || '').trim().toLowerCase(),
            newProjectId: cellVal(newProjIdIdx) || ''
        });
    });
    return results;
}

// Parse UUIDs Registry from Google Sheets JSON response format (with first-row headers fallback)
function parseUUIDsGviz(table) {
    if (!table || !table.cols || !table.rows || table.rows.length === 0) return [];
    
    let headers = table.cols.map(col => col.label ? col.label.toLowerCase().trim() : '');
    
    // Check if the first row contains headers
    const firstRowCells = table.rows[0].c;
    const firstRowValues = firstRowCells ? firstRowCells.map(cell => cell ? String(cell.v).toLowerCase().trim() : '') : [];
    
    let startIndex = 0;
    if (firstRowValues.includes('uuid') && firstRowValues.includes('submittal count')) {
        headers = firstRowValues;
        startIndex = 1; // Skip header row
    }
    
    const getIndex = (key) => headers.indexOf(key.toLowerCase().trim());
    
    const uuidIdx = getIndex('uuid');
    const typeIdx = getIndex('submittal type (project_report / branch_report / change_request)');
    const projIdx = getIndex('project');
    const branchIdx = getIndex('branch');
    const countIdx = getIndex('submittal count');
    const statusIdx = getIndex('status (approved / banned)');
    
    const results = [];
    table.rows.slice(startIndex).forEach(row => {
        if (!row || !row.c) return;
        
        const cellVal = (idx) => {
            if (idx === -1 || idx >= row.c.length) return null;
            const cell = row.c[idx];
            return cell ? cell.v : null;
        };
        
        const uuid = cellVal(uuidIdx);
        if (!uuid) return;
        
        results.push({
            uuid: String(uuid),
            submittalType: cellVal(typeIdx) || '',
            project: cellVal(projIdx) || '',
            branch: cellVal(branchIdx) || '',
            count: parseInt(cellVal(countIdx)) || 0,
            status: String(cellVal(statusIdx) || '').trim().toLowerCase()
        });
    });
    return results;
}

// Format financial value in USD
function formatCurrencyUSD(value) {
    if (value >= 1e6) {
        return `$${(value / 1e6).toFixed(2)}M`;
    } else if (value >= 1e3) {
        return `$${(value / 1e3).toFixed(1)}K`;
    }
    return `$${value.toFixed(2)}`;
}

// Setup and Fetch Data
async function loadData() {
    try {
        const loader = document.getElementById('loader-overlay');
        loader.classList.remove('hidden');
        
        // Fetch tabs in parallel via JSONP (fully CORS-safe!)
        const [reportsTable, requestsTable, uuidsTable] = await Promise.all([
            fetchSheetJSONP('master output database'),
            fetchSheetJSONP('change request'),
            fetchSheetJSONP('UUIDs')
        ]);
        
        // Parse table objects
        reportsData = parseGvizReports(reportsTable);
        changeRequestsData = parseChangeRequestsGviz(requestsTable);
        uuidsData = parseUUIDsGviz(uuidsTable);
        
        // Update dashboard elements
        updateKPIs();
        renderCharts();
        populateTables();
        
        // Update connection status
        document.getElementById('pulse-indicator').classList.remove('error');
        document.getElementById('status-text').innerText = 'متصل لحظياً بالخادم';
        
        const now = new Date();
        document.getElementById('last-updated').innerText = now.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        
        loader.classList.add('hidden');
        resetTimer();
    } catch (error) {
        console.error("Dashboard error:", error);
        document.getElementById('pulse-indicator').classList.add('error');
        document.getElementById('status-text').innerText = 'فشل الاتصال بالخادم';
        
        const loader = document.getElementById('loader-overlay');
        loader.classList.add('hidden');
        resetTimer();
    }
}

// Calculate and update KPIs in UI
function updateKPIs() {
    const totalUploads = reportsData.length;
    const projectReports = reportsData.filter(r => r.isProjectReport).length;
    const branchReports = reportsData.filter(r => !r.isProjectReport).length;
    
    // Uploads Card
    document.getElementById('kpi-uploads-val').innerText = totalUploads;
    document.getElementById('kpi-uploads-sub').innerHTML = `<span>${projectReports}</span> مشروع | <span>${branchReports}</span> فرع`;
    
    // Change Requests Card
    const totalRequests = changeRequestsData.length;
    const approvedRequests = changeRequestsData.filter(req => req.status === 'approved' || req.newProjectId).length;
    const pendingRequests = totalRequests - changeRequestsData.filter(req => req.status === 'denied').length - approvedRequests;
    document.getElementById('kpi-requests-val').innerText = totalRequests;
    document.getElementById('kpi-requests-sub').innerHTML = `<span>${approvedRequests}</span> مقبول | <span>${pendingRequests}</span> قيد الانتظار`;
    
    // Coverage & Traffic
    const activeCountries = new Set(reportsData.map(r => r.country).filter(Boolean)).size;
    const activeBranches = new Set(reportsData.map(r => r.branchId).filter(Boolean)).size;
    const uniqueProjects = new Set(reportsData.map(r => r.projectId).filter(Boolean)).size;
    document.getElementById('kpi-coverage-val').innerText = uniqueProjects;
    document.getElementById('kpi-coverage-sub').innerHTML = `<span>${activeCountries}</span> دولة | <span>${activeBranches}</span> قطاعات وفروع`;
    
    // Financial USD calculation (using latest report per project to avoid double counting)
    const latestProjectReports = {};
    reportsData.forEach(r => {
        if (r.isProjectReport && r.projectId) {
            const existing = latestProjectReports[r.projectId];
            if (!existing || new Date(r.timestamp) > new Date(existing.timestamp)) {
                latestProjectReports[r.projectId] = r;
            }
        }
    });
    
    let totalUSD = 0;
    Object.values(latestProjectReports).forEach(r => {
        totalUSD += r.valueUsd;
    });
    
    document.getElementById('kpi-finance-val').innerText = formatCurrencyUSD(totalUSD);
    
    // Sum by currency
    const currencySums = {};
    Object.values(latestProjectReports).forEach(r => {
        if (r.currency) {
            currencySums[r.currency] = (currencySums[r.currency] || 0) + r.contractValue;
        }
    });
    const currencyStr = Object.entries(currencySums)
        .slice(0, 2)
        .map(([cur, val]) => `${cur === 'نيرا نيجيرى' ? 'NGN' : cur === 'دينار جزائرى' ? 'DZD' : cur.slice(0, 3)}: ${(val/1e6).toFixed(1)}M`)
        .join(' | ');
    document.getElementById('kpi-finance-sub').innerText = currencyStr || 'لا توجد بيانات مالية';
}

// Populate Data Tables
function populateTables() {
    const recentGridBody = document.getElementById('recent-uploads-body');
    recentGridBody.innerHTML = '';
    
    // Filter and Sort reports (most recent first)
    const sortedReports = [...reportsData].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    if (sortedReports.length === 0) {
        recentGridBody.innerHTML = `<tr><td colspan="7" class="table-empty-state"><i class="fa-solid fa-folder-open"></i><br>لا توجد بيانات مرفوعة حالياً</td></tr>`;
    } else {
        sortedReports.slice(0, 50).forEach(r => {
            const tr = document.createElement('tr');
            
            // Format timestamp
            const dateObj = new Date(r.timestamp);
            const dateStr = isNaN(dateObj.getTime()) ? r.timestamp : dateObj.toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' });
            
            // Format type badge
            const typeBadge = r.isProjectReport 
                ? `<span class="status-badge project">تقرير مشروع</span>`
                : `<span class="status-badge branch">تقرير فرع</span>`;
                
            // Format value
            const valStr = r.valueUsd > 0 ? formatCurrencyUSD(r.valueUsd) : '-';
            
            tr.innerHTML = `
                <td class="table-date">${dateStr}</td>
                <td>${r.country}</td>
                <td>${r.branchName}</td>
                <td>${r.isProjectReport ? r.projectName : typeBadge}</td>
                <td>${r.clientName || '-'}</td>
                <td class="table-currency">${valStr}</td>
                <td>${r.userstamp ? r.userstamp.substring(0, 8) + '...' : '-'}</td>
            `;
            recentGridBody.appendChild(tr);
        });
    }
    
    // Change Requests Table
    const reqGridBody = document.getElementById('change-requests-body');
    reqGridBody.innerHTML = '';
    
    const sortedRequests = [...changeRequestsData].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    if (sortedRequests.length === 0) {
        reqGridBody.innerHTML = `<tr><td colspan="6" class="table-empty-state"><i class="fa-solid fa-code-pull-request"></i><br>لا توجد طلبات إضافة مشاريع</td></tr>`;
    } else {
        sortedRequests.forEach(req => {
            const tr = document.createElement('tr');
            
            const dateObj = new Date(req.timestamp);
            const dateStr = isNaN(dateObj.getTime()) ? req.timestamp : dateObj.toLocaleString('ar-EG', { dateStyle: 'short' });
            
            let statusBadge = '<span class="status-badge pending">قيد الانتظار</span>';
            if (req.status === 'approved' || req.newProjectId) {
                statusBadge = '<span class="status-badge approved">تم القبول</span>';
            } else if (req.status === 'denied') {
                statusBadge = '<span class="status-badge error" style="background: rgba(239, 68, 68, 0.15); color: #EF4444; padding: 4px 10px; border-radius: 6px; font-weight:700;">مرفوض</span>';
            }
            
            tr.innerHTML = `
                <td class="table-date">${dateStr}</td>
                <td>${req.country}</td>
                <td>${req.branch}</td>
                <td style="font-weight: 700;">${req.project}</td>
                <td>${req.client || '-'}</td>
                <td>${statusBadge}</td>
            `;
            reqGridBody.appendChild(tr);
        });
    }
}

// Generate reports by country and aggregate reports by type
function renderCharts() {
    const cssStyle = getComputedStyle(document.documentElement);
    const accentColor = cssStyle.getPropertyValue('--theme-accent').trim();
    const mutedColor = cssStyle.getPropertyValue('--theme-muted').trim();
    const deepColor = cssStyle.getPropertyValue('--theme-deep').trim();
    const panelColor = cssStyle.getPropertyValue('--theme-panel').trim();
    
    // 1. Report Type breakdown
    const projectReports = reportsData.filter(r => r.isProjectReport).length;
    const branchReports = reportsData.filter(r => !r.isProjectReport).length;
    
    const typeCtx = document.getElementById('reportTypeChart').getContext('2d');
    if (typeChart) typeChart.destroy();
    
    typeChart = new Chart(typeCtx, {
        type: 'doughnut',
        data: {
            labels: ['تقارير المشروعات', 'تقارير الفروع'],
            datasets: [{
                data: [projectReports, branchReports],
                backgroundColor: [accentColor, '#3B82F6'],
                borderColor: panelColor,
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { color: '#FFFFFF', font: { family: 'Tajawal' } }
                }
            }
        }
    });
    
    // 2. Activity Timeline over time
    const activityTimeline = {};
    reportsData.forEach(r => {
        const dateObj = new Date(r.timestamp);
        if (!isNaN(dateObj.getTime())) {
            const dayStr = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            activityTimeline[dayStr] = (activityTimeline[dayStr] || 0) + 1;
        }
    });
    
    // Sort timeline keys by date
    const sortedDays = Object.keys(activityTimeline).sort((a, b) => new Date(a) - new Date(b)).slice(-10);
    const activityCounts = sortedDays.map(d => activityTimeline[d]);
    
    const timelineCtx = document.getElementById('timelineChart').getContext('2d');
    if (timelineChart) timelineChart.destroy();
    
    timelineChart = new Chart(timelineCtx, {
        type: 'line',
        data: {
            labels: sortedDays,
            datasets: [{
                label: 'عدد التحديثات المرفوعة',
                data: activityCounts,
                borderColor: accentColor,
                backgroundColor: 'rgba(252, 163, 17, 0.1)',
                borderWidth: 3,
                fill: true,
                tension: 0.3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    ticks: { color: '#A0AEC0', font: { family: 'Outfit' } },
                    grid: { color: 'rgba(255, 255, 255, 0.05)' }
                },
                y: {
                    ticks: { color: '#A0AEC0', font: { family: 'Outfit' }, stepSize: 1 },
                    grid: { color: 'rgba(255, 255, 255, 0.05)' }
                }
            },
            plugins: {
                legend: { display: false }
            }
        }
    });
    
    // 3. Reports by Country sidebar list
    const countryCounts = {};
    reportsData.forEach(r => {
        if (r.country) {
            countryCounts[r.country] = (countryCounts[r.country] || 0) + 1;
        }
    });
    
    const countryListEl = document.getElementById('countries-list');
    countryListEl.innerHTML = '';
    
    const sortedCountries = Object.entries(countryCounts).sort((a, b) => b[1] - a[1]);
    
    if (sortedCountries.length === 0) {
        countryListEl.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 20px;">لا توجد دول مسجلة</div>`;
    } else {
        const maxVal = sortedCountries[0][1];
        sortedCountries.forEach(([country, count]) => {
            const fillWidth = (count / maxVal) * 100;
            const flagClass = getFlagIconClass(country);
            
            const div = document.createElement('div');
            div.className = 'country-stat-row';
            div.innerHTML = `
                <div class="country-name-info">
                    <span class="fi ${flagClass}"></span>
                    <span>${country}</span>
                </div>
                <div class="country-bar-fill" style="background: linear-gradient(to left, rgba(var(--theme-accent-rgb), 0.15) ${fillWidth}%, transparent ${fillWidth}%)">
                    ${count} تقارير
                </div>
            `;
            countryListEl.appendChild(div);
        });
    }
}

// Get flag icon class based on Arabic country name
function getFlagIconClass(countryName) {
    const flags = {
        'جمهورية مصر العربية': 'fi-eg',
        'مصر': 'fi-eg',
        'المملكة العربية السعودية': 'fi-sa',
        'السعودية': 'fi-sa',
        'الإمارات العربية المتحدة': 'fi-ae',
        'الإمارات': 'fi-ae',
        'جمهورية نيجيريا الاتحادية': 'fi-ng',
        'نيجيريا': 'fi-ng',
        'الجمهورية الجزائرية الديمقراطية الشعبية': 'fi-dz',
        'الجزائر': 'fi-dz',
        'جمهورية تشاد': 'fi-td',
        'تشاد': 'fi-td',
        'اتحاد جزر القمر': 'fi-km',
        'جزر القمر': 'fi-km'
    };
    return flags[countryName.trim()] || 'fi-xx';
}

// Filter Tables by Search Query
function filterTable() {
    const query = document.getElementById('search-box').value.trim().toLowerCase();
    const rows = document.querySelectorAll('#recent-uploads-body tr');
    
    rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        if (text.includes(query)) {
            row.style.display = '';
        } else {
            row.style.display = 'none';
        }
    });
}

// Tab Switching
function switchTab(tabId, btn) {
    // Deactivate all tabs
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    
    // Activate clicked tab
    btn.classList.add('active');
    document.getElementById(tabId).classList.add('active');
}

// Real-time Timer Sync countdown
function resetTimer() {
    clearInterval(syncTimer);
    secondsRemaining = REFRESH_INTERVAL_SECONDS;
    updateTimerUI();
    
    syncTimer = setInterval(() => {
        secondsRemaining--;
        updateTimerUI();
        if (secondsRemaining <= 0) {
            clearInterval(syncTimer);
            loadData();
        }
    }, 1000);
}

function updateTimerUI() {
    document.getElementById('countdown-seconds').innerText = secondsRemaining;
}

// Theme management
function selectTheme(themeName) {
    document.documentElement.setAttribute('data-theme', themeName);
    localStorage.setItem('appTheme', themeName);
    
    // Update theme active class in menu
    document.querySelectorAll('.theme-menu-option').forEach(opt => {
        if (opt.getAttribute('data-theme') === themeName) {
            opt.classList.add('active');
        } else {
            opt.classList.remove('active');
        }
    });
    
    // Reload charts to update visual colors
    if (reportsData.length > 0) {
        setTimeout(renderCharts, 100);
    }
}

// Initialize on page load
window.addEventListener('DOMContentLoaded', () => {
    // Setup Theme from localStorage
    const savedTheme = localStorage.getItem('appTheme') || 'corporate';
    selectTheme(savedTheme);
    
    // Load initial data
    loadData();
    
    // Toggle Theme Selector dropdown menu
    const themeBtn = document.getElementById('theme-btn');
    const themeMenu = document.getElementById('theme-menu');
    
    themeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        themeMenu.classList.toggle('open');
    });
    
    document.addEventListener('click', () => {
        themeMenu.classList.remove('open');
    });
    
    document.querySelectorAll('.theme-menu-option').forEach(opt => {
        opt.addEventListener('click', () => {
            const theme = opt.getAttribute('data-theme');
            selectTheme(theme);
        });
    });
    
    // Refresh Button Click
    document.getElementById('refresh-btn').addEventListener('click', () => {
        loadData();
    });
    
    // Search Box Input
    document.getElementById('search-box').addEventListener('input', () => {
        filterTable();
    });
});
