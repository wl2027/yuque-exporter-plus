import fs from 'fs';
import path from 'path';
import { type } from './const.js';

export async function exportMarkDownFiles(page, books) {
    const folderPath = process.env.EXPORT_PATH;
    console.log("download folderPath: " + folderPath)
    if (!fs.existsSync(folderPath)) {
        console.error(`export path:${folderPath} is not exist`)
        process.exit(1)
    }

    // console.log(books)
    for ( let i = 0; i < books.length; i++ ) {
        await exportMarkDownFileTree(page, folderPath, books[i], books[i].root)
        console.log();
    }

    console.log(`=====> Export successfully! Have a good day!`);
    console.log();
}


async function exportMarkDownFileTree(page, folderPath, book, node) {
    switch (node.type) {
        case type.Book: 
            folderPath = path.join(folderPath, book.name);
            if (!fs.existsSync(folderPath)) {
                fs.mkdirSync(folderPath)
            }
            break;
        case type.Title: 
            folderPath = path.join(folderPath, node.name);
            if (!fs.existsSync(folderPath)) {
                fs.mkdirSync(folderPath)
            }
            break;
        case type.TitleDoc: 
            folderPath = path.join(folderPath, node.name);
            if (!fs.existsSync(folderPath)) {
                fs.mkdirSync(folderPath)
            }
        case type.Document: 
            const client = await page.target().createCDPSession()
            await client.send('Page.setDownloadBehavior', {
                behavior: 'allow',
                downloadPath: folderPath,
            })
            await downloadMardown(page, folderPath, book.name, node.name.replace(/\//g, '_'),
                book.user_url + "/" + book.slug + "/" + node.object.url)
            break;
    }

    if (node.children) {
        for (const childNode of node.children) {
            await exportMarkDownFileTree(page, folderPath, book, childNode);
        }
    }
}


// browserpage, bookName, url
async function downloadMardown(page, rootPath, book, mdname, docUrl) {
    const url = buildMarkdownExportUrl(docUrl);
    // console.log(book + "/" + mdname + "'s download URL is: " + url)
    // console.log(rootPath)

    await downloadFile(page, rootPath, book, sanitizeFileName(mdname), url)
    // await page.waitForTimeout(1000);
}

async function downloadFile(page, rootPath, book, mdname, url, maxRetries = 3) {
    var retries = 0;

    removeZeroByteMarkdownFiles(rootPath);
    const existingFile = findExistingDownloadedFile(rootPath, mdname);
    if (existingFile) {
        console.log(`Skip existing document ${book}/${path.basename(existingFile, path.extname(existingFile))}`);
        console.log();
        return;
    }

    async function downloadWithRetries() {
        try {
            removeZeroByteMarkdownFiles(rootPath);
            const beforeFiles = new Set(fs.readdirSync(rootPath));
            await goto(page, url);
            console.log(`Waiting download document to ${rootPath}\\${mdname}`);
            const fileNameWithExt = await waitForDownload(rootPath, beforeFiles, book, mdname);
            const fileName = path.basename(fileNameWithExt, path.extname(fileNameWithExt));
            console.log("Download document " + book + "/" + fileName + " finished");
            console.log();
        } catch (error) {
            console.log(error);
            if (retries < maxRetries) {
                console.log(`Retrying download... (attempt ${retries + 1})`);
                retries++;
                await downloadWithRetries();
            } else {
                console.log(`Download error after ${maxRetries} retries: ${error}`);
            }
        }
    }

    await downloadWithRetries();
}

async function goto(page, link) {
    page.evaluate((link) => {
        location.href = link;
    }, link);
}
  
async function waitForDownload(rootPath, beforeFiles, book, mdname) {
    const timeout = 30000;
    const interval = 500;
    let started = false;

    for (let elapsed = 0; elapsed < timeout; elapsed += interval) {
        const existingFile = findExistingDownloadedFile(rootPath, mdname);
        if (existingFile) {
            return existingFile;
        }

        const files = fs.readdirSync(rootPath);
        for (const fileName of files) {
            if (!beforeFiles.has(fileName) && fileName.endsWith('.md.crdownload') && !started) {
                console.log("Downloading document " + book + "/" + mdname);
                started = true;
            }

            if (!beforeFiles.has(fileName) && fileName.endsWith('.md')) {
                return fileName;
            }
        }

        await sleep(interval);
    }

    throw new Error('Download timed out');
}

function findExistingDownloadedFile(rootPath, mdname) {
    const expectedName = normalizeCompareName(mdname);
    const files = fs.readdirSync(rootPath);
    return files.find((fileName) => {
        if (!fileName.endsWith('.md')) {
            return false;
        }

        const filePath = path.join(rootPath, fileName);
        if (fs.statSync(filePath).size === 0) {
            return false;
        }

        return normalizeCompareName(fileName) === expectedName;
    });
}

export function sanitizeFileName(fileName) {
    return fileName
        .replace(/[\\/]/g, '_')
        .replace(/[\r\n]+/g, '_')
        .trim();
}

function normalizeCompareName(fileName) {
    return sanitizeFileName(path.basename(fileName, path.extname(fileName)));
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function removeZeroByteMarkdownFiles(rootPath) {
    const files = fs.readdirSync(rootPath);
    for (const fileName of files) {
        if (!fileName.endsWith('.md')) {
            continue;
        }

        const filePath = path.join(rootPath, fileName);
        if (fs.statSync(filePath).size === 0) {
            fs.rmSync(filePath, { force: true });
        }
    }
}

export function buildMarkdownExportUrl(docUrl) {
    return 'https://www.yuque.com/' + docUrl + '/markdown?attachment=true&latexcode=false&anchor=false&linebreak=false';
}

export function collectExpectedMarkdownDocs(exportPath, books) {
    const expectedDocs = [];
    for (const book of books) {
        collectExpectedMarkdownDocsByNode(exportPath, book, book.root, expectedDocs);
    }
    return expectedDocs;
}

function collectExpectedMarkdownDocsByNode(folderPath, book, node, expectedDocs) {
    let currentFolderPath = folderPath;

    switch (node.type) {
        case type.Book:
            currentFolderPath = path.join(folderPath, book.name);
            break;
        case type.Title:
            currentFolderPath = path.join(folderPath, node.name);
            break;
        case type.TitleDoc:
            currentFolderPath = path.join(folderPath, node.name);
            expectedDocs.push(buildExpectedMarkdownDoc(currentFolderPath, book, node));
            break;
        case type.Document:
            expectedDocs.push(buildExpectedMarkdownDoc(currentFolderPath, book, node));
            break;
        default:
            break;
    }

    if (node.children) {
        for (const childNode of node.children) {
            collectExpectedMarkdownDocsByNode(currentFolderPath, book, childNode, expectedDocs);
        }
    }
}

function buildExpectedMarkdownDoc(rootPath, book, node) {
    const fileBaseName = sanitizeFileName(node.name.replace(/\//g, '_'));
    const filePath = path.join(rootPath, `${fileBaseName}.md`);

    return {
        bookName: book.name,
        nodeName: node.name,
        fileBaseName,
        filePath,
        exportUrl: buildMarkdownExportUrl(`${book.user_url}/${book.slug}/${node.object.url}`),
    };
}
