/* eslint-disable class-methods-use-this */
import { writeFileSync } from 'fs';
import { TOTP } from 'otpauth';
import { Logger } from 'pino';
import { Cookie, ElementHandle, Page, Response } from 'puppeteer';
import logger from '../common/logger';
import puppeteer, {
  getDevtoolsUrl,
  toughCookieFileStoreToPuppeteerCookie,
} from '../common/puppeteer';
import { getCookiesRaw, setPuppeteerCookies } from '../common/request';
import { getHcaptchaCookies } from './hcaptcha';
import { EPIC_CLIENT_ID } from '../common/constants';

const NOTIFICATION_TIMEOUT = 24 * 60 * 60 * 1000; // TODO: Add to config

export default class PuppetLogin {
  private L: Logger;

  private email: string;

  private password: string;

  private totp?: string;

  constructor(email: string, password: string, totp?: string) {
    this.L = logger.child({
      user: email,
    });
    this.email = email;
    this.password = password;
    this.totp = totp;
  }

  private async startLogin(page: Page): Promise<void> {
    this.L.trace('Navigating to Epic Games login page');
    await Promise.all([
      page.goto(
        `https://www.epicgames.com/id/login/epic?redirect_uri=https://www.epicgames.com/store/en-US/&client_id=${EPIC_CLIENT_ID}`
      ),
      page.waitForNavigation({ waitUntil: 'networkidle0' }),
    ]);
    this.L.trace('Waiting for email field');
    const emailElem = await page.waitForSelector('#email');
    this.L.trace('Filling email field');
    await emailElem.focus();
    await emailElem.type(this.email, { delay: 50 });
    this.L.trace('Waiting for password field');
    const passElem = await page.waitForSelector('#password');
    this.L.trace('Filling password field');
    await passElem.focus();
    await passElem.type(this.password, { delay: 50 });
    this.L.trace('Waiting for sign-in button');
    const [signInElem] = await Promise.all([
      page.waitForSelector('#sign-in:not([disabled])'),
      page.waitForTimeout(10000), // TODO: why is this required?
    ]);
    // Remember me should be checked by default
    this.L.trace('Clicking sign-in button');
    await signInElem.hover();
    await signInElem.focus();
    try {
      await Promise.all([
        await signInElem.click({ delay: 100 }),
        await this.handleLoginClick(page),
      ]);
    } catch (err) {
      const content = await page.content();
      writeFileSync('test.html', content);
      await page.screenshot({ path: 'test.png' });
      throw err;
    }
  }

  async login(): Promise<void> {
    const hCaptchaCookies = await getHcaptchaCookies();
    const userCookies = await getCookiesRaw(this.email);
    const puppeteerCookies = toughCookieFileStoreToPuppeteerCookie(userCookies);
    this.L.debug('Logging in with puppeteer');
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--disable-web-security', '--disable-features=IsolateOrigins,site-per-process'],
    });
    const page = await browser.newPage();
    this.L.trace(getDevtoolsUrl(page));
    const cdpClient = await page.target().createCDPSession();
    await cdpClient.send('Network.setCookies', {
      cookies: [...puppeteerCookies, ...hCaptchaCookies],
    });
    await page.setCookie(...puppeteerCookies, ...hCaptchaCookies);
    await this.startLogin(page);

    this.L.trace('Saving new cookies');
    const currentUrlCookies = (await cdpClient.send('Network.getAllCookies')) as {
      cookies: Cookie[];
    };
    this.L.trace({ currentUrlCookies });
    await browser.close();
    setPuppeteerCookies(this.email, currentUrlCookies.cookies);
  }

  private async waitForHCaptcha(page: Page): Promise<ElementHandle<Element>> {
    const talonHandle = await page.$('iframe#talon_frame_login_prod');
    if (!talonHandle) throw new Error('Could not find talon_frame_login_prod');
    const talonFrame = await talonHandle.contentFrame();
    if (!talonFrame) throw new Error('Could not find talonFrame contentFrame');
    this.L.trace('Waiting for hcaptcha iframe');
    const hcaptchaFrame = await talonFrame.waitForSelector(`iframe[src*='hcaptcha']`);
    return hcaptchaFrame;
  }

  // eslint-disable-next-line class-methods-use-this
  private async handleLoginClick(page: Page): Promise<void> {
    this.L.trace('Waiting for sign-in result');
    const cdpClient = await page.target().createCDPSession();
    const currentUrlCookies = (await cdpClient.send('Network.getAllCookies')) as {
      cookies: Cookie[];
    };
    writeFileSync('test-cookies.json', JSON.stringify(currentUrlCookies, null, 2)); // TODO: Remove
    const result = await Promise.race([
      this.waitForHCaptcha(page),
      page.waitForNavigation({ waitUntil: 'networkidle0' }),
    ]);
    if (!(result as Response).ok) {
      const content = await page.content();
      writeFileSync('test.html', content); // TODO: Remove
      await page.screenshot({ path: 'test.png' }); // TODO: Remove
      this.L.trace('Captcha detected');
      const portalUrl = await page.openPortal();
      this.L.info({ portalUrl }, 'Go to this URL and do something');
      // TODO: Notify with url
      await this.handleCaptchaSolved(page);
      await page.closePortal();
    }
  }

  private async handleCaptchaSolved(page: Page): Promise<void> {
    this.L.trace('Waiting for MFA possibility');
    const result = await Promise.race([
      page.waitForSelector(`input[name="code-input-0]`, {
        timeout: NOTIFICATION_TIMEOUT,
      }),
      page.waitForSelector('div[role="alert"] > h6:first-of-type', {
        timeout: NOTIFICATION_TIMEOUT,
        visible: true,
      }),
      page.waitForNavigation({
        waitUntil: 'networkidle0',
        timeout: NOTIFICATION_TIMEOUT,
      }),
    ]);
    if (!(result as Response).ok) {
      const resultElement = result as ElementHandle<HTMLHeadingElement>;
      if (await resultElement.evaluate(el => el.innerText.includes('refresh'))) {
        const errorMessage = await resultElement.evaluate(el => el.innerText);
        this.L.warn(`Login returned error: ${errorMessage}`);
        await this.startLogin(page);
        return;
      }
      this.L.trace('MFA detected');
      if (!this.totp) throw new Error('TOTP required for MFA login');
      const totp = new TOTP({ secret: this.totp });
      const mfaCode = totp.generate();
      this.L.trace('Filling MFA field');
      await (result as ElementHandle<Element>).type(mfaCode);
      this.L.trace('Waiting for continue button');
      const continueButton = await page.waitForSelector(`button#continue`);
      this.L.trace('Clicking continue button');
      await Promise.all([
        await continueButton.click({ delay: 100 }),
        await page.waitForNavigation({ waitUntil: 'networkidle0' }),
      ]);
    }
  }
}