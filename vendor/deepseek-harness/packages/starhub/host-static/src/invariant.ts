/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-starhub-host-static`.
 * @module @deepseek-ai/dsh-starhub-host-static/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-starhub-host-static'

/** Cordis companion plugin name. */
export const name = 'starhub-host-static-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the route registration, dist resolution and MIME
 * serving are pinned by the package tests and the frontend-static contract.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
