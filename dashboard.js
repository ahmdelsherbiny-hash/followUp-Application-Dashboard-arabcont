// Real-time Dashboard Core Logic for Follow-up Application (JSONP CORS-Safe Version)
const SPREADSHEET_ID = '1eRp9k1JWjvyFO8IymyEUAu7Sd6woqgu4Oe0D26xY5k4';
const REFRESH_INTERVAL_SECONDS = 30;

let reportsData = [];
let changeRequestsData = [];
let uuidsData = [];

// Dropdown registry mappings
let expectedBranches = new Set();
let expectedProjects = new Set();
let projectToBranchMap = {};
let branchToCountryMap = {};
let projectToCountryMap = {};

let syncTimer = null;
let secondsRemaining = REFRESH_INTERVAL_SECONDS;

// Chart references for dynamic updates

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
        if (loader) loader.classList.remove('hidden');
        
        // Fetch 4 tabs in parallel via JSONP (fully CORS-safe!)
        const [reportsTable, requestsTable, uuidsTable, ddTable] = await Promise.all([
            fetchSheetJSONP('master output database'),
            fetchSheetJSONP('change request'),
            fetchSheetJSONP('UUIDs'),
            fetchSheetJSONP('dd_lst')
        ]);
        
        // Parse registries first
        parseDropdownRegistry(ddTable);
        
        // Parse table objects
        const rawReports = parseGvizReports(reportsTable);
        reportsData = deduplicateReports(rawReports);
        changeRequestsData = parseChangeRequestsGviz(requestsTable);
        uuidsData = parseUUIDsGviz(uuidsTable);
        
        // Update dashboard elements
        updateKPIs();
        renderCharts();
        populateTables();
        
        // Update connection status
        const pulse = document.getElementById('pulse-indicator');
        if (pulse) pulse.classList.remove('error');
        const statusText = document.getElementById('status-text');
        if (statusText) statusText.innerText = 'متصل لحظياً بالخادم';
        
        const now = new Date();
        const lastUpdated = document.getElementById('last-updated');
        if (lastUpdated) lastUpdated.innerText = now.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        
        if (loader) loader.classList.add('hidden');
        resetTimer();
    } catch (error) {
        console.error("Dashboard error:", error);
        const pulse = document.getElementById('pulse-indicator');
        if (pulse) pulse.classList.add('error');
        const statusText = document.getElementById('status-text');
        if (statusText) statusText.innerText = 'فشل الاتصال بالخادم';
        
        const loader = document.getElementById('loader-overlay');
        if (loader) loader.classList.add('hidden');
        resetTimer();
    }
}

// Calculate and update KPIs in UI
function updateKPIs() {
    const totalUploads = reportsData.length;
    const projectReports = reportsData.filter(r => r.isProjectReport).length;
    const branchReports = reportsData.filter(r => !r.isProjectReport).length;
    
    // Uploads Card
    const uploadsVal = document.getElementById('kpi-uploads-val');
    if (uploadsVal) uploadsVal.innerText = totalUploads;
    const uploadsSub = document.getElementById('kpi-uploads-sub');
    if (uploadsSub) uploadsSub.innerHTML = `<span>${projectReports}</span> مشروع | <span>${branchReports}</span> فرع`;
    
    // Change Requests Card
    const totalRequests = changeRequestsData.length;
    const approvedRequests = changeRequestsData.filter(req => req.status === 'approved' || req.newProjectId).length;
    const pendingRequests = totalRequests - changeRequestsData.filter(req => req.status === 'denied').length - approvedRequests;
    const requestsVal = document.getElementById('kpi-requests-val');
    if (requestsVal) requestsVal.innerText = totalRequests;
    const requestsSub = document.getElementById('kpi-requests-sub');
    if (requestsSub) requestsSub.innerHTML = `<span>${approvedRequests}</span> مقبول | <span>${pendingRequests}</span> قيد الانتظار`;
    
    // Coverage & Traffic
    const activeCountries = new Set(reportsData.map(r => r.country).filter(Boolean)).size;
    const uniqueProjects = new Set(reportsData.map(r => r.projectName).filter(Boolean)).size;
    const coverageVal = document.getElementById('kpi-coverage-val');
    if (coverageVal) coverageVal.innerText = uniqueProjects;
    const coverageSub = document.getElementById('kpi-coverage-sub');
    if (coverageSub) coverageSub.innerHTML = `<span>${activeCountries}</span> دولة | <span>${expectedBranches.size}</span> قطاعات وفروع`;
    
    // Calculate Project and Branch commitment rates
    const reportsByMonth = {};
    reportsData.forEach(r => {
        const d = new Date(r.timestamp);
        if (isNaN(d.getTime())) return;
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (!reportsByMonth[key]) {
            reportsByMonth[key] = { projects: new Set(), branches: new Set(), raw: [] };
        }
        reportsByMonth[key].raw.push(r);
        if (r.isProjectReport && r.projectName) {
            if (expectedProjects.has(r.projectName)) {
                reportsByMonth[key].projects.add(r.projectName);
            }
        } else if (!r.isProjectReport && r.branchName) {
            if (expectedBranches.has(r.branchName)) {
                reportsByMonth[key].branches.add(r.branchName);
            }
        }
    });

    const monthsList = Object.keys(reportsByMonth).sort();
    let activeMonth = '';
    if (monthsList.length === 0) {
        const now = new Date();
        activeMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    } else {
        activeMonth = monthsList[monthsList.length - 1];
    }

    const activeData = reportsByMonth[activeMonth] || { projects: new Set(), branches: new Set(), raw: [] };
    const totalProjs = expectedProjects.size || 114;
    const totalBranches = expectedBranches.size || 28;
    
    const projPercent = Math.min(100, Math.round((activeData.projects.size / totalProjs) * 100)) || 0;
    const branchPercent = Math.min(100, Math.round((activeData.branches.size / totalBranches) * 100)) || 0;

    // Update KPI Cards
    const projValEl = document.getElementById('kpi-proj-commitment-val');
    if (projValEl) projValEl.innerText = `${projPercent}%`;
    const projSubEl = document.getElementById('kpi-proj-commitment-sub');
    if (projSubEl) projSubEl.innerText = `${activeData.projects.size} من ${totalProjs} مشروع`;

    const branchValEl = document.getElementById('kpi-branch-commitment-val');
    if (branchValEl) branchValEl.innerText = `${branchPercent}%`;
    const branchSubEl = document.getElementById('kpi-branch-commitment-sub');
    if (branchSubEl) branchSubEl.innerText = `${activeData.branches.size} من ${totalBranches} فرع`;

    // Setup Modal bindings
    setupModalBindings(activeMonth, activeData);
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
    const textColor = cssStyle.getPropertyValue('--text-primary').trim() || '#FFFFFF';
    const gridColor = `rgba(${cssStyle.getPropertyValue('--theme-accent-rgb').trim() || '255, 255, 255'}, 0.2)`;
    

    
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
                    ticks: { color: textColor, font: { family: 'Outfit' } },
                    grid: { color: gridColor }
                },
                y: {
                    ticks: { color: textColor, font: { family: 'Outfit' }, stepSize: 1 },
                    grid: { color: gridColor }
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
        'جزر القمر': 'fi-km',
        'سلطنة عُمان': 'fi-om',
        'سلطنة عمان': 'fi-om',
        'عمان': 'fi-om',
        'أوغندا': 'fi-ug',
        'جمهورية أوغندا': 'fi-ug',
        'زامبيا': 'fi-zm',
        'جمهورية زامبيا': 'fi-zm',
        'غانا': 'fi-gh',
        'جمهورية غانا': 'fi-gh',
        'غينيا': 'fi-gn',
        'جمهورية غينيا': 'fi-gn',
        'الكاميرون': 'fi-cm',
        'جمهورية الكاميرون': 'fi-cm',
        'كوت ديفوار': 'fi-ci',
        'ساحل العاج': 'fi-ci',
        'الكونغو': 'fi-cg',
        'جمهورية الكونغو الديمقراطية': 'fi-cd',
        'قطر': 'fi-qa',
        'دولة قطر': 'fi-qa'
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
    
    // Reload charts to update visual colors
    if (typeof renderCharts === 'function' && reportsData.length > 0) {
        setTimeout(renderCharts, 100);
    }
}

function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'corporate';
    const nextTheme = currentTheme === 'corporate' ? 'aegov' : 'corporate';
    selectTheme(nextTheme);
}

// deduplicate files uploaded twice: Keep only the latest report for each unique project/branch per YYYY-MM cycle
function deduplicateReports(reports) {
    const uniqueMap = {};
    reports.forEach(r => {
        const d = new Date(r.timestamp);
        if (isNaN(d.getTime())) return;
        const cycleKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        
        const id = r.isProjectReport ? (r.projectId || r.projectName) : (r.branchId || r.branchName);
        if (!id) return;
        
        const key = `${cycleKey}_${r.isProjectReport ? 'P' : 'B'}_${id}`;
        
        const existing = uniqueMap[key];
        if (!existing || new Date(r.timestamp) > new Date(existing.timestamp)) {
            uniqueMap[key] = r;
        }
    });
    return Object.values(uniqueMap);
}

// Parse Dropdown Registry (dd_lst)
function parseDropdownRegistry(table) {
    expectedBranches.clear();
    expectedProjects.clear();
    projectToBranchMap = {};
    branchToCountryMap = {};
    projectToCountryMap = {};
    
    if (!table || !table.rows) return;
    
    table.rows.forEach(row => {
        if (!row || !row.c) return;
        
        // Branch Registry (Col 3) and its Country filter (Col 2)
        const branchCell = row.c[3];
        const countryCell = row.c[2];
        if (branchCell && branchCell.v !== null) {
            const bName = String(branchCell.v).trim();
            if (bName && bName.toLowerCase() !== 'dropdown_lst2') {
                expectedBranches.add(bName);
                if (countryCell && countryCell.v !== null) {
                    const cName = String(countryCell.v).trim();
                    branchToCountryMap[bName] = cName;
                }
            }
        }
        
        // Project Registry (Col 6) and its Branch filter (Col 5)
        const projCell = row.c[6];
        const projBranchCell = row.c[5];
        if (projCell && projCell.v !== null) {
            const pName = String(projCell.v).trim();
            if (pName && pName.toLowerCase() !== 'dropdown_lst3') {
                expectedProjects.add(pName);
                if (projBranchCell && projBranchCell.v !== null) {
                    const pbName = String(projBranchCell.v).trim();
                    projectToBranchMap[pName] = pbName;
                }
            }
        }
    });
    
    // Resolve project to country
    expectedProjects.forEach(pName => {
        const branch = projectToBranchMap[pName] || '';
        const country = branchToCountryMap[branch] || '-';
        projectToCountryMap[pName] = country;
    });
}

// Setup Pop-up modal list binders and data populations
function setupModalBindings(activeMonth, activeData) {
    const projCard = document.getElementById('kpi-proj-commitment-card');
    const branchCard = document.getElementById('kpi-branch-commitment-card');
    const modal = document.getElementById('compliance-modal');
    const modalCloseBtn = document.getElementById('modal-close-btn');
    const modalTitle = document.getElementById('modal-title');
    const submittedBody = document.getElementById('modal-submitted-body');
    const lateBody = document.getElementById('modal-late-body');
    
    if (!modal || !modalCloseBtn || !submittedBody || !lateBody || !projCard || !branchCard) return;
    
    const formatArabicMonth = (monthKey) => {
        const [yr, mn] = monthKey.split('-');
        const arabicMonths = {
            '01': 'يناير', '02': 'فبراير', '03': 'مارس', '04': 'أبريل',
            '05': 'مايو', '06': 'يونيو', '07': 'يوليو', '08': 'أغسطس',
            '09': 'سبتمبر', '10': 'أكتوبر', '11': 'نوفمبر', '12': 'ديسمبر'
        };
        return `${arabicMonths[mn] || mn} ${yr}`;
    };
    
    const showModal = (type) => {
        submittedBody.innerHTML = '';
        lateBody.innerHTML = '';
        
        if (type === 'project') {
            modalTitle.innerText = `التزام المشروعات - دورة ${formatArabicMonth(activeMonth)}`;
            
            // Populate Submitted Projects
            let submittedCount = 0;
            activeData.raw.forEach(r => {
                if (r.isProjectReport && r.projectName) {
                    submittedCount++;
                    const tr = document.createElement('tr');
                    const country = r.country || projectToCountryMap[r.projectName] || '-';
                    const dObj = new Date(r.timestamp);
                    const timeStr = isNaN(dObj.getTime()) ? r.timestamp : dObj.toLocaleDateString('ar-EG', {month:'short', day:'numeric'}) + ' ' + dObj.toLocaleTimeString('ar-EG', {hour:'2-digit', minute:'2-digit'});
                    
                    tr.innerHTML = `
                        <td style="font-weight:700;">${r.projectName}</td>
                        <td>${country}</td>
                        <td style="font-family:'Outfit'; font-size:10px;">${timeStr}</td>
                    `;
                    submittedBody.appendChild(tr);
                }
            });
            if (submittedCount === 0) {
                submittedBody.innerHTML = `<tr><td colspan="3" style="text-align:center; color:var(--text-muted); padding:20px;">لم يتم تسليم أي تقارير بعد</td></tr>`;
            }
            
            // Populate Unsubmitted Projects
            let lateCount = 0;
            expectedProjects.forEach(pName => {
                if (!activeData.projects.has(pName)) {
                    lateCount++;
                    const tr = document.createElement('tr');
                    const country = projectToCountryMap[pName] || '-';
                    tr.innerHTML = `
                        <td style="font-weight:700;">${pName}</td>
                        <td>${country}</td>
                        <td><span class="status-late">لم يرسل</span></td>
                    `;
                    lateBody.appendChild(tr);
                }
            });
            if (lateCount === 0) {
                lateBody.innerHTML = `<tr><td colspan="3" style="text-align:center; color:#10B981; font-weight:700; padding:20px;">🏆 التزام كامل من جميع المشاريع!</td></tr>`;
            }
            
        } else if (type === 'branch') {
            modalTitle.innerText = `التزام الفروع والشركات - دورة ${formatArabicMonth(activeMonth)}`;
            
            // Populate Submitted Branches
            let submittedCount = 0;
            activeData.raw.forEach(r => {
                if (!r.isProjectReport && r.branchName) {
                    submittedCount++;
                    const tr = document.createElement('tr');
                    const country = r.country || branchToCountryMap[r.branchName] || '-';
                    const dObj = new Date(r.timestamp);
                    const timeStr = isNaN(dObj.getTime()) ? r.timestamp : dObj.toLocaleDateString('ar-EG', {month:'short', day:'numeric'}) + ' ' + dObj.toLocaleTimeString('ar-EG', {hour:'2-digit', minute:'2-digit'});
                    
                    tr.innerHTML = `
                        <td style="font-weight:700;">${r.branchName}</td>
                        <td>${country}</td>
                        <td style="font-family:'Outfit'; font-size:10px;">${timeStr}</td>
                    `;
                    submittedBody.appendChild(tr);
                }
            });
            if (submittedCount === 0) {
                submittedBody.innerHTML = `<tr><td colspan="3" style="text-align:center; color:var(--text-muted); padding:20px;">لم يتم تسليم أي تقارير بعد</td></tr>`;
            }
            
            // Populate Unsubmitted Branches
            let lateCount = 0;
            expectedBranches.forEach(bName => {
                if (!activeData.branches.has(bName)) {
                    lateCount++;
                    const tr = document.createElement('tr');
                    const country = branchToCountryMap[bName] || '-';
                    tr.innerHTML = `
                        <td style="font-weight:700;">${bName}</td>
                        <td>${country}</td>
                        <td><span class="status-late">لم يرسل</span></td>
                    `;
                    lateBody.appendChild(tr);
                }
            });
            if (lateCount === 0) {
                lateBody.innerHTML = `<tr><td colspan="3" style="text-align:center; color:#10B981; font-weight:700; padding:20px;">🏆 التزام كامل من جميع الفروع!</td></tr>`;
            }
        }
        
        modal.classList.remove('hidden');
        setTimeout(() => modal.classList.add('show'), 10);
    };
    
    const hideModal = () => {
        modal.classList.remove('show');
        setTimeout(() => modal.classList.add('hidden'), 300);
    };
    
    // Bind clicks safely
    projCard.onclick = () => showModal('project');
    branchCard.onclick = () => showModal('branch');
    modalCloseBtn.onclick = hideModal;
    
    modal.onclick = (e) => {
        if (e.target === modal) hideModal();
    };
}

// Initialize on page load
window.addEventListener('DOMContentLoaded', () => {
    // Setup Theme from localStorage
    const savedTheme = localStorage.getItem('appTheme') || 'corporate';
    selectTheme(savedTheme);
    
    // Load initial data
    loadData();
    
    // Bind Theme Toggle Button Click
    const toggleBtn = document.getElementById('theme-toggle-btn');
    if (toggleBtn) {
        toggleBtn.addEventListener('click', toggleTheme);
    }
    
    // Refresh Button Click
    const refreshBtn = document.getElementById('refresh-btn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            loadData();
        });
    }
    
    // Search Box Input
    const searchBox = document.getElementById('search-box');
    if (searchBox) {
        searchBox.addEventListener('input', () => {
            filterTable();
        });
    }
});
