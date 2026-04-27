import fs from 'fs';
import path from 'path';
import axios from 'axios';

const IMAGE_LINK_PATTERN = /!\[.*?\]\((.*?)\)/g;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp']);
const IMAGE_IGNORED_MARKDOWN_FILES = new Set(['_export_verification.md']);
const CONTENT_TYPE_EXTENSION_MAP = new Map([
    ['image/png', '.png'],
    ['image/jpeg', '.jpeg'],
    ['image/jpg', '.jpg'],
    ['image/gif', '.gif'],
    ['image/svg+xml', '.svg'],
    ['image/webp', '.webp'],
    ['image/bmp', '.bmp'],
]);

export async function processExportedImages(page, markdownFolder) {
    const imageFolder = path.join(markdownFolder, 'images');
    const downloadImage = getBooleanEnv('DOWNLOAD_IMAGE', true);
    const updateImageUrl = getBooleanEnv('UPDATE_MDIMG_URL', true);
    const replaceImageHost = (process.env.REPLACE_IMAGE_HOST || '').trim();
    const markdownFiles = listMarkdownFiles(markdownFolder);
    const urlCache = new Map();
    const pathOwnerMap = new Map();
    const cookieHeaderCache = new Map();
    const summary = {
        markdownFiles: markdownFiles.length,
        processedFiles: 0,
        filesUpdated: 0,
        linksFound: 0,
        linksRewritten: 0,
        imagesDownloaded: 0,
        imagesReused: 0,
        failedImages: [],
    };

    if ((downloadImage || updateImageUrl) && !fs.existsSync(imageFolder)) {
        fs.mkdirSync(imageFolder, { recursive: true });
    }

    for (const markdownFile of markdownFiles) {
        let markdownContent = fs.readFileSync(markdownFile, 'utf8');
        const matches = Array.from(markdownContent.matchAll(IMAGE_LINK_PATTERN));
        if (matches.length === 0) {
            summary.processedFiles++;
            maybeLogImageProgress(summary);
            continue;
        }

        let fileUpdated = false;

        for (const match of matches) {
            const originalLink = match[1];
            summary.linksFound++;

            const imageAsset = await ensureImageAsset({
                page,
                imageFolder,
                originalLink,
                downloadImage,
                pathOwnerMap,
                urlCache,
                cookieHeaderCache,
                failedImages: summary.failedImages,
            });

            if (!imageAsset) {
                continue;
            }

            if (imageAsset.downloaded) {
                summary.imagesDownloaded++;
            } else {
                summary.imagesReused++;
            }

            if (!updateImageUrl) {
                continue;
            }

            const newLink = replaceImageHost
                ? `${replaceImageHost.replace(/\/+$/, '')}/${imageAsset.year}/${imageAsset.fileName}`
                : toPosixPath(path.relative(path.dirname(markdownFile), imageAsset.filePath));

            if (newLink !== originalLink) {
                markdownContent = markdownContent.split(originalLink).join(newLink);
                summary.linksRewritten++;
                fileUpdated = true;
            }
        }

        if (fileUpdated) {
            fs.writeFileSync(markdownFile, markdownContent);
            summary.filesUpdated++;
        }

        summary.processedFiles++;
        maybeLogImageProgress(summary);
    }

    return summary;
}

async function ensureImageAsset({
    page,
    imageFolder,
    originalLink,
    downloadImage,
    pathOwnerMap,
    urlCache,
    cookieHeaderCache,
    failedImages,
}) {
    if (urlCache.has(originalLink)) {
        return urlCache.get(originalLink);
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(originalLink);
    } catch (error) {
        urlCache.set(originalLink, null);
        return null;
    }

    if (!parsedUrl.protocol.startsWith('http')) {
        urlCache.set(originalLink, null);
        return null;
    }

    const normalizedUrl = new URL(parsedUrl.toString());
    normalizedUrl.hash = '';
    const year = inferImageYear(normalizedUrl);
    const yearFolder = path.join(imageFolder, year);
    fs.mkdirSync(yearFolder, { recursive: true });
    const declaredExtension = normalizeImageExtension(path.extname(normalizedUrl.pathname).toLowerCase());
    let asset = declaredExtension
        ? buildImageAsset(normalizedUrl, yearFolder, year, declaredExtension, pathOwnerMap)
        : null;

    if (asset && fs.existsSync(asset.filePath) && fs.statSync(asset.filePath).size > 0) {
        urlCache.set(originalLink, asset);
        return asset;
    }

    if (!downloadImage) {
        urlCache.set(originalLink, null);
        return null;
    }

    try {
        const response = await axios.get(normalizedUrl.toString(), {
            responseType: 'arraybuffer',
            timeout: 30000,
            headers: await buildImageRequestHeaders(page, normalizedUrl, cookieHeaderCache),
            validateStatus: (status) => status >= 200 && status < 300,
        });

        const resolvedExtension = declaredExtension || inferExtensionFromContentType(response.headers['content-type']);
        if (!resolvedExtension) {
            failedImages.push({
                source: originalLink,
                message: `Unsupported image content-type: ${response.headers['content-type'] || 'UNKNOWN'}`,
            });
            urlCache.set(originalLink, null);
            return null;
        }

        asset = buildImageAsset(normalizedUrl, yearFolder, year, resolvedExtension, pathOwnerMap);
        if (fs.existsSync(asset.filePath) && fs.statSync(asset.filePath).size > 0) {
            urlCache.set(originalLink, asset);
            return asset;
        }

        fs.writeFileSync(asset.filePath, response.data);
        asset.downloaded = true;
        urlCache.set(originalLink, asset);
        return asset;
    } catch (error) {
        failedImages.push({
            source: originalLink,
            message: error.message,
        });
        urlCache.set(originalLink, null);
        return null;
    }
}

async function buildImageRequestHeaders(page, imageUrl, cookieHeaderCache) {
    if (!page || !/yuque\.com$/i.test(imageUrl.hostname)) {
        return {};
    }

    if (!cookieHeaderCache.has(imageUrl.origin)) {
        const cookies = await page.cookies(imageUrl.origin);
        const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
        cookieHeaderCache.set(imageUrl.origin, cookieHeader);
    }

    const cookieHeader = cookieHeaderCache.get(imageUrl.origin);
    return cookieHeader
        ? {
            Cookie: cookieHeader,
            Referer: 'https://www.yuque.com/',
        }
        : {};
}

function buildImageAsset(imageUrl, yearFolder, year, extension, pathOwnerMap) {
    const fileName = buildImageFileName(imageUrl, extension, pathOwnerMap);
    return {
        year,
        fileName,
        filePath: path.join(yearFolder, fileName),
        downloaded: false,
    };
}

function buildImageFileName(imageUrl, extension, pathOwnerMap) {
    const rawBaseName = decodeURIComponent(path.basename(imageUrl.pathname, path.extname(imageUrl.pathname))) || 'image';
    const safeBaseName = sanitizeImageFileName(rawBaseName) || 'image';
    const safeFileName = `${safeBaseName}${extension}`;
    const year = inferImageYear(imageUrl);
    const targetKey = `${year}/${safeFileName}`;
    const existingOwner = pathOwnerMap.get(targetKey);
    if (!existingOwner || existingOwner === imageUrl.toString()) {
        pathOwnerMap.set(targetKey, imageUrl.toString());
        return safeFileName;
    }

    const resolvedExtension = path.extname(safeFileName);
    const baseName = path.basename(safeFileName, resolvedExtension);
    const hashSuffix = Buffer.from(imageUrl.toString()).toString('base64url').slice(0, 8);
    const dedupedName = `${baseName}-${hashSuffix}${resolvedExtension}`;
    pathOwnerMap.set(`${year}/${dedupedName}`, imageUrl.toString());
    return dedupedName;
}

function sanitizeImageFileName(fileName) {
    return fileName
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
        .replace(/\s+/g, ' ')
        .trim();
}

function inferImageYear(imageUrl) {
    if (/\/yuque\/__latex\//.test(imageUrl.pathname)) {
        return String(new Date().getFullYear());
    }

    const pathParts = imageUrl.pathname.split('/');
    const year = pathParts.find((part) => /^2\d{3}$/.test(part));
    return year || String(new Date().getFullYear());
}

function normalizeImageExtension(extension) {
    if (!extension) {
        return null;
    }

    return IMAGE_EXTENSIONS.has(extension) ? extension : null;
}

function inferExtensionFromContentType(contentTypeHeader) {
    const contentType = String(contentTypeHeader || '').split(';')[0].trim().toLowerCase();
    return CONTENT_TYPE_EXTENSION_MAP.get(contentType) || null;
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

            if (entry.isFile() && entry.name.endsWith('.md')) {
                if (IMAGE_IGNORED_MARKDOWN_FILES.has(entry.name)) {
                    continue;
                }
                markdownFiles.push(fullPath);
            }
        }
    }

    return markdownFiles;
}

function getBooleanEnv(name, defaultValue) {
    const value = process.env[name];
    if (value === undefined) {
        return defaultValue;
    }

    return value.toLowerCase() === 'true' || value === '1';
}

function toPosixPath(filePath) {
    return filePath.split(path.sep).join('/');
}

function maybeLogImageProgress(summary) {
    if (summary.processedFiles === 0) {
        return;
    }

    if (summary.processedFiles % 100 !== 0 && summary.processedFiles !== summary.markdownFiles) {
        return;
    }

    console.log(`Image process progress: ${summary.processedFiles}/${summary.markdownFiles}, downloaded=${summary.imagesDownloaded}, rewritten=${summary.linksRewritten}, failed=${summary.failedImages.length}`);
}
