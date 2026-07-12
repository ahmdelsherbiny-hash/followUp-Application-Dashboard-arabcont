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

// Chart references
let profilePieChart = null;
let profileHistoChart = null;

// Safe DOM Setters to prevent script crashes on caching or mismatched layouts
function setTxt(id, val) {
    const el = document.getElementById(id);
    if (el) el.innerText = val;
}

function setHtml(id, val) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = val;
}

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
    
    const firstRowCells = table.rows[0].c;
    const firstRowValues = firstRowCells ? firstRowCells.map(cell => cell ? String(cell.v).toLowerCase().trim() : '') : [];
    
    const isFirstRowHeader = firstRowValues.includes('timestamp') && firstRowValues.includes('branch id');
    
    const getIndex = (key) => {
        const k = key.toLowerCase().trim();
        
        if (isFirstRowHeader) {
            return firstRowValues.indexOf(k);
        }
        
        return cols.findIndex(col => {
            if (!col || !col.label) return false;
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
    
    // Key KPIs Column Indices
    const valIdx = getIndex('q14'); // contractValue (local)
    const valUsdIdx = getIndex('q18'); // valueUsd
    const curIdx = getIndex('q16'); // currency
    const q32Idx = getIndex('q32'); // Project P&L
    const q132Idx = getIndex('q1.32'); // Branch P&L
    const q24Idx = getIndex('q24'); // Project planned progress %
    const q20Idx = getIndex('q20'); // Executed Value (Billed)
    
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
        
        const tsVal = cellVal(tsIndex);
        if (tsVal && String(tsVal).trim().toLowerCase() === 'timestamp') {
            return;
        }
        
        const pId = cellVal(projIdIdx) ? String(cellVal(projIdIdx)).trim() : '';
        const isProject = !!(pId && pId !== '');
        
        const usdVal = parseFloat(cellVal(valUsdIdx)) || 0;
        const localVal = parseFloat(cellVal(valIdx)) || 0;
        const pnlVal = isProject ? (parseFloat(cellVal(q32Idx)) || 0) : (parseFloat(cellVal(q132Idx)) || 0);
        const progressVal = isProject ? (parseFloat(cellVal(q24Idx)) || 0) : 0;
        const executedVal = isProject ? (parseFloat(cellVal(q20Idx)) || 0) : 0;
        
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
            isProjectReport: isProject,
            pnl: pnlVal,
            progress: progressVal,
            executedValue: executedVal
        });
    });
    
    return results;
}

// Parse Change Requests
function parseChangeRequestsGviz(table) {
    if (!table || !table.cols || !table.rows || table.rows.length === 0) return [];
    
    let headers = table.cols.map(col => col && col.label ? col.label.toLowerCase().trim() : '');
    const firstRowCells = table.rows[0].c;
    const firstRowValues = firstRowCells ? firstRowCells.map(cell => cell ? String(cell.v).toLowerCase().trim() : '') : [];
    
    let startIndex = 0;
    if (firstRowValues.includes('request id')) {
        headers = firstRowValues;
        startIndex = 1;
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

// Parse UUIDs Registry
function parseUUIDsGviz(table) {
    if (!table || !table.cols || !table.rows || table.rows.length === 0) return [];
    
    let headers = table.cols.map(col => col && col.label ? col.label.toLowerCase().trim() : '');
    const firstRowCells = table.rows[0].c;
    const firstRowValues = firstRowCells ? firstRowCells.map(cell => cell ? String(cell.v).toLowerCase().trim() : '') : [];
    
    let startIndex = 0;
    if (firstRowValues.includes('uuid') && firstRowValues.includes('submittal count')) {
        headers = firstRowValues;
        startIndex = 1;
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

// deduplicate files uploaded twice: Keep only the latest report for each unique context & measurement date
function deduplicateReports(reports) {
    const uniqueMap = {};
    reports.forEach(r => {
        const id = r.isProjectReport ? (r.projectId || r.projectName) : (r.branchId || r.branchName);
        const date = r.measurementDate || 'no_date';
        const key = `${r.isProjectReport ? 'P' : 'B'}_${id}_${date}`;
        
        const existing = uniqueMap[key];
        if (!existing || new Date(r.timestamp) > new Date(existing.timestamp)) {
            uniqueMap[key] = r;
        }
    });
    return Object.values(uniqueMap);
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

// Main Setup and Fetch Data
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
        
        // Parse data tables
        const rawReports = parseGvizReports(reportsTable);
        reportsData = deduplicateReports(rawReports); // Apply duplicate filtering
        changeRequestsData = parseChangeRequestsGviz(requestsTable);
        uuidsData = parseUUIDsGviz(uuidsTable);
        
        // Update general KPIs (Header-level)
        updateHeaderKPIs();
        
        // Update Tab 1 (Reporting rates / lists)
        updateTab1Reporting();
        
        // Update Tab 2 (Management KPIs / scrolling ticker / grid)
        updateTab2Management();
        
        // Update Tab 3 (Hierarchical selectors / profile)
        updateTab3Dropdowns();
        
        // Update connection status
        const pulse = document.getElementById('pulse-indicator');
        if (pulse) pulse.classList.remove('error');
        setTxt('status-text', 'متصل لحظياً بالخادم');
        
        const now = new Date();
        setTxt('last-updated', now.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
        
        if (loader) loader.classList.add('hidden');
        resetTimer();
    } catch (error) {
        console.error("Dashboard full stack error:", error);
        
        // Safe UI failure indicators
        const pulse = document.getElementById('pulse-indicator');
        if (pulse) pulse.classList.add('error');
        setTxt('status-text', 'فشل الاتصال بالخادم');
        
        const loader = document.getElementById('loader-overlay');
        if (loader) loader.classList.add('hidden');
        resetTimer();
    }
}

// Calculate general header-level KPIs
function updateHeaderKPIs() {
    const totalUploads = reportsData.length;
    const projectReports = reportsData.filter(r => r.isProjectReport).length;
    const branchReports = reportsData.filter(r => !r.isProjectReport).length;
    
    // Uploads Card
    setTxt('kpi-uploads-val', totalUploads);
    setHtml('kpi-uploads-sub', `<span>${projectReports}</span> مشروع | <span>${branchReports}</span> فرع`);
    
    // Change Requests Card
    const totalRequests = changeRequestsData.length;
    const approvedRequests = changeRequestsData.filter(req => req.status === 'approved' || req.newProjectId).length;
    const pendingRequests = totalRequests - changeRequestsData.filter(req => req.status === 'denied').length - approvedRequests;
    setTxt('kpi-requests-val', totalRequests);
    setHtml('kpi-requests-sub', `<span>${approvedRequests}</span> مقبول | <span>${pendingRequests}</span> قيد الانتظار`);
    
    // Coverage & Traffic
    const activeCountries = new Set(reportsData.map(r => r.country).filter(Boolean)).size;
    const uniqueProjects = new Set(reportsData.map(r => r.projectName).filter(Boolean)).size;
    setTxt('kpi-coverage-val', uniqueProjects);
    setHtml('kpi-coverage-sub', `<span>${activeCountries}</span> دولة | <span>${expectedBranches.size}</span> قطاعات وفروع مسجلة`);
}

// Tab 1: Monthly Reporting Upload KPIs & Auto-reset Month cycle state machine
function updateTab1Reporting() {
    // Group reports by month based on timestamp (YYYY-MM)
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
    let isComplete = false;

    if (monthsList.length === 0) {
        const now = new Date();
        activeMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    } else {
        const latestMonth = monthsList[monthsList.length - 1];
        const mData = reportsByMonth[latestMonth];
        
        const totalProjs = expectedProjects.size || 114;
        const totalBranches = expectedBranches.size || 28;
        
        const projPercent = (mData.projects.size / totalProjs) * 100;
        const branchPercent = (mData.branches.size / totalBranches) * 100;
        
        // Auto-reset state machine: If both reach 100%, cycle resets for the next month!
        if (projPercent >= 100 && branchPercent >= 100) {
            isComplete = true;
            const [yr, mn] = latestMonth.split('-').map(Number);
            let nextYr = yr;
            let nextMn = mn + 1;
            if (nextMn > 12) {
                nextMn = 1;
                nextYr += 1;
            }
            activeMonth = `${nextYr}-${String(nextMn).padStart(2, '0')}`;
        } else {
            activeMonth = latestMonth;
        }
    }

    // Format Arabic label for active cycle
    const [yr, mn] = activeMonth.split('-');
    const arabicMonths = {
        '01': 'يناير', '02': 'فبراير', '03': 'مارس', '04': 'أبريل',
        '05': 'مايو', '06': 'يونيو', '07': 'يوليو', '08': 'أغسطس',
        '09': 'سبتمبر', '10': 'أكتوبر', '11': 'نوفمبر', '12': 'ديسمبر'
    };
    const cycleLabel = `دورة المتابعة لشهر ${arabicMonths[mn] || mn} ${yr}`;
    setTxt('active-month-title', cycleLabel);

    const cycleBadge = document.getElementById('cycle-status-badge');
    if (cycleBadge) {
        if (isComplete) {
            cycleBadge.innerText = 'دورة مكتملة - تم إعادة الضبط';
            cycleBadge.className = 'cycle-badge complete';
        } else {
            cycleBadge.innerText = 'دورة نشطة جارٍ استلامها';
            cycleBadge.className = 'cycle-badge';
        }
    }

    // Get statistics for the active month
    const activeData = reportsByMonth[activeMonth] || { projects: new Set(), branches: new Set(), raw: [] };
    const totalProjs = expectedProjects.size || 114;
    const totalBranches = expectedBranches.size || 28;
    
    const projPercent = Math.min(100, Math.round((activeData.projects.size / totalProjs) * 100)) || 0;
    const branchPercent = Math.min(100, Math.round((activeData.branches.size / totalBranches) * 100)) || 0;

    // Update Progress Ring SVG dials (dasharray circumference = 364.42)
    const ringCircumference = 364.42;
    
    const projCircle = document.getElementById('proj-progress-circle');
    if (projCircle) {
        const projOffset = ringCircumference - (projPercent / 100) * ringCircumference;
        projCircle.style.strokeDashoffset = projOffset;
    }
    setTxt('proj-progress-percent', `${projPercent}%`);
    setTxt('proj-progress-numbers', `${activeData.projects.size} من ${totalProjs} مشروع`);

    const branchCircle = document.getElementById('branch-progress-circle');
    if (branchCircle) {
        const branchOffset = ringCircumference - (branchPercent / 100) * ringCircumference;
        branchCircle.style.strokeDashoffset = branchOffset;
    }
    setTxt('branch-progress-percent', `${branchPercent}%`);
    setTxt('branch-progress-numbers', `${activeData.branches.size} من ${totalBranches} فرع`);

    // Separate Submitted and Late lists
    const submittedListBody = document.getElementById('submitted-list-body');
    const lateListBody = document.getElementById('late-list-body');

    if (submittedListBody) {
        submittedListBody.innerHTML = '';
        let submittedCount = 0;
        activeData.raw.forEach(r => {
            submittedCount++;
            const tr = document.createElement('tr');
            const dateObj = new Date(r.timestamp);
            const timeStr = isNaN(dateObj.getTime()) ? r.timestamp : dateObj.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
            const typeBadge = r.isProjectReport 
                ? `<span class="type-proj">مشروع</span>` 
                : `<span class="type-branch">فرع</span>`;
            const name = r.isProjectReport ? r.projectName : r.branchName;
            const country = r.country || (r.isProjectReport ? projectToCountryMap[name] : branchToCountryMap[name]) || '-';

            tr.innerHTML = `
                <td style="font-weight:700;">${name}</td>
                <td>${typeBadge}</td>
                <td>${country}</td>
                <td style="font-family:'Outfit';">${timeStr}</td>
            `;
            submittedListBody.appendChild(tr);
        });
        setTxt('submitted-count', submittedCount);
        if (submittedCount === 0) {
            submittedListBody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:var(--text-muted); padding:30px;">لم يتم استلام أي تقارير بعد في هذه الدورة.</td></tr>`;
        }
    }

    if (lateListBody) {
        lateListBody.innerHTML = '';
        let lateCount = 0;
        
        // Find late projects
        expectedProjects.forEach(pName => {
            if (!activeData.projects.has(pName)) {
                lateCount++;
                const tr = document.createElement('tr');
                const country = projectToCountryMap[pName] || '-';
                tr.innerHTML = `
                    <td style="font-weight:700;">${pName}</td>
                    <td><span class="type-proj">مشروع</span></td>
                    <td>${country}</td>
                    <td><span class="status-late">لم يرسل</span></td>
                `;
                lateListBody.appendChild(tr);
            }
        });

        // Find late branches
        expectedBranches.forEach(bName => {
            if (!activeData.branches.has(bName)) {
                lateCount++;
                const tr = document.createElement('tr');
                const country = branchToCountryMap[bName] || '-';
                tr.innerHTML = `
                    <td style="font-weight:700;">${bName}</td>
                    <td><span class="type-branch">فرع</span></td>
                    <td>${country}</td>
                    <td><span class="status-late">لم يرسل</span></td>
                `;
                lateListBody.appendChild(tr);
            }
        });
        
        setTxt('late-count', lateCount);
        if (lateCount === 0) {
            lateListBody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:#10B981; font-weight:700; padding:30px;">🏆 التزام كامل! جميع المشاريع والفروع أرسلت تقاريرها.</td></tr>`;
        }
    }
}

// Tab 2: Elite Indicator & Stock Ticker & Management grid
function updateTab2Management() {
    // Group reports by month to find previous month comparisons
    const reportsByMonth = {};
    reportsData.forEach(r => {
        const d = new Date(r.timestamp);
        if (isNaN(d.getTime())) return;
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (!reportsByMonth[key]) reportsByMonth[key] = [];
        reportsByMonth[key].push(r);
    });
    
    const months = Object.keys(reportsByMonth).sort();
    const currentMonthKey = months[months.length - 1];
    const prevMonthKey = months[months.length - 2];
    
    // Get latest report per project/branch overall to compute health
    const latestOverallReports = {};
    reportsData.forEach(r => {
        const id = r.isProjectReport ? (r.projectId || r.projectName) : (r.branchId || r.branchName);
        const key = `${r.isProjectReport ? 'P' : 'B'}_${id}`;
        const existing = latestOverallReports[key];
        if (!existing || new Date(r.timestamp) > new Date(existing.timestamp)) {
            latestOverallReports[key] = r;
        }
    });
    
    const activePortfolio = Object.values(latestOverallReports);
    
    let totalPnlUSD = 0;
    let lossProjCount = 0;
    let totalProjReports = 0;
    
    activePortfolio.forEach(r => {
        if (r.isProjectReport) {
            totalProjReports++;
            totalPnlUSD += r.pnl;
            if (r.pnl < 0) {
                lossProjCount++;
            }
        }
    });
    
    const lossRatio = totalProjReports > 0 ? (lossProjCount / totalProjReports) : 0;
    const isHealthy = totalPnlUSD >= 0 && lossRatio < 0.15;
    
    const eliteEl = document.getElementById('elite-indicator');
    const eliteIcon = document.getElementById('elite-status-icon');
    const eliteTitle = document.getElementById('elite-status-title');
    const eliteDesc = document.getElementById('elite-status-desc');
    
    if (eliteEl) {
        if (isHealthy) {
            eliteEl.className = 'elite-banner success-mode';
            if (eliteIcon) eliteIcon.innerHTML = '<i class="fa-solid fa-circle-check"></i>';
            if (eliteTitle) eliteTitle.innerText = 'حالة المحفظة: أداء ممتاز ومثالي';
            if (eliteDesc) eliteDesc.innerHTML = `المحفظة الاستثمارية تحقق أرباحاً إجمالية بقيمة <strong>${formatCurrencyUSD(totalPnlUSD)}</strong> ومعدل المشاريع المتعثرة مالياً أقل من 15% (النسبة الحالية: <strong>${Math.round(lossRatio*100)}%</strong>).`;
        } else {
            eliteEl.className = 'elite-banner alert-mode';
            if (eliteIcon) eliteIcon.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i>';
            if (eliteTitle) eliteTitle.innerText = 'تنبيه: مؤشرات تراجع في أداء المحفظة';
            if (eliteDesc) eliteDesc.innerHTML = `يوجد تراجع أداء إما بسبب أرباح سلبية إجمالية (<strong>${formatCurrencyUSD(totalPnlUSD)}</strong>) أو زيادة في المشروعات التي تسجل خسائر مالية (<strong>${Math.round(lossRatio*100)}%</strong>).`;
        }
    }

    // 2. Generate stock ticker comparing current month reports vs previous month reports
    const tickerContent = document.getElementById('ticker-content');
    if (tickerContent) {
        tickerContent.innerHTML = '';
        
        const prevMonthData = {};
        if (prevMonthKey && reportsByMonth[prevMonthKey]) {
            reportsByMonth[prevMonthKey].forEach(r => {
                if (r.isProjectReport) prevMonthData[r.projectName] = r;
            });
        }
        
        const currentMonthReports = reportsByMonth[currentMonthKey] || [];
        let tickerItemsHtml = '';
        
        currentMonthReports.forEach(r => {
            if (!r.isProjectReport) return;
            const prev = prevMonthData[r.projectName];
            
            let pnlTrendSymbol = '';
            let progressTrendSymbol = '';
            
            if (prev) {
                const pnlDiff = r.pnl - prev.pnl;
                const progDiff = r.progress - prev.progress;
                
                pnlTrendSymbol = pnlDiff >= 0 
                    ? `<span class="up">▲ $${(pnlDiff/1e3).toFixed(1)}K</span>` 
                    : `<span class="down">▼ $${(Math.abs(pnlDiff)/1e3).toFixed(1)}K</span>`;
                    
                progressTrendSymbol = progDiff >= 0 
                    ? `<span class="up">▲ ${progDiff.toFixed(1)}%</span>` 
                    : `<span class="down">▼ ${Math.abs(progDiff).toFixed(1)}%</span>`;
            } else {
                pnlTrendSymbol = `<span class="up">جديد</span>`;
                progressTrendSymbol = `<span class="up">جديد</span>`;
            }
            
            tickerItemsHtml += `
                <span class="ticker-item">
                    <strong>${r.projectName}</strong>: 
                    الربح: ${formatCurrencyUSD(r.pnl)} (${pnlTrendSymbol}) | 
                    التقدم: ${r.progress}% (${progressTrendSymbol})
                </span>
            `;
        });
        
        if (!tickerItemsHtml) {
            tickerContent.innerHTML = '<span class="ticker-item">لا توجد مقارنات أداء للشهر الحالي بعد</span>';
        } else {
            tickerContent.innerHTML = tickerItemsHtml + tickerItemsHtml;
        }
    }

    // 3. Populate management table grid
    const managementGridBody = document.getElementById('management-grid-body');
    if (managementGridBody) {
        managementGridBody.innerHTML = '';
        
        activePortfolio.forEach(r => {
            const tr = document.createElement('tr');
            const name = r.isProjectReport ? r.projectName : r.branchName;
            const typeBadge = r.isProjectReport 
                ? '<span class="badge proj">مشروع</span>' 
                : '<span class="badge branch">فرع</span>';
            const country = r.country || (r.isProjectReport ? projectToCountryMap[name] : branchToCountryMap[name]) || '-';
            
            const progressVal = r.isProjectReport ? `${r.progress}%` : '-';
            const pnlStr = r.pnl >= 0 
                ? `<span class="pnl-pos">${formatCurrencyUSD(r.pnl)}</span>` 
                : `<span class="pnl-neg">${formatCurrencyUSD(r.pnl)}</span>`;
                
            const isLoss = r.pnl < 0;
            const quickIndicator = isLoss
                ? '<span class="status-indicator-pill danger"><i class="fa-solid fa-circle-exclamation"></i> تراجع مالي</span>'
                : '<span class="status-indicator-pill success"><i class="fa-solid fa-circle-check"></i> منتظم</span>';
                
            tr.innerHTML = `
                <td style="font-weight: 700; max-width: 350px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${name}</td>
                <td>${typeBadge}</td>
                <td>${country}</td>
                <td style="font-family: 'Outfit'; font-weight:700;">${progressVal}</td>
                <td>${pnlStr}</td>
                <td>${quickIndicator}</td>
            `;
            managementGridBody.appendChild(tr);
        });
        
        // Add grid filter listener (safe setup)
        const searchInput = document.getElementById('management-search');
        if (searchInput && !searchInput.dataset.hasListener) {
            searchInput.dataset.hasListener = "true";
            searchInput.addEventListener('input', () => {
                const q = searchInput.value.toLowerCase().trim();
                const rows = managementGridBody.querySelectorAll('tr');
                rows.forEach(row => {
                    row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
                });
            });
        }
    }
}

// Tab 3: Dynamic Dropdown selector and Profile cards
function updateTab3Dropdowns() {
    const selectCountry = document.getElementById('select-country');
    const selectBranch = document.getElementById('select-branch');
    const selectProject = document.getElementById('select-project');
    
    if (!selectCountry || !selectBranch || !selectProject) return;
    
    // 1. Populate Country List
    const countriesSet = new Set();
    expectedBranches.forEach(b => {
        const c = branchToCountryMap[b];
        if (c) countriesSet.add(c);
    });
    
    selectCountry.innerHTML = '<option value="">-- اختر دولة --</option>';
    Array.from(countriesSet).sort().forEach(c => {
        const opt = document.createElement('option');
        opt.value = c;
        opt.innerText = c;
        selectCountry.appendChild(opt);
    });
    
    // 2. Change Country Listener
    selectCountry.onchange = () => {
        const country = selectCountry.value;
        selectBranch.innerHTML = '<option value="">-- اختر فرع --</option>';
        selectProject.innerHTML = '<option value="">-- اختر مشروع --</option>';
        selectProject.disabled = true;
        
        if (!country) {
            selectBranch.disabled = true;
            hideProfile();
            return;
        }
        
        selectBranch.disabled = false;
        
        // Find branches in this country
        const branchesInCountry = [];
        expectedBranches.forEach(b => {
            if (branchToCountryMap[b] === country) {
                branchesInCountry.push(b);
            }
        });
        
        branchesInCountry.sort().forEach(b => {
            const opt = document.createElement('option');
            opt.value = b;
            opt.innerText = b;
            selectBranch.appendChild(opt);
        });
        
        hideProfile();
    };
    
    // 3. Change Branch Listener
    selectBranch.onchange = () => {
        const branchName = selectBranch.value;
        selectProject.innerHTML = '<option value="">-- اختر مشروع --</option>';
        
        if (!branchName) {
            selectProject.disabled = true;
            hideProfile();
            return;
        }
        
        selectProject.disabled = false;
        
        // Find projects under this branch
        const projectsInBranch = [];
        expectedProjects.forEach(p => {
            if (projectToBranchMap[p] === branchName) {
                projectsInBranch.push(p);
            }
        });
        
        // Add a placeholder project report selection for the branch itself
        const branchOpt = document.createElement('option');
        branchOpt.value = `BRANCH_${branchName}`;
        branchOpt.innerText = `[تقرير الفرع] - ${branchName}`;
        selectProject.appendChild(branchOpt);
        
        projectsInBranch.sort().forEach(p => {
            const opt = document.createElement('option');
            opt.value = p;
            opt.innerText = p;
            selectProject.appendChild(opt);
        });
        
        hideProfile();
    };
    
    // 4. Change Project Listener
    selectProject.onchange = () => {
        const val = selectProject.value;
        if (!val) {
            hideProfile();
            return;
        }
        
        showProfile(val);
    };
}

function hideProfile() {
    const emptyPrompt = document.getElementById('browser-empty-prompt');
    const profileContainer = document.getElementById('browser-profile-container');
    if (emptyPrompt) emptyPrompt.classList.remove('hidden');
    if (profileContainer) profileContainer.classList.add('hidden');
}

// Render dynamic project/branch details profile card
function showProfile(identifier) {
    const emptyPrompt = document.getElementById('browser-empty-prompt');
    const profileContainer = document.getElementById('browser-profile-container');
    if (emptyPrompt) emptyPrompt.classList.add('hidden');
    if (profileContainer) profileContainer.classList.remove('hidden');
    
    const isBranchReport = identifier.startsWith('BRANCH_');
    const name = isBranchReport ? identifier.replace('BRANCH_', '') : identifier;
    
    // Find all historical reports for this item
    const history = reportsData.filter(r => {
        return r.isProjectReport === !isBranchReport && (r.isProjectReport ? r.projectName === name : r.branchName === name);
    }).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    
    // Latest report
    const latest = history[history.length - 1] || null;
    
    // Update elements
    const badgeType = document.getElementById('profile-badge-type');
    if (badgeType) {
        badgeType.innerText = isBranchReport ? 'تقرير مالي للفرع' : 'تقرير أداء للمشروع';
        badgeType.className = isBranchReport ? 'profile-badge type-branch' : 'profile-badge type-proj';
    }
    
    setTxt('profile-title-name', name);
    
    const subtitle = document.getElementById('profile-subtitle-client');
    if (subtitle) {
        subtitle.innerText = latest 
            ? `العميل: ${latest.clientName || '-'}` 
            : `الجهة: ${isBranchReport ? 'الفرع الإقليمي' : 'المشروع الخارجي'}`;
    }
        
    const country = isBranchReport ? branchToCountryMap[name] : projectToCountryMap[name];
    setTxt('profile-country', country || '-');
    
    const branch = isBranchReport ? name : (projectToBranchMap[name] || '-');
    setTxt('profile-branch', branch);
    
    const pnlVal = latest ? latest.pnl : 0;
    const progressVal = latest ? latest.progress : 0;
    
    setTxt('profile-progress', isBranchReport ? '-' : `${progressVal}%`);
    setTxt('profile-pnl', latest ? formatCurrencyUSD(pnlVal) : '-');
    
    // Dynamic Risk Index Badge Calculation (0-100)
    let riskScore = 10;
    
    if (latest) {
        if (latest.pnl < 0) riskScore += 35;
        if (!isBranchReport) {
            if (latest.progress < 30) riskScore += 20;
            else if (latest.progress < 60) riskScore += 10;
        }
    } else {
        riskScore += 40;
    }
    
    const riskBadge = document.getElementById('risk-badge-val');
    if (riskBadge) {
        riskBadge.innerText = riskScore >= 50 
            ? `مخاطر مرتفعة (${riskScore}%)` 
            : `مخاطر منخفضة (${riskScore}%)`;
        riskBadge.className = riskScore >= 50 ? 'risk-badge high' : 'risk-badge low';
    }

    // RENDER CHARTS
    renderProfileCharts(isBranchReport, name, latest, history);
}

// Generate Pie Chart and progress timeline histogram
function renderProfileCharts(isBranch, name, latest, history) {
    const cssStyle = getComputedStyle(document.documentElement);
    const accentColor = cssStyle.getPropertyValue('--theme-accent').trim() || '#FCA311';
    
    const pieCanvas = document.getElementById('profilePieChart');
    if (pieCanvas) {
        const pieCtx = pieCanvas.getContext('2d');
        if (profilePieChart) profilePieChart.destroy();
        
        let pieLabels = [];
        let pieData = [];
        let pieColors = [];
        
        if (latest) {
            if (isBranch) {
                pieLabels = ['إجمالي المصروفات', 'صافي الأرباح/الخسائر'];
                const absPnl = Math.abs(latest.pnl);
                pieData = [latest.contractValue || 100, absPnl];
                pieColors = ['#EF4444', latest.pnl >= 0 ? '#10B981' : '#F59E0B'];
            } else {
                const executed = latest.executedValue || 0;
                const contractVal = latest.valueUsd || 100;
                const remaining = Math.max(0, contractVal - executed);
                
                pieLabels = ['الأعمال المنفذة المعتمدة', 'الأعمال المتبقية بالدولار'];
                pieData = [executed, remaining];
                pieColors = [accentColor, '#3B82F6'];
            }
        } else {
            pieLabels = ['لا توجد بيانات مالية'];
            pieData = [1];
            pieColors = ['rgba(255,255,255,0.05)'];
        }
        
        profilePieChart = new Chart(pieCtx, {
            type: 'pie',
            data: {
                labels: pieLabels,
                datasets: [{
                    data: pieData,
                    backgroundColor: pieColors,
                    borderColor: '#162444',
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { color: '#FFFFFF', font: { family: 'Tajawal', size: 10 } }
                    }
                }
            }
        });
    }
    
    const histoCanvas = document.getElementById('profileHistoChart');
    if (histoCanvas) {
        const histoCtx = histoCanvas.getContext('2d');
        if (profileHistoChart) profileHistoChart.destroy();
        
        let histoLabels = [];
        let histoData = [];
        let labelText = '';
        
        if (history.length > 0) {
            history.slice(-10).forEach(r => {
                histoLabels.push(r.measurementDate || 'بدون تاريخ');
                histoData.push(isBranch ? r.pnl : r.progress);
            });
            labelText = isBranch ? 'صافي الربح / الخسارة بالعملة المحلية' : 'نسبة الإنجاز المخططة (%)';
        } else {
            histoLabels = ['لا توجد تقارير'];
            histoData = [0];
            labelText = 'لا توجد بيانات';
        }
        
        profileHistoChart = new Chart(histoCtx, {
            type: 'bar',
            data: {
                labels: histoLabels,
                datasets: [{
                    label: labelText,
                    data: histoData,
                    backgroundColor: isBranch ? 'rgba(59, 130, 246, 0.4)' : 'rgba(252, 163, 17, 0.4)',
                    borderColor: isBranch ? '#3B82F6' : accentColor,
                    borderWidth: 2,
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: {
                        ticks: { color: '#A0AEC0', font: { family: 'Outfit', size: 9 } },
                        grid: { color: 'rgba(255, 255, 255, 0.05)' }
                    },
                    y: {
                        ticks: { color: '#A0AEC0', font: { family: 'Outfit', size: 9 } },
                        grid: { color: 'rgba(255, 255, 255, 0.05)' }
                    }
                },
                plugins: {
                    legend: {
                        labels: { color: '#FFFFFF', font: { family: 'Tajawal', size: 10 } }
                    }
                }
            }
        });
    }
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
    setTxt('countdown-seconds', secondsRemaining);
}

// Tab Switching
function switchMainTab(tabId, btn) {
    document.querySelectorAll('.nav-tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.main-tab-content').forEach(c => c.classList.remove('active'));
    
    btn.classList.add('active');
    
    const target = document.getElementById(tabId);
    if (target) target.classList.add('active');
}

// Initialize on page load
window.addEventListener('DOMContentLoaded', () => {
    // Lock appTheme to corporate in localStorage
    localStorage.setItem('appTheme', 'corporate');
    
    // Load initial data
    loadData();
    
    // Refresh Button Click
    const refreshBtn = document.getElementById('refresh-btn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            loadData();
        });
    }
});
