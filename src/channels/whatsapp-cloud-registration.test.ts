/**
 * Integration test for the whatsapp-cloud channel's single reach-in: the self-registration
 * import in the `src/channels/index.ts` barrel. Importing the barrel runs whatsapp-cloud.ts's
 * top-level `registerChannelAdapter('whatsapp-cloud', …)`; without the import the channel is
 * silently absent.
 *
 * Behavior, not structural: it imports the real barrel and asserts the registry
 * actually contains the channel. This reflects what happens at host boot — if the
 * `import './whatsapp-cloud.js';` line is deleted, or the barrel fails to evaluate for any
 * reason (so the channel genuinely would not register), this goes red. A structural
 * check of the import line would falsely pass in that second case.
 *
 * whatsapp-cloud is a Chat SDK channel (no network at import — the factory only builds
 * the adapter/bridge when called, at host startup). It does require the adapter package
 * (`@chat-adapter/whatsapp`) to be installed, which holds in a composed install: the
 * skill's `pnpm install` step runs before this test — so this test also implicitly
 * guards that dependency (an unmocked import throws if the package is missing).
 *
 * The `channelType: 'whatsapp-cloud'` override this adapter passes to createChatSdkBridge
 * (needed because `@chat-adapter/whatsapp` hardcodes its own name to 'whatsapp', which would
 * otherwise collide with the native Baileys adapter in the registry's activeAdapters map) is
 * covered directly in chat-sdk-bridge.test.ts, not here.
 */
import { describe, it, expect } from 'vitest';

import { getRegisteredChannelNames } from './channel-registry.js';
import './index.js'; // the real barrel — triggers every channel's self-registration

describe('whatsapp-cloud channel registration', () => {
  it('registers whatsapp-cloud via the channel barrel', () => {
    expect(getRegisteredChannelNames()).toContain('whatsapp-cloud');
  });
});
