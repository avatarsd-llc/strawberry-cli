/**
 * `strawberry net wifi|ha|info` — provision Wi-Fi STA credentials and the
 * Home-Assistant MQTT auto-discovery integration, and read live WifiState /
 * HaConfig. The step that moves a fresh board off SoftAP onto the LAN.
 */
import { Query_What } from '../../proto/messages.js';
import { printJson, printLine, printKv, CliError } from '../output.js';
import { flagBool, flagStr, type ParsedArgs } from '../args.js';
import { openSession, dispose } from '../connect.js';

export async function cmdNet(p: ParsedArgs): Promise<void> {
  const sub = p.positionals[1];
  switch (sub) {
    case 'wifi': return netWifi(p);
    case 'ha': return netHa(p);
    case 'info': return netInfo(p);
    default:
      throw new CliError('net <wifi|ha|info>');
  }
}

async function netWifi(p: ParsedArgs): Promise<void> {
  const ssid = flagStr(p, 'ssid');
  const password = flagStr(p, 'wifi-pass') ?? '';
  if (!ssid) throw new CliError('net wifi requires --ssid');

  const session = await openSession(p);
  try {
    await session.client.sendExpectAck({ oneofKind: 'wifiSet', wifiSet: { ssid, password } });
    ok(p, `wifi set: ssid=${ssid} (device reassociates; re-discover the new DHCP IP)`);
  } finally {
    dispose(session);
  }
}

async function netHa(p: ParsedArgs): Promise<void> {
  const enabled = flagBool(p, 'enabled');
  const mqttUri = flagStr(p, 'mqtt-uri') ?? '';
  if (enabled && !mqttUri) throw new CliError('net ha --enabled requires --mqtt-uri');

  const session = await openSession(p);
  try {
    await session.client.sendExpectAck({
      oneofKind: 'haSet',
      haSet: {
        enabled,
        mqttUri,
        mqttUser: flagStr(p, 'mqtt-user') ?? '',
        mqttPassword: flagStr(p, 'mqtt-pass') ?? '',
        topicPrefix: flagStr(p, 'prefix') ?? '',
      },
    });
    ok(p, `ha set: enabled=${enabled} uri=${mqttUri || '(unchanged)'}`);
  } finally {
    dispose(session);
  }
}

async function netInfo(p: ParsedArgs): Promise<void> {
  const session = await openSession(p);
  try {
    const wifi = await session.client.query<'wifi'>(Query_What.WIFI);
    const ha = await session.client.query<'haConfig'>(Query_What.HA);
    const wifiState = wifi.oneofKind === 'wifi' ? wifi.wifi : null;
    const haConfig = ha.oneofKind === 'haConfig' ? ha.haConfig : null;
    if (flagBool(p, 'json')) {
      printJson({ wifi: wifiState, ha: haConfig });
    } else {
      printLine('wifi');
      if (wifiState) printKv(Object.entries(wifiState).map(([k, v]) => [`  ${k}`, v]));
      printLine('ha');
      if (haConfig) printKv(Object.entries(haConfig).map(([k, v]) => [`  ${k}`, v]));
    }
  } finally {
    dispose(session);
  }
}

function ok(p: ParsedArgs, line: string): void {
  if (flagBool(p, 'json')) printJson({ ok: true, message: line });
  else printLine(line);
}
