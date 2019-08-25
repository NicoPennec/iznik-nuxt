// Taken from oauth2 but extended for our server.
import { encodeQuery, parseQuery } from '../utilities'

import nanoid from 'nanoid'
const isHttps = process.server ? require('is-https') : null

const DEFAULTS = {
  token_type: 'Bearer',
  response_type: 'token',
  tokenName: 'Authorization'
}

export default class Oauth2Scheme {
  constructor (auth, options) {
    this.$auth = auth
    this.req = auth.ctx.req
    this.name = options._name

    this.options = Object.assign({}, DEFAULTS, options)
  }

  get _scope () {
    return Array.isArray(this.options.scope)
      ? this.options.scope.join(' ')
      : this.options.scope
  }

  get _redirectURI () {
    const url = this.options.redirect_uri

    if (url) {
      return url
    }

    if (process.server && this.req) {
      const protocol = 'http' + (isHttps(this.req) ? 's' : '') + '://'

      return protocol + this.req.headers.host + this.$auth.options.redirect.callback
    }

    if (process.client) {
      return window.location.origin + this.$auth.options.redirect.callback
    }
  }

  async mounted () {
    console.log("facebookStrategy mounted")
    // Sync token
    const token = this.$auth.syncToken(this.name)
    console.log("Token", token)
    // Set axios token
    if (token) {
      this._setToken(token)
    }

    // Handle callbacks on page load
    const redirected = await this._handleCallback()
    console.log("Redirected", redirected)

    if (!redirected) {
      return this.$auth.fetchUserOnce()
    }
  }

  _setToken (token) {
    // Set Authorization token for all axios requests
    this.$auth.ctx.app.$axios.setHeader(this.options.tokenName, token)
  }

  _clearToken () {
    // Clear Authorization token for all axios requests
    this.$auth.ctx.app.$axios.setHeader(this.options.tokenName, false)
  }

  async logout () {
    this._clearToken()
    return this.$auth.reset()
  }

  login ({ params, state, nonce } = {}) {
    const opts = {
      protocol: 'oauth2',
      response_type: this.options.response_type,
      access_type: this.options.access_type,
      client_id: this.options.client_id,
      redirect_uri: this._redirectURI,
      scope: this._scope,
      // Note: The primary reason for using the state parameter is to mitigate CSRF attacks.
      // https://auth0.com/docs/protocols/oauth2/oauth-state
      state: state || nanoid(),
      ...params
    }

    if (this.options.audience) {
      opts.audience = this.options.audience
    }

    // Set Nonce Value if response_type contains id_token to mitigate Replay Attacks
    // More Info: https://openid.net/specs/openid-connect-core-1_0.html#NonceNotes
    // More Info: https://tools.ietf.org/html/draft-ietf-oauth-v2-threatmodel-06#section-4.6.2
    if (opts.response_type.includes('id_token')) {
      // nanoid auto-generates an URL Friendly, unique Cryptographic string
      // Recommended by Auth0 on https://auth0.com/docs/api-auth/tutorials/nonce
      opts.nonce = nonce || nanoid()
    }

    this.$auth.$storage.setUniversal(this.name + '.state', opts.state)

    const url = this.options.authorization_endpoint + '?' + encodeQuery(opts)

    window.location = url
  }

  // loginWithFacebookToken(token) {
  //   // Now use the Facebook access token log in to the server.
  //   this.$auth.setStrategy('native')
  //   this.$nextTick(async () => {
  //     await this.$auth
  //       .loginWith('native', {
  //         data: {
  //           fblogin: 1,
  //           fbaccesstoken: token
  //         }
  //       })
  //       .then(() => {
  //         console.log('Done native part of login')
  //         this.$auth.fetchUser()
  //       })
  //       .catch(e => {
  //         console.error('Failed login 2', e)
  //         // TODO
  //       })
  //   })
  // }
  //
  async fetchUser () {
    if (!this.$auth.getToken(this.name)) {
      return
    }

    if (!this.options.userinfo_endpoint) {
      this.$auth.setUser({})
      return
    }

    const user = await this.$auth.requestWith(this.name, {
      url: this.options.userinfo_endpoint
    })

    this.$auth.setUser(user)
  }

  async _handleCallback (uri) {
    try {
      console.log("facebookStrategy callback", uri, this.$auth.options.redirect, this.$auth.ctx.route.path)
      // Handle callback only for specified route
      if (this.$auth.options.redirect && this.$auth.ctx.route.path !== this.$auth.options.redirect.callback) {
        console.log("No route match")
        return
      }
      console.log("Route match")
      console.log("Process", process)
      // Callback flow is not supported in static generation
      if (process.server && process.static) {
        console.log("No static")
        return
      }

      console.log("Get hash")
      const hash = parseQuery(this.$auth.ctx.route.hash.substr(1))
      conole.log("Hash", hash)
      const parsedQuery = Object.assign({}, this.$auth.ctx.route.query, hash)
      // accessToken/idToken
      let token = parsedQuery[this.options.token_key || 'access_token']
      console.log("Token", token)
      // refresh token
      let refreshToken = parsedQuery[this.options.refresh_token_key || 'refresh_token']

      // Validate state
      const state = this.$auth.$storage.getUniversal(this.name + '.state')
      console.log("State", state)
      this.$auth.$storage.setUniversal(this.name + '.state', null)
      if (state && parsedQuery.state !== state) {
        return
      }

      // -- Authorization Code Grant --
      if (this.options.response_type === 'code' && parsedQuery.code) {
        console.log("Grant")
        const data = await this.$auth.request({
          method: 'post',
          url: this.options.access_token_endpoint,
          baseURL: process.server ? undefined : false,
          data: encodeQuery({
            code: parsedQuery.code,
            client_id: this.options.client_id,
            redirect_uri: this._redirectURI,
            response_type: this.options.response_type,
            audience: this.options.audience,
            grant_type: this.options.grant_type
          })
        })

        console.log("Data", data)

        if (data.access_token) {
          token = data.access_token
        }

        if (data.refresh_token) {
          refreshToken = data.refresh_token
        }

        console.log("Got token", token)
      }

      if (!token || !token.length) {
        return
      }

      // Append token_type
      if (this.options.token_type) {
        token = this.options.token_type + ' ' + token
      }

      // Store token
      this.$auth.setToken(this.name, token)

      // Set axios token
      this._setToken(token)

      // Store refresh token
      if (refreshToken && refreshToken.length) {
        refreshToken = this.options.token_type + ' ' + refreshToken
        this.$auth.setRefreshToken(this.name, refreshToken)
      }

      // Redirect to home
      this.$auth.redirect('home', true)
    } catch (e) {
      console.log("facebookCallback error", e)
    }

    return true // True means a redirect happened
  }
}
