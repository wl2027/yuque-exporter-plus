import puppeteer from 'puppeteer';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { autoLogin } from './src/login.js';
import { getAllBooks } from './src/toc.js';
import { exportMarkDownFiles } from './src/export.js';
import { processExportedImages } from './src/image.js';
import { verifyExportArtifacts } from './src/verify.js';

const DEFAULT_MAC_CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEFAULT_MAC_CHROME_USER_DATA_DIR = path.join(
    os.homedir(),
    'Library/Application Support/Google/Chrome'
);
const ROOT_FILES_TO_COPY = ['Local State', 'First Run'];
const PROFILE_CACHE_SEGMENTS = new Set([
    'Cache',
    'Code Cache',
    'GPUCache',
    'DawnCache',
    'DawnGraphiteCache',
    'GrShaderCache',
    'GraphiteDawnCache',
    'ShaderCache',
]);
const PROFILE_EXCLUDED_BASENAMES = new Set([
    'SingletonCookie',
    'SingletonLock',
    'SingletonSocket',
    'LOCK',
    '.org.chromium.Chromium.*',
]);

let color = {
    byNum: (mess, fgNum) => {
        mess = mess || '';
        fgNum = fgNum === undefined ? 31 : fgNum;
        return '\u001b[' + fgNum + 'm' + mess + '\u001b[39m';
    },
    black: (mess) => color.byNum(mess, 30),
    red: (mess) => color.byNum(mess, 31),
    green: (mess) => color.byNum(mess, 32),
    yellow: (mess) => color.byNum(mess, 33),
    blue: (mess) => color.byNum(mess, 34),
    magenta: (mess) => color.byNum(mess, 35),
    cyan: (mess) => color.byNum(mess, 36),
    white: (mess) => color.byNum(mess, 37)
};

function shouldCopyProfileEntry(profileRoot, sourcePath) {
    const relativePath = path.relative(profileRoot, sourcePath);
    if (!relativePath) {
        return true;
    }

    const basename = path.basename(sourcePath);
    if (basename === 'SingletonCookie' || basename === 'SingletonLock' || basename === 'SingletonSocket' || basename === 'LOCK') {
        return false;
    }

    const segments = relativePath.split(path.sep);
    return !segments.some((segment) => PROFILE_CACHE_SEGMENTS.has(segment));
}

function cloneChromeProfile(userDataDir, profileDirectory) {
    const tempUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-exporter-chrome-'));
    const sourceProfileDir = path.join(userDataDir, profileDirectory);
    const targetProfileDir = path.join(tempUserDataDir, profileDirectory);

    if (!fs.existsSync(sourceProfileDir)) {
        throw new Error(`Chrome profile not found: ${sourceProfileDir}`);
    }

    for (const fileName of ROOT_FILES_TO_COPY) {
        const sourcePath = path.join(userDataDir, fileName);
        const targetPath = path.join(tempUserDataDir, fileName);
        if (fs.existsSync(sourcePath)) {
            fs.cpSync(sourcePath, targetPath, { recursive: true });
        }
    }

    fs.cpSync(sourceProfileDir, targetProfileDir, {
        recursive: true,
        filter: (sourcePath) => shouldCopyProfileEntry(sourceProfileDir, sourcePath),
    });

    return tempUserDataDir;
}

function buildLaunchContext() {
    const useLocalChrome = process.env.USE_LOCAL_CHROME === '1'
        || process.env.USE_LOCAL_CHROME === 'true'
        || !!process.env.CHROME_USER_DATA_DIR
        || !!process.env.CHROME_PROFILE_DIRECTORY;

    const args = ['--disable-blink-features=AutomationControlled'];
    const options = {
        headless: useLocalChrome ? false : 'new',
        args,
    };
    let cleanup = async () => {};

    const executablePath = process.env.CHROME_EXECUTABLE_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
    if (executablePath) {
        options.executablePath = executablePath;
    } else if (useLocalChrome && fs.existsSync(DEFAULT_MAC_CHROME_PATH)) {
        options.executablePath = DEFAULT_MAC_CHROME_PATH;
    }

    if (useLocalChrome) {
        const userDataDir = process.env.CHROME_USER_DATA_DIR || DEFAULT_MAC_CHROME_USER_DATA_DIR;
        if (!fs.existsSync(userDataDir)) {
            throw new Error(`Chrome user data dir not found: ${userDataDir}`);
        }

        options.defaultViewport = null;
        const profileDirectory = process.env.CHROME_PROFILE_DIRECTORY || 'Default';
        const useClonedProfile = process.env.CLONE_LOCAL_CHROME_PROFILE !== '0';
        const launchUserDataDir = useClonedProfile
            ? cloneChromeProfile(userDataDir, profileDirectory)
            : userDataDir;

        options.userDataDir = launchUserDataDir;
        args.push(`--profile-directory=${profileDirectory}`);

        console.log(`Use local Chrome profile: ${userDataDir} (${profileDirectory})`);
        if (useClonedProfile) {
            console.log(`Clone profile to temp dir: ${launchUserDataDir}`);
            cleanup = async () => {
                fs.rmSync(launchUserDataDir, { recursive: true, force: true });
            };
        } else {
            console.log('Use original Chrome profile directly.');
            console.log('If Chrome is already open, please close it first to avoid profile lock.');
        }
    }

    return { options, cleanup };
}

async function run() {
    if (!process.env.EXPORT_PATH) {
        const outputDir = path.join(process.cwd(), 'output');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir);
        }
        process.env.EXPORT_PATH = outputDir;
        console.log(`The environment variable EXPORT_PATH is not set, so the default ${outputDir} is used as the export path.`);
    }

    const { options, cleanup } = buildLaunchContext();
    const browser = await puppeteer.launch(options);

    try {
        const page = await browser.newPage();
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined,
            });
        });

        await autoLogin(page);
        console.log(color.green('Login successfully!'));
        console.log();

        console.log('Get book stacks ...');
        const books = await getAllBooks(page);

        console.log('Start export all books ...');
        await exportMarkDownFiles(page, books);

        console.log('Process markdown images ...');
        const imageSummary = await processExportedImages(page, process.env.EXPORT_PATH);
        console.log(`Image process finished: markdown files=${imageSummary.markdownFiles}, files updated=${imageSummary.filesUpdated}, links found=${imageSummary.linksFound}, links rewritten=${imageSummary.linksRewritten}, downloaded=${imageSummary.imagesDownloaded}, reused=${imageSummary.imagesReused}, failed=${imageSummary.failedImages.length}`);

        console.log('Verify exported documents ...');
        const verificationReport = await verifyExportArtifacts(page, process.env.EXPORT_PATH, books);
        console.log(`Verification finished: expected=${verificationReport.expectedDocuments}, actual=${verificationReport.actualMarkdownFiles}, hard failures=${verificationReport.hardFailures.length}, remote empty=${verificationReport.remoteEmptyDocuments.length}, remaining remote images=${verificationReport.remainingRemoteImageLinks}`);
        console.log(`Verification report saved to ${verificationReport.reportJsonPath}`);

        if (!verificationReport.isComplete) {
            throw new Error(`Export verification failed. See ${verificationReport.reportMarkdownPath}`);
        }
    } finally {
        await browser.close();
        await cleanup();
    }
}

run().catch(async (error) => {
    console.error(error.message || error);
    process.exit(1);
});
