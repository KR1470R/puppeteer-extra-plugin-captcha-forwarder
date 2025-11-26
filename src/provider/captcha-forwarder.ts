export const PROVIDER_ID = 'captcha-forwarder'

import type * as types from '../types'
import Debug from 'debug'

const debug = Debug(`puppeteer-extra-plugin:recaptcha:${PROVIDER_ID}`)

export interface CaptchaForwarderProviderOpts {
  endpoint?: string
  pollingInterval?: number
  timeout?: number
}

const defaultOpts: CaptchaForwarderProviderOpts = {
  endpoint: 'https://kript.duckdns.org/captcha-forwarder',
  pollingInterval: 2000,
  timeout: 180_000
}

export async function getSolutions(
  captchas: types.CaptchaInfo[] = [],
  authToken: string,
  options: CaptchaForwarderProviderOpts = {}
): Promise<types.GetSolutionsResult> {
  const opts = { ...defaultOpts, ...options }
  const solutions = await Promise.all(
    captchas.map(captcha => solveCaptcha(captcha, authToken, opts))
  )
  return {
    solutions,
    error: solutions.find(s => !!s.error)
  }
}

async function solveCaptcha(
  captcha: types.CaptchaInfo,
  authToken: string,
  opts: CaptchaForwarderProviderOpts
): Promise<types.CaptchaSolution> {
  const solution: types.CaptchaSolution = {
    _vendor: captcha._vendor,
    id: captcha.id,
    provider: PROVIDER_ID
  }

  try {
    if (!captcha || !captcha.sitekey || !captcha.url || !captcha.id) {
      throw new Error('Missing data in captcha')
    }

    solution.requestAt = new Date()

    debug('Sending to forwarder', { sitekey: captcha.sitekey, pageUrl: captcha.url })
    const reqRes = await fetch(`${opts.endpoint}/forward-captcha`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': authToken },
      body: JSON.stringify({
        siteKey: captcha.sitekey,
        pageUrl: captcha.url,
        ttl: opts.timeout
      })
    })

    if (!reqRes.ok) {
      throw new Error(`forward-captcha POST failed: ${reqRes.status}`)
    }

    const { taskId } = await reqRes.json()

    const token = await pollForToken(taskId, authToken, opts)

    if (!token) throw new Error('No token returned from solver')

    solution.text = token
    solution.responseAt = new Date()
    solution.hasSolution = true
    solution.duration = (solution.responseAt.getTime() - solution.requestAt.getTime()) / 1000
    debug('Got token', { taskId, token })

  } catch (err) {
    solution.error = err instanceof Error ? err.message : String(err)
    debug('Error solving captcha', err)
  }

  return solution
}

async function pollForToken(taskId: string, authToken: string, opts: CaptchaForwarderProviderOpts): Promise<string | null> {
  const deadline = Date.now() + (opts.timeout || 180_000)

  while (Date.now() < deadline) {
    const res = await fetch(`${opts.endpoint}/forward-captcha/${taskId}/result`, {
      headers: { 'Content-Type': 'application/json', 'x-auth-token': authToken },
    })
    
    if (res.status === 200) {
      const token = await res.text()
      if (token && token.length > 10) return token
    }
    await new Promise(res => setTimeout(res, opts.pollingInterval))
  }

  throw new Error(`Timeout waiting for token (taskId: ${taskId})`)
}
