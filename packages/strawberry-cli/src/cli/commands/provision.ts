/**
 * `strawberry provision <wifi|identity|wireguard>` — convenience aliases over the
 * provisioning surface so the setup flow reads top-to-bottom.
 *
 *   wifi      -> same as `net wifi`   (WifiSet)
 *   wireguard -> same as `wg apply`   (WgSet from a wg-quick .conf)
 *   identity  -> ADR-0060 factory-identity QR claim is DESIGN-ONLY: no firmware
 *                claim wire surface exists yet (mfg_data is read-only). This verb
 *                is a documented stub that refuses rather than pretending to
 *                claim — use `auth login` + `net wifi` + `wg apply` today.
 */
import { CliError } from '../output.js';
import { type ParsedArgs } from '../args.js';
import { cmdNet } from './net.js';
import { cmdWg } from './wg.js';

export async function cmdProvision(p: ParsedArgs): Promise<void> {
  const sub = p.positionals[1];
  switch (sub) {
    case 'wifi':
      // Re-dispatch to `net wifi` by faking the positional shape.
      return cmdNet({ ...p, positionals: ['net', 'wifi', ...p.positionals.slice(2)] });
    case 'wireguard': case 'wg':
      return cmdWg({ ...p, positionals: ['wg', 'apply', ...p.positionals.slice(2)] });
    case 'identity': case 'claim':
      throw new CliError(
        'provision identity: ADR-0060 QR claim is design-only — no firmware claim ' +
        'surface yet. Use `auth login` + `provision wifi` + `provision wireguard`.',
        2,
      );
    default:
      throw new CliError('provision <wifi|wireguard|identity>');
  }
}
