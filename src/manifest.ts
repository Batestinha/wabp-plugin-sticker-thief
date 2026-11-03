import type { PluginManifest } from '@wabs/plugin-sdk/manifest';
import { stickerThiefConfigSchema } from './config';
import {
  STICKER_THIEF_CORE_API_RANGE,
  STICKER_THIEF_BACKFILL_JOB,
  STICKER_THIEF_DATABASE,
  STICKER_THIEF_DELIVER_JOB,
  STICKER_THIEF_DIGEST_JOB,
  STICKER_THIEF_FAVORITE_JOB,
  STICKER_THIEF_MANAGE_PERMISSION,
  STICKER_THIEF_NAMESPACE as ns,
  STICKER_THIEF_PLUGIN_ID,
  STICKER_THIEF_REIMPORT_ACTION_ID,
  STICKER_THIEF_VERSION
} from './constants';
import { stickerThiefMessages } from './messages';

export const stickerThiefCommands = [
  '/stickers subscribe',
  '/stickers unsubscribe',
  '/stickers status',
  '/stickers send',
  '/stickers random',
  '/stickers resend',
  '/stickers forget'
];

export const stickerThiefManifest: PluginManifest = {
  pluginId: STICKER_THIEF_PLUGIN_ID,
  kind: 'managed_group',
  version: STICKER_THIEF_VERSION,
  coreApiRange: STICKER_THIEF_CORE_API_RANGE,
  messageNamespace: ns,
  descriptionKey: `${ns}.description`,
  defaultMessages: stickerThiefMessages,
  commands: stickerThiefCommands,
  help: {
    featureId: 'stickers',
    titleKey: `${ns}.help.feature.title`,
    summaryKey: `${ns}.help.feature.summary`,
    order: 90,
    aliases: ['sticker', 'sticker thief'],
    topics: [
      {
        topicId: 'subscribe-stickers',
        titleKey: `${ns}.help.subscribe.title`,
        summaryKey: `${ns}.help.subscribe.summary`,
        order: 10,
        commands: ['/stickers subscribe', '/stickers unsubscribe', '/stickers status'],
        instructionKeys: [`${ns}.help.subscribe.instruction`],
        exampleKeys: [`${ns}.help.subscribe.example`],
        keywords: ['subscribe', 'digest', 'daily', 'weekly'],
        availability: { invocation: 'either', requiresCurrentManagedGroupMembership: true, currentManagedGroupMembershipMode: 'effective_scope' }
      },
      {
        topicId: 'get-stickers',
        titleKey: `${ns}.help.get.title`,
        summaryKey: `${ns}.help.get.summary`,
        order: 20,
        commands: ['/stickers send', '/stickers random', '/stickers resend'],
        instructionKeys: [`${ns}.help.get.instruction`],
        exampleKeys: [`${ns}.help.send.example`, `${ns}.help.random.example`, `${ns}.help.resend.example`],
        keywords: ['send', 'random', 'get', 'resend', 'again', 'blank'],
        availability: { invocation: 'either', requiresCurrentManagedGroupMembership: true, currentManagedGroupMembershipMode: 'effective_scope' }
      },
      {
        topicId: 'manage-stickers',
        titleKey: `${ns}.help.manage.title`,
        summaryKey: `${ns}.help.manage.summary`,
        order: 30,
        commands: ['/stickers forget'],
        instructionKeys: [`${ns}.help.manage.instruction`],
        exampleKeys: [`${ns}.help.forget.example`],
        keywords: ['forget', 'remove', 'delete'],
        availability: { invocation: 'either', permission: STICKER_THIEF_MANAGE_PERMISSION }
      }
    ]
  },
  eventSubscriptions: ['message', 'plugin.job'],
  requiredPermissions: [STICKER_THIEF_MANAGE_PERMISSION],
  requiredBotCapabilities: [],
  configSchema: stickerThiefConfigSchema,
  dangerousActions: [],
  externalActions: [{
    actionId: STICKER_THIEF_REIMPORT_ACTION_ID,
    access: 'mutation',
    scope: 'scope',
    description: 'Queue a fresh pass over the chat archive so stickers added since the last import are collected.',
    timeoutMs: 30_000
  }],
  backgroundJobs: [STICKER_THIEF_DIGEST_JOB, STICKER_THIEF_DELIVER_JOB, STICKER_THIEF_BACKFILL_JOB, STICKER_THIEF_FAVORITE_JOB],
  databases: [{ name: STICKER_THIEF_DATABASE, engine: 'sqlite', scope: 'account', migrations: 'migrations/stickers' }],
  dataVersion: '3',
  dependencies: [],
  cancellation: { workflows: [] },
  assistant: {
    summary: 'Collects stickers shared in managed groups, including those already in the chat archive, and sends them privately to members, on a subscription or on request.',
    useCases: [
      'Subscribe a member to daily or weekly private sticker digests.',
      'Send a member the stickers they have not received yet, or a random selection.',
      'Report how many stickers have been collected and what is waiting for the member.'
    ],
    prerequisites: [
      'enabled=true in the target scope.',
      'The scope must be in ASSIST or MANAGE mode for stickers to be sent.'
    ],
    limitations: [
      'Only WebP stickers are collected; Lottie stickers are skipped.',
      'Deliveries arrive as native sticker packs of up to 60 stickers (still and animated kept apart) about every 15 seconds; with packs off, 10 single stickers about every 30 seconds.',
      'Stickers outside WhatsApp pack rules are resized and recompressed by the host (512x512, at most 100 KB still or 500 KB animated); animated ones may lose some frames.',
      'Archive backfill needs WABP core API 0.3.16 and only reads stickers the chat archive still stores.',
      'Every collected sticker is added to the bot account\'s favourite stickers (WhatsApp syncs favourites, not installed packs, across an account\'s devices).',
      'Members only receive stickers collected in groups of the same scope.'
    ],
    workflows: [
      { intent: 'sticker_subscribe', description: 'Start or stop private sticker digests.', commands: ['/stickers subscribe', '/stickers unsubscribe'] },
      { intent: 'sticker_send', description: 'Send stickers to the member now.', commands: ['/stickers send', '/stickers random', '/stickers resend'] },
      { intent: 'sticker_status', description: 'Show collection size and subscription state.', commands: ['/stickers status'] }
    ]
  }
};
