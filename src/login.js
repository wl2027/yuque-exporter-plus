import fs from 'fs';

const COOKIE_FILE = './cookies.json';
const LOGIN_URL = 'https://www.yuque.com/login';
const DASHBOARD_URL = 'https://www.yuque.com/dashboard';
const SWITCH_TO_PASSWORD_SELECTOR = '[data-testid="switchBtn"], .switch-btn';
const USER_INPUT_SELECTOR = 'input[data-testid="prefix-phone-input"]';
const PASSWORD_INPUT_SELECTOR = 'input[data-testid="loginPasswordInput"]';
const LOGIN_BUTTON_SELECTOR = 'button[data-testid="btnLogin"]';
const PROTOCOL_CHECKBOX_SELECTOR = 'input[data-testid="protocolCheckBox"]';
const NEW_CAPTCHA_HANDLE_SELECTOR = '#aliyunCaptcha-sliding-slider';
const NEW_CAPTCHA_TRACK_SELECTOR = '#aliyunCaptcha-sliding-wrapper';
const NEW_CAPTCHA_VERIFY_SELECTOR = '#captchaVerifyParam';
const LEGACY_CAPTCHA_HANDLE_SELECTOR = 'span[id="nc_2_n1z"], #nc_2_n1z';
const LEGACY_CAPTCHA_TRACK_SELECTOR = '.nc-lang-cnt';
const MANUAL_LOGIN_TIMEOUT_MS = Number(process.env.MANUAL_LOGIN_TIMEOUT_MS || 10 * 60 * 1000);

export async function autoLogin(page) {
    await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle2' });
    if (!isLoginPage(page.url())) {
        console.log('Login use current browser session...');
        await saveCookies(page);
        return;
    }

    const cookies = readCookies(COOKIE_FILE);

    // 如果存在 cookie，则优先加载；失效时再回退到账号密码登录
    if (cookies.length > 0) {
        console.log('Login use cookies...');
        await page.setCookie(...cookies);
        await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle2' });

        if (!isLoginPage(page.url())) {
            await saveCookies(page);
            return;
        }

        console.log('Saved cookies expired, fallback to user + password...');
        const currentCookies = await page.cookies();
        if (currentCookies.length > 0) {
            await page.deleteCookie(...currentCookies);
        }
    }

    console.log('Login use user + password...');

    if (!process.env.USER) {
        if (shouldWaitForManualLogin()) {
            console.log('No reusable browser session or cookie, switch to manual login...');
            await waitForManualLogin(page);
            await saveCookies(page);
            return;
        }

        console.log('no browser session or cookie, so use env var: USER required');
        process.exit(1);
    }

    if (!process.env.PASSWORD) {
        if (shouldWaitForManualLogin()) {
            console.log('Password is missing, switch to manual login...');
            await waitForManualLogin(page);
            await saveCookies(page);
            return;
        }

        console.log('no browser session or cookie, so use env var: PASSWORD required');
        process.exit(1);
    }

    try {
        await page.goto(LOGIN_URL, { waitUntil: 'networkidle2' });
        await switchToPasswordLogin(page);
        await fillInput(page, USER_INPUT_SELECTOR, process.env.USER);
        await fillInput(page, PASSWORD_INPUT_SELECTOR, process.env.PASSWORD);
        await scrollCaptcha(page);
        await ensureProtocolChecked(page);
        await submitLogin(page);
        await saveCookies(page);
    } catch (error) {
        if (!shouldWaitForManualLogin()) {
            throw error;
        }

        console.log(`${error.message} Switch to manual login...`);
        await waitForManualLogin(page);
        await saveCookies(page);
    }
}

function readCookies(cookieFile) {
    if (!fs.existsSync(cookieFile)) {
        return [];
    }

    try {
        const cookiesString = fs.readFileSync(cookieFile, 'utf8');
        const cookies = JSON.parse(cookiesString);
        return Array.isArray(cookies) ? cookies.map(normalizeCookie) : [];
    } catch (error) {
        console.log(`Ignore invalid cookies.json: ${error.message}`);
        return [];
    }
}

function normalizeCookie(cookie) {
    const normalizedCookie = { ...cookie };
    if (normalizedCookie.partitionKey && typeof normalizedCookie.partitionKey !== 'string') {
        delete normalizedCookie.partitionKey;
    }

    return normalizedCookie;
}

function isLoginPage(url) {
    try {
        return new URL(url).pathname.startsWith('/login');
    } catch (error) {
        return false;
    }
}

function shouldWaitForManualLogin() {
    return process.env.WAIT_FOR_MANUAL_LOGIN !== '0';
}

async function saveCookies(page) {
    const nextCookies = await page.cookies();
    if (nextCookies.length === 0) {
        return;
    }

    fs.writeFileSync(COOKIE_FILE, JSON.stringify(nextCookies));
    console.log('Save cookie to cookies.json');
}

async function waitForManualLogin(page) {
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2' });
    await page.bringToFront();
    console.log('Please complete the login manually in the opened browser window...');

    await page.waitForFunction(
        () => !window.location.pathname.startsWith('/login'),
        { timeout: MANUAL_LOGIN_TIMEOUT_MS }
    );

    await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle2' });
    if (isLoginPage(page.url())) {
        throw new Error('Manual login did not complete successfully.');
    }
}

async function switchToPasswordLogin(page) {
    if (await page.$(PASSWORD_INPUT_SELECTOR)) {
        return;
    }

    const switchButton = await page.waitForSelector(SWITCH_TO_PASSWORD_SELECTOR, {
        visible: true,
        timeout: 10000,
    });

    await switchButton.click();
    await page.waitForSelector(PASSWORD_INPUT_SELECTOR, {
        visible: true,
        timeout: 10000,
    });
}

async function fillInput(page, selector, value) {
    await page.waitForSelector(selector, {
        visible: true,
        timeout: 10000,
    });

    await page.click(selector, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.type(selector, value, { delay: 60 });
}

async function ensureProtocolChecked(page) {
    await page.waitForSelector(PROTOCOL_CHECKBOX_SELECTOR, {
        visible: true,
        timeout: 10000,
    });

    const checked = await page.$eval(PROTOCOL_CHECKBOX_SELECTOR, (checkbox) => checkbox.checked);
    if (!checked) {
        await page.click(PROTOCOL_CHECKBOX_SELECTOR);
    }
}

async function submitLogin(page) {
    await page.waitForSelector(LOGIN_BUTTON_SELECTOR, {
        visible: true,
        timeout: 10000,
    });

    await page.waitForFunction((selector) => {
        const button = document.querySelector(selector);
        return button && !button.disabled;
    }, {}, LOGIN_BUTTON_SELECTOR);

    const navigationPromise = page.waitForNavigation({
        waitUntil: 'networkidle2',
        timeout: 20000,
    }).catch(() => null);
    const locationPromise = page.waitForFunction(
        () => !window.location.pathname.startsWith('/login'),
        { timeout: 20000 }
    ).catch(() => null);

    await page.click(LOGIN_BUTTON_SELECTOR);
    await Promise.race([navigationPromise, locationPromise]);

    if (isLoginPage(page.url())) {
        const errorMessage = await getLoginErrorMessage(page);
        throw new Error(errorMessage || 'Login failed, captcha may not have passed or the page structure changed.');
    }
}

async function getLoginErrorMessage(page) {
    return page.evaluate(() => {
        const selectors = [
            '.ant-message-notice-content',
            '.ant-form-item-explain-error',
            '#aliyunCaptcha-sliding-failTip',
            '[role="alert"]',
        ];

        for (const selector of selectors) {
            const node = document.querySelector(selector);
            const text = node?.textContent?.trim();
            if (text) {
                return text;
            }
        }

        return '';
    });
}

async function scrollCaptcha(page) {
    const captchaType = await detectCaptcha(page);
    if (!captchaType) {
        console.log('No sliding captcha detected, continue login...');
        return;
    }

    console.log(`Sliding captcha detected (${captchaType})...`);

    const solved = captchaType === 'new'
        ? await dragNewCaptcha(page)
        : await dragLegacyCaptcha(page);

    if (!solved) {
        throw new Error('Sliding captcha failed, please retry or login once manually to generate cookies.json.');
    }
}

async function detectCaptcha(page) {
    const deadline = Date.now() + 5000;

    while (Date.now() < deadline) {
        if (await page.$(NEW_CAPTCHA_HANDLE_SELECTOR)) {
            return 'new';
        }

        if (await page.$(LEGACY_CAPTCHA_HANDLE_SELECTOR)) {
            return 'legacy';
        }

        await page.waitForTimeout(200);
    }

    return null;
}

async function dragNewCaptcha(page) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const handle = await page.$(NEW_CAPTCHA_HANDLE_SELECTOR);
        const track = await page.$(NEW_CAPTCHA_TRACK_SELECTOR);
        if (!handle || !track) {
            return true;
        }

        const handleInfo = await handle.boundingBox();
        const trackInfo = await track.boundingBox();
        if (!handleInfo || !trackInfo) {
            await page.waitForTimeout(500);
            continue;
        }

        const startX = handleInfo.x + handleInfo.width / 2;
        const startY = handleInfo.y + handleInfo.height / 2;
        const endX = trackInfo.x + trackInfo.width - handleInfo.width / 2 - 2;

        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await dragWithTrack(page, startX, startY, endX);
        await page.mouse.up();
        await page.waitForTimeout(1500);

        if (await isNewCaptchaSolved(page)) {
            return true;
        }
    }

    return false;
}

async function isNewCaptchaSolved(page) {
    return page.evaluate((selectors) => {
        const verifyValue = document.querySelector(selectors.verify)?.value?.trim();
        if (verifyValue) {
            return true;
        }

        const wrapper = document.querySelector(selectors.wrapper);
        if (!wrapper || wrapper.offsetParent === null) {
            return true;
        }

        const text = document.querySelector(selectors.text)?.textContent?.trim() || '';
        const failTip = document.querySelector(selectors.failTip)?.textContent?.trim() || '';
        const sliderLeft = document.querySelector(selectors.handle)?.style?.left || '';

        return /验证通过|成功|完成/.test(text)
            || /验证通过|成功|完成/.test(failTip)
            || (sliderLeft !== '' && sliderLeft !== '0px');
    }, {
        verify: NEW_CAPTCHA_VERIFY_SELECTOR,
        wrapper: NEW_CAPTCHA_TRACK_SELECTOR,
        text: '#aliyunCaptcha-sliding-text',
        failTip: '#aliyunCaptcha-sliding-failTip',
        handle: NEW_CAPTCHA_HANDLE_SELECTOR,
    });
}

async function dragLegacyCaptcha(page) {
    const start = await page.waitForSelector(LEGACY_CAPTCHA_HANDLE_SELECTOR, {
        visible: true,
        timeout: 10000,
    });
    const end = await page.waitForSelector(LEGACY_CAPTCHA_TRACK_SELECTOR, {
        visible: true,
        timeout: 10000,
    });

    const startInfo = await start.boundingBox();
    const endInfo = await end.boundingBox();

    if (!startInfo || !endInfo) {
        return false;
    }

    const startX = startInfo.x + startInfo.width / 2;
    const startY = startInfo.y + startInfo.height / 2;
    const endX = endInfo.x + endInfo.width - startInfo.width / 2;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await dragWithTrack(page, startX, startY, endX);
    await page.mouse.up();
    await page.waitForTimeout(1000);

    return true;
}

async function dragWithTrack(page, startX, startY, endX) {
    const distance = endX - startX;
    const steps = 35;

    for (let index = 1; index <= steps; index++) {
        const progress = index / steps;
        const currentX = startX + distance * progress;
        const currentY = startY + ((index % 3) - 1) * 0.4;
        await page.mouse.move(currentX, currentY);
        await page.waitForTimeout(15 + (index % 5) * 10);
    }

    await page.waitForTimeout(120);
    await page.mouse.move(endX - 2, startY + 0.4);
    await page.waitForTimeout(90);
    await page.mouse.move(endX, startY);
}
