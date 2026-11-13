// Copyright 2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from 'react';

import type { LocalizerType } from '../types/Util.std.ts';
import { useEscapeHandling } from '../hooks/useEscapeHandling.dom.ts';
import { tw } from '../axo/tw.dom.tsx';

export type AboutProps = Readonly<{
  closeAbout: () => unknown;
  appEnv: string;
  arch: string;
  platform: string;
  i18n: LocalizerType;
  version: string;
}>;

export function About({
  closeAbout,
  appEnv,
  arch,
  platform,
  i18n,
  version,
}: AboutProps): JSX.Element {
  useEscapeHandling(closeAbout);

  let env: string;

  if (platform === 'darwin') {
    if (arch === 'arm64') {
      env = i18n('icu:About__AppEnvironment--AppleSilicon', { appEnv });
    } else {
      env = i18n('icu:About__AppEnvironment--AppleIntel', { appEnv });
    }
  } else {
    env = i18n('icu:About__AppEnvironment', { appEnv });
  }

  return (
    <div className="About">
      <div className="module-splash-screen">
        <div className="module-splash-screen__logo module-splash-screen__logo--128" />

        {/* BACKCHANNEL: this fork's About names Backchannel and says it
            isn't Signal's (contrib/backchannel/mac/CLAUDE.md rule 8). */}
        <h1 className="About__Title">Backchannel</h1>
        <div className="About__Body">
          Based on {i18n('icu:signalDesktop')}. Not made, endorsed or supported
          by Signal Messenger.
        </div>
        <div className="About__Body">{version}</div>
        <div className="About__Body">{env}</div>
        <br />
        <div>
          <a href="https://signal.org">signal.org</a>
        </div>
        <br />
        <div>
          <a href="https://github.com/signalapp/Signal-Desktop/blob/main/ACKNOWLEDGMENTS.md">
            {i18n('icu:softwareAcknowledgments')}
          </a>
        </div>
        <div>
          <a href="https://signal.org/legal">{i18n('icu:privacyPolicy')}</a>
        </div>
        <div className={tw('text-secondary')}>
          {i18n('icu:signalNonProfit')}
        </div>
      </div>
    </div>
  );
}
