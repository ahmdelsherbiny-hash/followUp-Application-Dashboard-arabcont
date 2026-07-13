const fs = require('fs');
const path = require('path');

function extractJSONFromMd(filePath) {
    const md = fs.readFileSync(filePath, 'utf-8');
    const marker = 'myCallback(';
    const startIndex = md.indexOf(marker);
    if (startIndex === -1) return null;
    const jsonStr = md.slice(startIndex + marker.length, md.lastIndexOf(')'));
    return JSON.parse(jsonStr);
}

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

function parseChangeRequestsGviz(table) {
    if (!table || !table.cols || !table.rows || table.rows.length === 0) return [];
    
    let headers = table.cols.map(col => col.label ? col.label.toLowerCase().trim() : '');
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

try {
    const basePath = 'C:\\Users\\ahmed\\.gemini\\antigravity\\brain\\cc786473-65ca-402f-a676-571172bfa00f\\.system_generated\\steps';
    const reportsRes = extractJSONFromMd(path.join(basePath, '78', 'content.md'));
    const requestsRes = extractJSONFromMd(path.join(basePath, '94', 'content.md'));
    
    const reports = parseGvizReports(reportsRes.table);
    const requests = parseChangeRequestsGviz(requestsRes.table);
    
    console.log("=== JSONP PARSING VERIFICATION ===");
    console.log(`Total reports: ${reports.length}`);
    console.log(`Total change requests parsed: ${requests.length}`);
    
    if (requests.length > 0) {
        const req = requests[0];
        console.log(`Change Request details:`);
        console.log(`- Project: ${req.project}`);
        console.log(`- Country: ${req.country}`);
        console.log(`- Branch: ${req.branch}`);
        console.log(`- Customer: ${req.client}`);
        console.log(`- Status: ${req.status || 'Pending'}`);
    }
    console.log("==================================");
    
} catch (e) {
    console.error("Test failed:", e);
}
