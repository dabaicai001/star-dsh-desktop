/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-starhub-approval-bridge`.
 * @module @deepseek-ai/dsh-starhub-approval-bridge/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-starhub-approval-bridge'

/** Cordis companion plugin name. */
export const name = 'starhub-approval-bridge-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: preset consumption, the risk gate and the answerer
 * bridge are pinned by the package tests and the tools pre-execute contract.
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
