import { PuppeteerExtraPlugin } from 'puppeteer-extra-plugin'

import { Browser, Frame, Page, Protocol } from 'puppeteer'

import * as types from './types'

import { RecaptchaContentScript } from './content'
import { HcaptchaContentScript } from './content-hcaptcha'
import * as TwoCaptcha from './provider/2captcha'
import * as CaptchaForwarder from './provider/captcha-forwarder'

export const BuiltinSolutionProviders: types.SolutionProvider[] = [
  {
    id: TwoCaptcha.PROVIDER_ID,
    fn: TwoCaptcha.getSolutions
  },
  {
    id: CaptchaForwarder.PROVIDER_ID,
    fn: CaptchaForwarder.getSolutions
  }
]

/**
 * A puppeteer-extra plugin to automatically detect and solve reCAPTCHAs.
 * @noInheritDoc
 */
export class PuppeteerExtraPluginRecaptcha extends PuppeteerExtraPlugin {
  private contentScriptDebug: debug.Debugger;
  private browser: Browser;

  constructor(opts: Partial<types.PluginOptions>) {
    super(opts);
    this.debug('Initialized', this.opts);

    this.contentScriptDebug = this.debug.extend('cs');
  }

  get name() {
    return 'recaptcha';
  }

  get defaults(): types.PluginOptions {
    return {
      visualFeedback: true,
      throwOnError: false,
      solveInViewportOnly: false,
      solveScoreBased: false,
      solveInactiveChallenges: false,
      retriesLimit: 0,
      captchaElementWaitTimeout: 30_000,
    };
  }

  get opts(): types.PluginOptions {
    return super.opts as types.PluginOptions;
  }

  get contentScriptOpts(): types.ContentScriptOpts {
    const { visualFeedback } = this.opts
    return {
      visualFeedback,
      debugBinding: this.contentScriptDebug.enabled
        ? this.debugBindingName
        : undefined
    }
  }

  /** An optional global window object we use for contentscript debug logging */
  private debugBindingName = '___pepr_cs'

  private _generateContentScript(
    vendor: types.CaptchaVendor,
    fn: 'findRecaptchas' | 'enterRecaptchaSolutions',
    data?: any
  ) {
    this.debug('_generateContentScript', vendor, fn, data)
    let scriptSource = RecaptchaContentScript.toString()
    let scriptName = 'RecaptchaContentScript'
    if (vendor === 'hcaptcha') {
      scriptSource = HcaptchaContentScript.toString()
      scriptName = 'HcaptchaContentScript'
    }
    // Some bundlers transform classes to anonymous classes that are assigned to
    // vars (e.g. esbuild). In such cases, `unexpected token '{'` errors are thrown
    // once the script is executed. Let's bring class name back to script in such
    // cases!
    scriptSource = scriptSource.replace(/class \{|class\{/, `class ${scriptName} {`)
    return `(async() => {
      const DATA = ${JSON.stringify(data || null)}
      const OPTS = ${JSON.stringify(this.contentScriptOpts)}

      ${scriptSource}
      const script = new ${scriptName}(OPTS, DATA)
      return script.${fn}()
    })()`
  }

  /** Based on the user defined options we may want to filter out certain captchas (inactive, etc) */
  private _filterRecaptchas(recaptchas: types.CaptchaInfo[] = []) {
    const results = recaptchas.map((c: types.FilteredCaptcha) => {
      if (
        c._type === 'invisible' &&
        !c.hasActiveChallengePopup &&
        !this.opts.solveInactiveChallenges
      ) {
        c.filtered = true
        c.filteredReason = 'solveInactiveChallenges'
      }
      if (c._type === 'score' && !this.opts.solveScoreBased) {
        c.filtered = true
        c.filteredReason = 'solveScoreBased'
      }
      if (
        c._type === 'checkbox' &&
        !c.isInViewport &&
        this.opts.solveInViewportOnly
      ) {
        c.filtered = true
        c.filteredReason = 'solveInViewportOnly'
      }
      if (c.filtered) {
        this.debug('Filtered out captcha based on provided options', {
          id: c.id,
          reason: c.filteredReason,
          captcha: c
        })
      }
      return c
    })
    return {
      captchas: results.filter(c => !c.filtered) as types.CaptchaInfo[],
      filtered: results.filter(c => c.filtered)
    }
  }

  async findRecaptchas(page: Page | Frame, captchaElementWaitTimeout?: number) {
    this.debug('findRecaptchas')

    captchaElementWaitTimeout = captchaElementWaitTimeout ?? this.opts.captchaElementWaitTimeout;
    // As this might be called very early while recaptcha is still loading
    // we add some extra waiting logic for developer convenience.
    let hasRecaptchaScriptTag = undefined;
    try {
      hasRecaptchaScriptTag = await page.waitForSelector(
        `script[src*="/recaptcha/api.js"], script[src*="/recaptcha/enterprise.js"]`,
        {
          timeout: captchaElementWaitTimeout,
        }
      );
    } catch (err) {
      hasRecaptchaScriptTag = undefined;
    }
    this.debug('hasRecaptchaScriptTag', !!hasRecaptchaScriptTag)
    if (hasRecaptchaScriptTag) {
      this.debug('waitForRecaptchaClient - start', new Date())
      await page
        .waitForFunction(
          `
        (function() {
          return Object.keys((window.___grecaptcha_cfg || {}).clients || {}).length
        })()
      `,
          { polling: 200, timeout: captchaElementWaitTimeout }
        )
        .catch(this.debug)
      this.debug('waitForRecaptchaClient - end', new Date()) // used as timer
    }

    // SKIP HCAPTCHA SOLVING
    // let hasHcaptchaScriptTag = undefined;
    // try {
    //   hasHcaptchaScriptTag = await page.waitForSelector(
    //     `script[src*="hcaptcha.com/1/api.js"]`,
    //     {
    //       timeout: captchaElementWaitTimeout,
    //     }
    //   );
    // } catch (err) {
    //   hasHcaptchaScriptTag = undefined;
    // }
    // this.debug('hasHcaptchaScriptTag', !!hasHcaptchaScriptTag)
    // if (hasHcaptchaScriptTag) {
    //   this.debug('wait:hasHcaptchaScriptTag - start', new Date())
    //   await page.waitForFunction(
    //     `
    //     (function() {
    //       return window.hcaptcha
    //     })()
    //   `,
    //     { polling: 200, timeout: captchaElementWaitTimeout }
    //   )
    //   this.debug('wait:hasHcaptchaScriptTag - end', new Date()) // used as timer
    // }

    const onDebugBindingCalled = (message: string, data: any) => {
      this.contentScriptDebug(message, data)
    }

    if (this.contentScriptDebug.enabled) {
      if ('exposeFunction' in page) {
        try {
          await page.exposeFunction(this.debugBindingName, onDebugBindingCalled)
        } catch (err) {
          if (err?.message && !err.message.includes(`window['${this.debugBindingName}'] already exists`)) {
            throw err;
          }
        }
      }
    }
    // Even without a recaptcha script tag we're trying, just in case.
    const resultRecaptcha: types.FindRecaptchasResult = (await page.evaluate(
      this._generateContentScript('recaptcha', 'findRecaptchas')
    )) as any
    // const resultHcaptcha: types.FindRecaptchasResult = (await page.evaluate(
    //   this._generateContentScript('hcaptcha', 'findRecaptchas')
    // )) as any

    const filterResults = this._filterRecaptchas(resultRecaptcha.captchas)
    this.debug(
      `Filter results: ${filterResults.filtered.length} of ${filterResults.captchas.length} captchas filtered from results.`
    )

    const response: types.FindRecaptchasResult = {
      captchas: [
        ...filterResults.captchas, 
        //...resultHcaptcha.captchas,
      ],
      filtered: filterResults.filtered,
      error: resultRecaptcha.error //|| resultHcaptcha.error
    }
    this.debug('findRecaptchas', response)
    if (this.opts.throwOnError && response.error) {
      throw new Error(response.error)
    }
    return response
  }

  async getRecaptchaSolutions(
    captchas: types.CaptchaInfo[],
    provider?: types.SolutionProvider,
    cookies?: Protocol.Network.Cookie[], 
    ua?: string
  ) {
    this.debug('getRecaptchaSolutions', { captchaNum: captchas.length })
    provider = provider || this.opts.provider
    if (
      !provider ||
      (!provider.token && !provider.fn) ||
      (provider.token && provider.token === 'XXXXXXX' && !provider.fn)
    ) {
      throw new Error('Please provide a solution provider to the plugin.')
    }
    let fn = provider.fn
    if (!fn) {
      const builtinProvider = BuiltinSolutionProviders.find(
        p => p.id === (provider || {}).id
      )
      if (!builtinProvider || !builtinProvider.fn) {
        throw new Error(
          `Cannot find builtin provider with id '${provider.id}'.`
        )
      }
      fn = builtinProvider.fn
    }
    provider.opts = {
      ...(provider.opts || {}),
    }
    if (cookies) {
      provider.opts.cookies = cookies;
    }
    if (ua) {
      provider.opts.ua = ua;
    }
    const response = await fn.call(
      this,
      captchas,
      provider.token,
      provider.opts || {}
    )
    response.error =
      response.error ||
      response.solutions.find((s: types.CaptchaSolution) => !!s.error)
    this.debug('getRecaptchaSolutions', response)
    if (response && response.error) {
      console.warn(
        'PuppeteerExtraPluginRecaptcha: An error occured during "getRecaptchaSolutions":',
        response.error
      )
    }
    if (this.opts.throwOnError && response.error) {
      throw new Error(response.error)
    }
    return response
  }

  async enterRecaptchaSolutions(
    page: Page | Frame,
    solutions: types.CaptchaSolution[]
  ) {
    this.debug('enterRecaptchaSolutions', { solutions })

    const hasRecaptcha = !!solutions.find(s => s._vendor === 'recaptcha')
    const solvedRecaptcha: types.EnterRecaptchaSolutionsResult = hasRecaptcha
      ? ((await page.evaluate(
          this._generateContentScript('recaptcha', 'enterRecaptchaSolutions', {
            solutions
          })
        )) as any)
      : { solved: [] }
    const hasHcaptcha = !!solutions.find(s => s._vendor === 'hcaptcha')
    const solvedHcaptcha: types.EnterRecaptchaSolutionsResult = hasHcaptcha
      ? ((await page.evaluate(
          this._generateContentScript('hcaptcha', 'enterRecaptchaSolutions', {
            solutions
          })
        )) as any)
      : { solved: [] }

    const response: types.EnterRecaptchaSolutionsResult = {
      solved: [...solvedRecaptcha.solved, ...solvedHcaptcha.solved],
      error: solvedRecaptcha.error || solvedHcaptcha.error
    }
    response.error = response.error || response.solved.find(s => !!s.error)
    this.debug('enterRecaptchaSolutions', response)
    if (this.opts.throwOnError && response.error) {
      throw new Error(response.error)
    }
    return response
  }

  async solveRecaptchas(
    page: Page | Frame,
    customRetriesLimit?: number,
    captchaElementWaitTimeout?: number,
  ): Promise<types.SolveRecaptchasResult> {
    return new Promise<types.SolveRecaptchasResult>((resolve, reject) => {
      this.debug('solveRecaptchas');
      customRetriesLimit = customRetriesLimit ?? this.opts.retriesLimit;
      const response: types.SolveRecaptchasResult = {
        captchas: [],
        filtered: [],
        solutions: [],
        solved: [],
        error: null,
      };
      let canFinish = false;
      let tries = 0;
      let pauseInterval = false;
      let persistentCaptchaSolving = undefined;

      const checkStop = () => {
        if (canFinish || tries >= customRetriesLimit) {
          clearInterval(persistentCaptchaSolving);
          pauseInterval = true;
          if (this.opts.throwOnError && response.error) {
            reject(response.error);
          } else {
            resolve(response);
          }
        }

        return pauseInterval;
      }

      persistentCaptchaSolving = setInterval(async () => {
        if (checkStop()) return;

        try {
          pauseInterval = true;

          /**
           * @todo
           * наразі є баг, коли воно ніби після першої ітерації відправило серверу запрос, потім коли капча рефрешиться,
           * то таймаут на вейт селекта не працює, він не чекає просто, і того воно кидає помилки і просирає ретраї
           * + навіть коли встигає найти капчу, і я вирішую на воркері, то солюшн не підставляється
           */
          let previousCaptchasExist = false;
          let {
            captchas,
            filtered,
            error: captchasError
          } = await this.findRecaptchas(page, captchaElementWaitTimeout);
          captchas = captchas.filter(c => {
            const existentCaptcha = response.captchas.find(ec => ec.id === c.id);
            const isNotExist = typeof existentCaptcha === 'undefined';
            // if (!previousCaptchasExist) {
              previousCaptchasExist = !isNotExist;
            // }
            return isNotExist;
          });
          filtered = filtered.filter(fc => {
            const existentFilteredCaptcha = response.filtered.find(efc => efc.id === fc.id);
            return typeof existentFilteredCaptcha === 'undefined';
          });
          if (captchas.length === 0) {
            if (previousCaptchasExist) {
              pauseInterval = false;
              return;
            } else {
              throw new Error('no captcha element found on this page');
            }
          } else {
            if (!previousCaptchasExist) {
              response.captchas = captchas;
            } else {
              response.captchas = [...response.captchas, ...captchas];
            }
            tries = 0;
          }

          pauseInterval = false;
          
          response.filtered = [...response.filtered, ...filtered];

          const cookies = await(page as Page).cookies();
          const ua = await this.browser.userAgent();
          const {
            solutions,
            error: solutionsError,
          } = await this.getRecaptchaSolutions(response.captchas, undefined, cookies, ua);
          response.solutions = solutions;

          const {
            solved,
            error: solvedError,
          } = await this.enterRecaptchaSolutions(page, response.solutions);
          response.solved = solved;

          if (solved && solved.length) {
            canFinish = true;
          } else {
            response.error = captchasError || solutionsError || solvedError;
          }
        } catch (error) {
          response.error = error.toString()
          tries++;
        } finally {
          this.debug('solveRecaptchas', response, 'after try', tries + 1);
          pauseInterval = false;
        }
      }, 2_500);
    });
  }

  private _addCustomMethods(prop: Page | Frame) {
    prop.findRecaptchas = async () => this.findRecaptchas(prop)
    prop.getRecaptchaSolutions = async (
      captchas: types.CaptchaInfo[],
      provider?: types.SolutionProvider
    ) => this.getRecaptchaSolutions(captchas, provider)
    prop.enterRecaptchaSolutions = async (solutions: types.CaptchaSolution[]) =>
      this.enterRecaptchaSolutions(prop, solutions)
    // Add convenience methods that wraps all others
    prop.solveRecaptchas = async (customRetriesLimit?: number, captchaElementWaitTimeout?: number) => this.solveRecaptchas(prop, customRetriesLimit, captchaElementWaitTimeout)
  }

  async onPageCreated(page: Page) {
    this.debug('onPageCreated', page.url())
    // Make sure we can run our content script
    await page.setBypassCSP(true)

    // Add custom page methods
    this._addCustomMethods(page)

    // Add custom methods to potential frames as well
    page.on('frameattached', frame => {
      if (!frame) return
      this._addCustomMethods(frame)
    })
  }

  /** Add additions to already existing pages and frames */
  async onBrowser(browser: Browser) {
    this.browser = browser;
    const pages = await browser.pages()
    for (const page of pages) {
      this._addCustomMethods(page)
      for (const frame of page.mainFrame().childFrames()) {
        this._addCustomMethods(frame)
      }
    }
  }
}

/** Default export, PuppeteerExtraPluginRecaptcha  */
const defaultExport = (options?: Partial<types.PluginOptions>) => {
  return new PuppeteerExtraPluginRecaptcha(options || {})
}

export default defaultExport
