import fs from 'fs';
import path from 'path';
import { collectExpectedMarkdownDocs } from './export.js';

const REPORT_JSON_NAME = '_export_verification.json';
const REPORT_MD_NAME = '_export_verification.md';
const REMOTE_IMAGE_LINK_PATTERN = /!\[[^\]]*\]\((https?:\/\/[^)]+)\)/g;

export async function verifyExportArtifacts(page, exportPath, books) {
    const expectedDocs = collectExpectedMarkdownDocs(exportPath, books);
    const actualMarkdownFiles = listMarkdownFiles(exportPath);
    const expectedByPath = new Map(expectedDocs.map((doc) => [path.resolve(doc.filePath), doc]));
    const report = {
        generatedAt: new Date().toISOString(),
        exportPath,
        expectedDocuments: expectedDocs.length,
        actualMarkdownFiles: actualMarkdownFiles.length,
        missingFiles: [],
        emptyFiles: [],
        remoteEmptyDocuments: [],
        hardFailures: [],
        remainingRemoteImageLinks: 0,
        filesWithRemainingRemoteImages: 0,
        remainingRemoteImageFiles: [],
        unexpectedFiles: actualMarkdownFiles
            .filter((filePath) => !expectedByPath.has(path.resolve(filePath)))
            .map((filePath) => path.relative(exportPath, filePath)),
    };

    const pendingRemoteChecks = [];

    for (const doc of expectedDocs) {
        if (!fs.existsSync(doc.filePath)) {
            const item = buildDocIssue(doc, exportPath);
            report.missingFiles.push(item);
            pendingRemoteChecks.push({ doc, issue: item, category: 'missing' });
            continue;
        }

        const stat = fs.statSync(doc.filePath);
        if (stat.size === 0) {
            const item = buildDocIssue(doc, exportPath);
            report.emptyFiles.push(item);
            pendingRemoteChecks.push({ doc, issue: item, category: 'empty' });
        }
    }

    for (const check of pendingRemoteChecks) {
        const remoteStatus = await inspectRemoteDocument(page, check.doc.exportUrl);
        check.issue.remoteStatus = remoteStatus;

        if (remoteStatus.ok && remoteStatus.contentLength === 0) {
            report.remoteEmptyDocuments.push(check.issue);
            continue;
        }

        report.hardFailures.push(check.issue);
    }

    report.isComplete = report.hardFailures.length === 0;
    collectRemoteImageIssues(report, actualMarkdownFiles, exportPath);
    report.imagesLocalized = report.remainingRemoteImageLinks === 0;
    report.reportJsonPath = path.join(exportPath, REPORT_JSON_NAME);
    report.reportMarkdownPath = path.join(exportPath, REPORT_MD_NAME);

    fs.writeFileSync(report.reportJsonPath, JSON.stringify(report, null, 2));
    fs.writeFileSync(report.reportMarkdownPath, renderMarkdownReport(report));

    return report;
}

function buildDocIssue(doc, exportPath) {
    return {
        bookName: doc.bookName,
        nodeName: doc.nodeName,
        filePath: path.relative(exportPath, doc.filePath),
    };
}

async function inspectRemoteDocument(page, exportUrl) {
    return page.evaluate(async (targetUrl) => {
        try {
            const response = await fetch(targetUrl, { credentials: 'include' });
            const text = await response.text();
            return {
                ok: response.ok,
                status: response.status,
                contentLength: text.length,
            };
        } catch (error) {
            return {
                ok: false,
                status: 0,
                contentLength: 0,
                error: error.message,
            };
        }
    }, exportUrl);
}

function listMarkdownFiles(rootFolder) {
    const markdownFiles = [];
    const queue = [rootFolder];

    while (queue.length > 0) {
        const currentFolder = queue.pop();
        const entries = fs.readdirSync(currentFolder, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(currentFolder, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'images') {
                    continue;
                }
                queue.push(fullPath);
                continue;
            }

            if (!entry.isFile() || !entry.name.endsWith('.md')) {
                continue;
            }

            if (entry.name === REPORT_MD_NAME || entry.name === REPORT_JSON_NAME) {
                continue;
            }

            markdownFiles.push(fullPath);
        }
    }

    return markdownFiles;
}

function renderMarkdownReport(report) {
    const lines = [
        '# Export Verification Report',
        '',
        `- Generated At: ${report.generatedAt}`,
        `- Export Path: ${report.exportPath}`,
        `- Expected Documents: ${report.expectedDocuments}`,
        `- Actual Markdown Files: ${report.actualMarkdownFiles}`,
        `- Hard Failures: ${report.hardFailures.length}`,
        `- Remote Empty Documents: ${report.remoteEmptyDocuments.length}`,
        `- Remaining Remote Image Links: ${report.remainingRemoteImageLinks}`,
        `- Files With Remaining Remote Images: ${report.filesWithRemainingRemoteImages}`,
        `- Unexpected Files: ${report.unexpectedFiles.length}`,
        `- Complete: ${report.isComplete ? 'YES' : 'NO'}`,
        `- Images Localized: ${report.imagesLocalized ? 'YES' : 'NO'}`,
        '',
    ];

    appendSection(lines, 'Hard Failures', report.hardFailures);
    appendSection(lines, 'Missing Files', report.missingFiles);
    appendSection(lines, 'Empty Files', report.emptyFiles);
    appendSection(lines, 'Remote Empty Documents', report.remoteEmptyDocuments);
    appendSection(lines, 'Remaining Remote Images', report.remainingRemoteImageFiles);
    appendSection(lines, 'Unexpected Files', report.unexpectedFiles.map((filePath) => ({ filePath })));

    return lines.join('\n');
}

function appendSection(lines, title, items) {
    lines.push(`## ${title}`);
    if (items.length === 0) {
        lines.push('');
        lines.push('- None');
        lines.push('');
        return;
    }

    lines.push('');
    for (const item of items) {
        if (typeof item === 'string') {
            lines.push(`- ${item}`);
            continue;
        }

        const detail = item.remoteStatus
            ? ` (remote status: ${item.remoteStatus.status}, remote length: ${item.remoteStatus.contentLength})`
            : '';
        const countDetail = item.count ? ` | remaining remote images: ${item.count}` : '';
        const sampleDetail = item.samples?.length ? ` | sample: ${item.samples[0]}` : '';
        lines.push(`- ${item.filePath} | ${item.bookName || 'UNKNOWN'} | ${item.nodeName || item.filePath}${detail}${countDetail}${sampleDetail}`);
    }
    lines.push('');
}

function collectRemoteImageIssues(report, actualMarkdownFiles, exportPath) {
    for (const markdownFile of actualMarkdownFiles) {
        const markdownContent = fs.readFileSync(markdownFile, 'utf8');
        const remoteImages = Array.from(markdownContent.matchAll(REMOTE_IMAGE_LINK_PATTERN), (match) => match[1]);
        if (remoteImages.length === 0) {
            continue;
        }

        report.remainingRemoteImageLinks += remoteImages.length;
        report.remainingRemoteImageFiles.push({
            filePath: path.relative(exportPath, markdownFile),
            count: remoteImages.length,
            samples: Array.from(new Set(remoteImages)).slice(0, 3),
        });
    }

    report.filesWithRemainingRemoteImages = report.remainingRemoteImageFiles.length;
}
